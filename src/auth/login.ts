import { type BrowserContext, type Request } from "playwright";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import { launchContext, type LaunchOptions } from "./browser.js";
import { type Session, type SessionCookie, parseWcauthtoken, saveSession, withAuthLock } from "./session.js";
import { GroceriesClient } from "../client/http.js";
import { MFA_INSTRUCTIONS } from "./mfa-providers.js";
import { registerCleanup, throwIfInterrupted } from "./lifecycle.js";

export interface LoginOptions {
  config: Config;
  /** Login is always local and headed. Retained for compatibility. */
  headed?: boolean;
  persist?: boolean;
  log?: (msg: string) => void;
  /** Dependency injection for isolated tests; never supplied by CLI input. */
  launch?: (opts: LaunchOptions) => Promise<BrowserContext>;
  timeoutMs?: number;
}

const activeLogins = new Map<string, Promise<Session>>();
const ORIGIN = "https://www.sainsburys.co.uk";
class LocalLoginError extends Error {}

/** A single manual login per session path, including callers in the same process. */
export function performLogin(opts: LoginOptions): Promise<Session> {
  opts = { ...opts, config: {
    email: opts.config.email, sessionPath: resolve(opts.config.sessionPath),
    storeNumber: opts.config.storeNumber, headed: opts.config.headed,
    baseUrl: opts.config.baseUrl, loginBaseUrl: opts.config.loginBaseUrl,
  } };
  const key = `${opts.config.sessionPath}:${opts.persist !== false}`;
  const existing = activeLogins.get(key);
  if (existing) {
    // A competing account must never inherit another account's login promise.
    return existing.then((session) => {
      if (session.accountEmail !== opts.config.email.trim().toLowerCase()) throw new Error("Another account login is in progress.");
      return session;
    });
  }
  const work = login(opts).finally(() => activeLogins.delete(key));
  activeLogins.set(key, work);
  return work;
}

async function login(opts: LoginOptions): Promise<Session> {
  const { config, log = () => {} } = opts;
  const email = config.email.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Set SAINSBURYS_EMAIL to the account you will log into; no password is required in configuration.");
  }
  if (config.baseUrl !== ORIGIN) throw new Error("Login is restricted to the Sainsbury's HTTPS origin.");
  const run = async () => {
    const session = await captureLogin(opts, email, log);
    throwIfInterrupted();
    if (opts.persist !== false) await saveSession(config.sessionPath, session);
    return session;
  };
  return opts.persist === false ? run() : withAuthLock(`${config.sessionPath}.profile.lock`, run);
}

async function captureLogin(opts: LoginOptions, email: string, log: (msg: string) => void): Promise<Session> {
  const { config } = opts;
  const context = await (opts.launch ?? launchContext)({
    sessionPath: config.sessionPath, accountEmail: email, headless: false, persist: opts.persist,
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= context.close();
  const unregister = registerCleanup(close);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    throwIfInterrupted();
    const page = await context.newPage();
    let wcauthtoken: string | undefined;
    let bearerToken: string | undefined;
    let resolveTokens!: () => void;
    const tokens = new Promise<void>((resolve) => { resolveTokens = resolve; });
    const onRequest = (req: Request) => {
      let url: URL;
      try { url = new URL(req.url()); } catch { return; }
      if (url.origin !== ORIGIN || !url.pathname.startsWith("/groceries-api/")) return;
      const headers = req.headers();
      const wc = headers["wcauthtoken"];
      const auth = headers["authorization"];
      if (wc && wc !== '\"\"') {
        try { parseWcauthtoken(wc); wcauthtoken = wc; } catch { /* ignore guest token */ }
      }
      if (auth?.toLowerCase().startsWith("bearer ") && auth.slice(7).trim()) bearerToken = auth.slice(7).trim();
      if (wcauthtoken && bearerToken) resolveTokens();
    };
    page.on("request", onRequest);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalLoginError("Local login timed out. Complete login and MFA in the browser, then retry auth login.")), opts.timeoutMs ?? 300_000);
    });
    log(MFA_INSTRUCTIONS);
    try {
      await Promise.race([
        (async () => {
          await page.goto(`${ORIGIN}/gol-ui/my-account/orders`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          if (!wcauthtoken || !bearerToken) {
            // Reused profiles can serve a cached account page with no API bootstrap.
            // Wait for the user's login redirect, then visit the trolley to capture a
            // fresh authenticated request. Never navigate away while MFA is being entered.
            await page.waitForURL((url) => url.origin === ORIGIN && url.pathname.startsWith("/gol-ui/"), {
              timeout: opts.timeoutMs ?? 300_000,
            });
            await page.goto(`${ORIGIN}/gol-ui/trolley`, { waitUntil: "domcontentloaded", timeout: 30_000 });
          }
          await tokens;
        })(),
        deadline,
      ]);
      if (!wcauthtoken || !bearerToken) throw new LocalLoginError("Login did not capture authenticated API credentials.");
      const cookies = (await context.cookies()).filter((c) => {
        const domain = c.domain.replace(/^\./, "");
        return domain === "sainsburys.co.uk" || domain.endsWith(".sainsburys.co.uk");
      });
      const sessionCookies: SessionCookie[] = cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        expires: c.expires === -1 ? undefined : c.expires,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      }));
      const session: Session = {
        cookies: sessionCookies, wcauthtoken, bearerToken,
        userId: parseWcauthtoken(wcauthtoken).userId,
        capturedAt: Date.now(),
        userAgent: await page.evaluate(() => navigator.userAgent),
      };
      // Perform an authenticated read using browser transport. This verifies the account
      // before exporting credentials or accepting an already-authenticated profile.
      const client = new GroceriesClient({
        session, baseUrl: ORIGIN,
        fetchImpl: async (input, init) => {
          const result = await context.request.get(String(input), {
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            maxRedirects: 0, timeout: 15_000,
          });
          return new Response(await result.body(), { status: result.status(), headers: result.headers() });
        },
      });
      const result: unknown = await client.request("/groceries-api/gol-services/customer/v1/customer/profile");
      const profile = identityProfile(result);
      if (String(profile.user_id) !== session.userId || profile.email.trim().toLowerCase() !== email) {
        throw new LocalLoginError("Authenticated browser account does not match SAINSBURYS_EMAIL. Log out in the local browser and retry with the intended account.");
      }
      session.accountEmail = email;
      log("Account identity verified; local login complete.");
      return session;
    } finally {
      page.off("request", onRequest);
    }
  } catch (err) {
    if (err instanceof LocalLoginError) throw err;
    throw new LocalLoginError("Local browser login failed. Check the browser window and retry auth login; credentials were not persisted.");
  } finally {
    if (timer) clearTimeout(timer);
    // Browser errors can include URLs and page contents. Do not expose those details.
    try {
      await close().catch(() => {
        throw new LocalLoginError("Could not close the login browser or clean its temporary profile. Close it locally and inspect private authentication storage before retrying.");
      });
    } finally { unregister(); }
  }
}

function identityProfile(value: unknown): { user_id: string | number; email: string } {
  if (!value || typeof value !== "object") throw new LocalLoginError("Customer identity response is invalid.");
  const outer = value as Record<string, unknown>;
  const profile = outer.customer && typeof outer.customer === "object"
    ? outer.customer as Record<string, unknown> : outer;
  const email = profile.email ?? profile.email_address;
  if ((typeof profile.user_id !== "string" && typeof profile.user_id !== "number") ||
      typeof email !== "string" || !email) {
    throw new LocalLoginError("Customer response did not provide a verifiable user ID and email. Login was not persisted.");
  }
  return { user_id: profile.user_id, email };
}
