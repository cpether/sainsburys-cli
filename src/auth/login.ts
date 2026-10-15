import { errors, type BrowserContext, type Request } from "playwright";
import { resolve } from "node:path";
import type { Config } from "../config.js";
import { launchContext, type LaunchOptions } from "./browser.js";
import { type Session, type SessionCookie, parseWcauthtoken, saveSession, withAuthLock } from "./session.js";
import { ApiError, AuthError, GroceriesClient, RequestTimeoutError, ResponseValidationError } from "../client/http.js";
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
class LocalLoginError extends Error {
  constructor(message: string) { super(message); this.name = "LocalLoginError"; }
}

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
  let stage = "opening the browser page";
  let verificationFailure: string | undefined;
  try {
    throwIfInterrupted();
    const page = await context.newPage();
    // Read browser metadata on about:blank, before login redirects can destroy
    // the execution context. Credential capture need not wait for document load.
    const userAgent = await page.evaluate(() => navigator.userAgent);
    let wcauthtoken: string | undefined;
    let bearerToken: string | undefined;
    let resolveTokens!: () => void;
    let rejectTokens!: (error: Error) => void;
    const tokens = new Promise<void>((resolve, reject) => { resolveTokens = resolve; rejectTokens = reject; });
    const onClosed = () => rejectTokens(new LocalLoginError("Login browser closed before authenticated credentials were captured. Retry auth login."));
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
    page.on("close", onClosed);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LocalLoginError("Local login timed out. Complete login and MFA in the browser, then retry auth login.")), opts.timeoutMs ?? 300_000);
    });
    log(MFA_INSTRUCTIONS);
    try {
      await Promise.race([
        (async () => {
          stage = "opening the account page";
          const navigation = page.goto(`${ORIGIN}/gol-ui/my-account/orders`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error: unknown) => {
            // Login/MFA and SPA redirects need not complete within a document-load
            // deadline. The credential event and identity read determine success.
            if (!(error instanceof errors.TimeoutError)) throw error;
          });
          await Promise.race([navigation, tokens]);
          stage = "waiting for authenticated API credentials";
          if (!wcauthtoken || !bearerToken) {
            // A /gol-ui/ URL can appear before the SPA starts its login redirect.
            // Never force another navigation while the user may be entering MFA.
            log("After completing login and MFA, open Trolley in this browser window if the terminal is still waiting.");
          }
          await tokens;
        })(),
        deadline,
      ]);
      if (!wcauthtoken || !bearerToken) throw new LocalLoginError("Login did not capture authenticated API credentials.");
      log("Authenticated API credentials captured; verifying account identity.");
      stage = "reading browser session state";
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
        userAgent,
      };
      // Perform an authenticated read using browser transport. This verifies the account
      // before exporting credentials or accepting an already-authenticated profile.
      const client = new GroceriesClient({
        session, baseUrl: ORIGIN,
        fetchImpl: async (input, init) => {
          let result;
          try {
            result = await context.request.get(String(input), {
              headers: Object.fromEntries(new Headers(init?.headers).entries()),
              maxRedirects: 0, timeout: 15_000,
            });
          } catch (error) {
            // The shared client intentionally masks raw fetch errors. Preserve
            // only a fixed category before it does so, never the browser call log.
            verificationFailure = browserTransportFailure(error);
            throw new Error("Browser verification transport failed.");
          }
          let body;
          try { body = await result.body(); }
          catch {
            verificationFailure = "browser verification response could not be read";
            throw new Error("Browser verification response failed.");
          }
          try {
            const status = result.status();
            return new Response([204, 205, 304].includes(status) ? null : body, { status, headers: result.headers() });
          } catch {
            verificationFailure = "browser verification response could not be adapted";
            throw new Error("Browser verification response failed.");
          }
        },
      });
      stage = "account verification";
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
      page.off("close", onClosed);
    }
  } catch (err) {
    if (err instanceof LocalLoginError) throw err;
    // Classify only errors with known, sanitized semantics. Never include raw
    // Playwright messages, URLs, response bodies or authentication headers.
    let detail = `failed during ${stage}`;
    if (stage === "account verification") {
      if (err instanceof AuthError) detail = `failed during account verification: retailer rejected the read (HTTP ${err.status})`;
      else if (err instanceof ResponseValidationError) detail = `failed during account verification: ${err.message}`;
      else if (err instanceof ApiError) detail = `failed during account verification: ${err.status ? `HTTP ${err.status}` : verificationFailure ?? "network or browser transport failure"}`;
      else if (err instanceof RequestTimeoutError) detail = "failed during account verification: the read exceeded its 15-second deadline";
    }
    throw new LocalLoginError(`Local browser login ${detail}. Session credentials were not saved. Retry auth login; share only this sanitized error if it fails again.`);
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

/** Inspect only the failure summary, excluding Playwright's token-bearing call log. */
function browserTransportFailure(error: unknown): string {
  if (error instanceof errors.TimeoutError) return "browser verification request timed out";
  const summary = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] ?? "" : "";
  const categories: Array<[RegExp, string]> = [
    [/ECONNRESET|socket hang up|connection reset|ERR_CONNECTION_RESET/i, "connection reset before a response"],
    [/certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID/i, "TLS certificate verification failed; check local network trust and Node certificate configuration"],
    [/ENOTFOUND|EAI_AGAIN/i, "DNS lookup failed"],
    [/ECONNREFUSED/i, "connection refused"],
    [/ETIMEDOUT|timed out/i, "browser verification request timed out"],
    [/ENETUNREACH|EHOSTUNREACH/i, "network unreachable"],
    [/ERR_INVALID_CHAR|Invalid character in header/i, "browser verification request headers were rejected locally"],
    [/ERR_HTTP2_PROTOCOL_ERROR|HPE_[A-Z_]+/i, "HTTP protocol failure"],
    [/Target .* has been closed/i, "login browser closed during account verification"],
  ];
  return categories.find(([pattern]) => pattern.test(summary))?.[1] ?? "browser verification request failed (unclassified transport error)";
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
