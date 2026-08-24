import { type Page, type Request } from "playwright";
import type { Config } from "../config.js";
import { launchContext } from "./browser.js";
import {
  type Session,
  type SessionCookie,
  parseWcauthtoken,
  saveSession,
} from "./session.js";
import { defaultMfaProvider, type MfaCodeProvider } from "./mfa-providers.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export interface LoginOptions {
  config: Config;
  /** Force headed browser even if config.headed is false. Useful for debugging. */
  headed?: boolean;
  /** Persist session to disk after capture. Default true. */
  persist?: boolean;
  /** Logger for progress output. Default no-op. */
  log?: (msg: string) => void;
  /**
   * Asked to provide an SMS MFA code when the form appears, given the moment the form
   * was submitted (so the provider can ignore stale codes). Default: con chat polling
   * if `config.mfaChatRoomId` is set, otherwise stdin prompt.
   */
  mfaCodeProvider?: MfaCodeProvider;
}

/**
 * Drive a Chromium browser through Sainsbury's full OAuth login.
 * Captures session cookies + the wcauthtoken HMAC by intercepting outgoing
 * /groceries-api/ requests after redirect back to the SPA.
 */
export async function performLogin(opts: LoginOptions): Promise<Session> {
  const { config, log = () => {} } = opts;
  const headless = !(opts.headed ?? config.headed);
  log(`launching chromium (headless=${headless})`);
  // Persistent context keeps Akamai's _abck cookie + ThreatMetrix device fingerprint
  // across runs, which dramatically reduces the chance of being challenged on subsequent
  // headless logins.
  const context = await launchContext({ sessionPath: config.sessionPath, headless });
  try {
    const page = await context.newPage();

    // We need both `wcauthtoken` (WCS session HMAC, on every request) AND
    // `authorization: Bearer <Hydra-JWT>` (sent on essentially every /groceries-api/ call,
    // and mandatory for writes — basket POST/PUT etc. return 401 without it).
    let capturedWc: string | undefined;
    let capturedBearer: string | undefined;
    const wcPromise = new Promise<string>((resolve) => {
      const onRequest = (req: Request) => {
        if (capturedWc) return;
        const url = req.url();
        if (!url.includes("/groceries-api/")) return;
        const token = req.headers()["wcauthtoken"];
        if (token && token.length > 0 && token !== '""') {
          capturedWc = token;
          resolve(token);
        }
      };
      page.on("request", onRequest);
    });
    const bearerPromise = new Promise<string>((resolve) => {
      const onRequest = (req: Request) => {
        if (capturedBearer) return;
        const url = req.url();
        if (!url.includes("/groceries-api/")) return;
        const auth = req.headers()["authorization"];
        if (auth && auth.toLowerCase().startsWith("bearer ")) {
          capturedBearer = auth.slice(7).trim();
          resolve(capturedBearer);
        }
      };
      page.on("request", onRequest);
    });

    log("navigating to login");
    await page.goto(`${config.baseUrl}/gol-ui/groceries`, { waitUntil: "domcontentloaded" });

    await dismissCookieBanner(page, log);

    await page.goto(`${config.baseUrl}/gol-ui/my-account/orders`, { waitUntil: "domcontentloaded" });

    // After domcontentloaded the SPA may still client-side-redirect to Hydra (e.g.
    // because the cached cookies expired). Wait for network to go idle so any
    // post-load redirect settles before we decide whether to fill the login form.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const alreadyAuthed =
      /\/gol-ui\/my-account\//.test(page.url()) &&
      !/account\.sainsburys\.co\.uk/.test(page.url());
    if (alreadyAuthed) {
      log("persistent context is already authenticated — skipping login form");
    } else {
      log("waiting for hydra login form");
      await page.waitForURL(/account\.sainsburys\.co\.uk\/gol\/login/, { timeout: 30_000 });

      await dismissCookieBanner(page, log);

      log("filling credentials");
      await page.fill('input[name="username"]', config.email);
      await page.fill('input[name="password"]', config.password);

      // Give Hydra's JS a moment to compute ioBlackBox before submitting.
      await page.waitForTimeout(500);

      log("submitting login form");
      const submittedAt = Date.now();
      await page.click('button[data-testid="log-in"], button[type="submit"]');

      const mfaProvider =
        opts.mfaCodeProvider ??
        defaultMfaProvider({
          conBin: config.conBin,
          mfaChatRoomId: config.mfaChatRoomId,
          log,
        });
      await waitForLoggedIn(page, log, mfaProvider, submittedAt);
    }

    log("logged in; waiting for wcauthtoken + bearer JWT");
    // The SPA bootstraps after login by hitting several /groceries-api/ endpoints; our
    // listeners will catch the first one carrying each header. If we land on a page that
    // doesn't trigger bootstrap (e.g. it's served from cache because the persistent context
    // already had it), force-navigate to a different page that always fires API calls.
    // Cache-bust query param ensures the navigation isn't a no-op.
    const navTimeout = setTimeout(() => {
      const bust = Date.now();
      page
        .goto(`${config.baseUrl}/gol-ui/trolley?_=${bust}`, { waitUntil: "domcontentloaded" })
        .catch(() => {});
    }, 3_000);

    const timeout = (ms: number, label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
      );
    let wcauthtoken: string;
    let bearerToken: string;
    try {
      [wcauthtoken, bearerToken] = await Promise.all([
        Promise.race([wcPromise, timeout(45_000, "wcauthtoken")]),
        Promise.race([bearerPromise, timeout(45_000, "bearer JWT")]),
      ]);
    } catch (err) {
      const snap = `/tmp/sainsburys-login-timeout-${Date.now()}.png`;
      await page.screenshot({ path: snap, fullPage: true }).catch(() => {});
      log(`token capture failed; screenshot at ${snap}, url=${page.url()}`);
      throw err;
    } finally {
      clearTimeout(navTimeout);
    }

    const cookies = (await context.cookies()).filter((c) =>
      c.domain.endsWith("sainsburys.co.uk"),
    );

    const sessionCookies: SessionCookie[] = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      expires: c.expires === -1 ? undefined : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite:
        c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None"
          ? c.sameSite
          : undefined,
    }));

    const { userId } = parseWcauthtoken(wcauthtoken);

    const session: Session = {
      cookies: sessionCookies,
      wcauthtoken,
      bearerToken,
      userId,
      storeNumber: config.storeNumber,
      capturedAt: Date.now(),
      userAgent: DEFAULT_USER_AGENT,
    };

    if (opts.persist !== false) {
      await saveSession(config.sessionPath, session);
      log(`session saved to ${config.sessionPath}`);
    }

    return session;
  } finally {
    await context.close().catch(() => {});
  }
}

async function waitForLoggedIn(
  page: Page,
  log: (msg: string) => void,
  mfaCodeProvider: MfaCodeProvider,
  submittedAt: number,
): Promise<void> {
  const goluiRe = /www\.sainsburys\.co\.uk\/gol-ui\//;
  const mfaRe = /account\.sainsburys\.co\.uk\/gol\/login\/mfa/;

  try {
    await page.waitForURL((url) => goluiRe.test(url.toString()) || mfaRe.test(url.toString()), {
      timeout: 60_000,
    });
  } catch {
    await snapAndThrow(page, "after login submit");
  }

  if (mfaRe.test(page.url())) {
    log("MFA required");
    const code = await mfaCodeProvider(submittedAt);
    if (!/^\d{4,8}$/.test(code)) throw new Error(`invalid MFA code (expected digits): ${code}`);

    const codeInput = page
      .locator('input[type="tel"], input[inputmode="numeric"], input[name*="code" i]')
      .first();
    await codeInput.fill(code);
    await page.click('button[type="submit"], button:has-text("Continue")');

    try {
      await page.waitForURL(goluiRe, { timeout: 60_000 });
    } catch {
      await snapAndThrow(page, "after MFA submit");
    }
  }
}

async function snapAndThrow(page: Page, where: string): Promise<never> {
  const here = page.url();
  const visibleErr = await page
    .locator('[role="alert"], .ln-c-form-group__error-message, .ln-c-message')
    .first()
    .innerText()
    .catch(() => "");
  const screenshotPath = `/tmp/sainsburys-login-fail-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  throw new Error(
    `login failed ${where}. URL: ${here}. visible error: ${visibleErr || "(none)"}. screenshot: ${screenshotPath}`,
  );
}

async function dismissCookieBanner(page: Page, log: (msg: string) => void): Promise<void> {
  // OneTrust uses #onetrust-accept-btn-handler; Sainsbury's also has plain "Accept all" buttons.
  const selectors = [
    "#onetrust-accept-btn-handler",
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
  ];
  for (const sel of selectors) {
    try {
      const button = page.locator(sel).first();
      await button.waitFor({ timeout: 3_000, state: "visible" });
      await button.click({ timeout: 2_000 });
      log(`dismissed cookie banner (${sel})`);
      // OneTrust fades out an overlay after click; wait for it to clear.
      await page
        .locator(".onetrust-pc-dark-filter")
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
      return;
    } catch {
      /* try next selector */
    }
  }
}
