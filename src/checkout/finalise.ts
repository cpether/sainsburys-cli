import type { BrowserContext, Page } from "playwright";
import { launchContext } from "../auth/browser.js";
import { loadSession, type SessionCookie } from "../auth/session.js";
import type { Config } from "../config.js";

export interface FinaliseOptions {
  config: Config;
  /** If false, pause before the final "Place order" click and require an explicit confirmation. Default true. */
  autoConfirm?: boolean;
  /** Show the browser. Default true — placing a real order should be observable. */
  headed?: boolean;
  /** Overall timeout in ms. Default 180_000. */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Called when we're about to click "Place order" and `autoConfirm` is false. Resolve true to proceed, false to abort. */
  confirmPlaceOrder?: () => Promise<boolean>;
  /**
   * Coupon codes that aren't yet applied to the cart — we navigate to the coupon
   * page mid-flow and click the SPA's Apply anchor for each. Codes that aren't
   * listed on the page are skipped silently (e.g. already applied via a previous run).
   */
  couponCodesToApply?: string[];
}

export interface FinaliseResult {
  order_id?: string;
  /** Last URL the browser landed on — for diagnostics. */
  endUrl: string;
  /** Screenshot path on failure. */
  screenshot?: string;
}

const TROLLEY_URL = (base: string) => `${base}/gol-ui/trolley`;
const CONFIRMATION_URL_RE = /\/gol-ui\/(order\/confirmation|checkout\/confirmation|order-confirmation)/;

// Defensive selector lists — Sainsbury's React/Luna components occasionally rename.
// Order matters: more specific first. Verified live 2026-05-25 on the Trolley page.
// Watch out for the `skip-to-cta-link` a11y skip-link — its text is "Skip to place order"
// which substring-matches "Place order" and trips up loose selectors.
const SKIP_CTA = ':not([data-testid="skip-to-cta-link"])';
const CONTINUE_SELECTORS = [
  'button[data-testid="checkout-button"]', // Trolley → checkout
  'button[data-testid="continue-to-payment"]',
  'button[data-testid="checkout-continue"]',
  `button${SKIP_CTA}:has-text("Continue to payment")`,
  `button${SKIP_CTA}:has-text("Continue to checkout")`,
];
const PLACE_ORDER_SELECTORS = [
  // Same testid for both flows; text varies: "Place order" (new), "Update order" (amend).
  'button[data-testid="place-order-button"]',
  'button[data-testid="place-order"]',
  'button[data-testid="pay-now"]',
  `button${SKIP_CTA}:has-text("Place order")`,
  `button${SKIP_CTA}:has-text("Update order")`,
  `button${SKIP_CTA}:has-text("Pay now")`,
  `button${SKIP_CTA}:has-text("Confirm order")`,
];

/**
 * Drive the SPA through the checkout pages and place the order.
 *
 * Approach: rather than reverse-engineer the multi-step payment iframe flow (3DS,
 * ephapay-hosted page, sessionId callback), we just open the SPA in a real browser
 * that has the user's session cookies, click the same buttons the user would click,
 * and observe the eventual /payment/process response (which carries the order_id).
 */
export async function finaliseCheckout(opts: FinaliseOptions): Promise<FinaliseResult> {
  const { config, log = () => {} } = opts;
  const headless = !(opts.headed ?? true);
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const autoConfirm = opts.autoConfirm ?? false;

  log(`launching chromium (headless=${headless})`);
  const context = await launchContext({ sessionPath: config.sessionPath, headless });
  try {
    await hydrateCookies(context, config.sessionPath, log);
    const page = await context.newPage();

    // Watch /payment/process responses — that's where the order_id materialises.
    let orderId: string | undefined;
    page.on("response", async (res) => {
      if (orderId) return;
      const url = res.url();
      if (!url.includes("/checkout/v1/checkout/payment/process")) return;
      try {
        const body = await res.json();
        const id = body?.order_id ?? body?.orderId;
        if (id) {
          orderId = String(id);
          log(`captured order_id=${orderId} from /payment/process`);
        }
      } catch {
        /* not JSON or already drained — ignore */
      }
    });

    log(`navigating to ${TROLLEY_URL(config.baseUrl)}`);
    await page.goto(TROLLEY_URL(config.baseUrl), { waitUntil: "domcontentloaded" });

    await dismissCookieBanner(page, log);

    // Apply any pending coupons BEFORE the checkout flow advances — easier than
    // trying to detour mid-flow once we're already on /checkout/summary.
    if (opts.couponCodesToApply && opts.couponCodesToApply.length > 0) {
      await applyCouponsViaSpa(page, opts.couponCodesToApply, config.baseUrl, log);
    }

    // Step through any "Continue" buttons until we land on a page with a "Place order" button.
    const startedAt = Date.now();
    let placedOrder = false;
    while (Date.now() - startedAt < timeoutMs) {
      if (CONFIRMATION_URL_RE.test(page.url())) {
        log(`reached confirmation URL: ${page.url()}`);
        break;
      }
      const placeOrder = await firstVisible(page, PLACE_ORDER_SELECTORS, 1_500);
      if (placeOrder) {
        if (!autoConfirm) {
          log(`pausing before final 'Place order' click — awaiting confirmation`);
          const ok = await (opts.confirmPlaceOrder ?? defaultConfirm)();
          if (!ok) {
            log("aborted before placing order");
            return { endUrl: page.url() };
          }
        }
        log("clicking Place order");
        await placeOrder.scrollIntoViewIfNeeded().catch(() => {});
        await placeOrder.click({ force: true, timeout: 10_000 });
        placedOrder = true;
        // After clicking, the SPA loads the ephapay iframe and (for trusted txns)
        // auto-redirects to /gol-ui/checkout/payment/redirect?sessionId=… which then
        // calls /payment/process. We just wait for the order_id to surface.
        await waitForOrderId(page, () => orderId, timeoutMs - (Date.now() - startedAt));
        break;
      }
      const cont = await firstVisible(page, CONTINUE_SELECTORS, 2_000);
      if (cont) {
        const label = (await cont.textContent())?.trim() ?? "?";
        log(`clicking continue button: ${label}`);
        await cont.scrollIntoViewIfNeeded().catch(() => {});
        // force: true bypasses Playwright's actionability check, which gets confused
        // by Sainsbury's sticky sidebar (button is technically off-viewport).
        await cont.click({ force: true, timeout: 10_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        continue;
      }
      // Nothing actionable visible — wait a bit and re-poll, in case the SPA is mid-render.
      await page.waitForTimeout(1_000);
    }

    if (!orderId) {
      // Any failure path: snap a screenshot + dump button text so we can diagnose
      // which selectors matched (or didn't).
      const screenshot = `/tmp/sainsburys-checkout-${Date.now()}.png`;
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
      const buttonsHtml = `/tmp/sainsburys-checkout-${Date.now()}-buttons.json`;
      const buttons = await page
        .locator("button:visible")
        .evaluateAll((els) =>
          els.map((b) => {
            const btn = b as unknown as { textContent: string | null; getAttribute: (n: string) => string | null; disabled: boolean };
            return {
              text: (btn.textContent ?? "").trim().slice(0, 80),
              testid: btn.getAttribute("data-testid"),
              aria: btn.getAttribute("aria-label"),
              disabled: btn.disabled,
            };
          }),
        )
        .catch(() => [] as unknown[]);
      const fs = await import("node:fs/promises");
      await fs.writeFile(buttonsHtml, JSON.stringify(buttons, null, 2));
      return { endUrl: page.url(), screenshot };
    }

    return { order_id: orderId, endUrl: page.url() };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Apply coupons to the cart by navigating to the legacy WCS voucher page in the
 * same browser session and clicking the SPA anchors `a#walletVoucher<CODE>` —
 * this is the only path Akamai accepts (direct HTTP calls to /shop/PromotionCodeManage
 * get rejected by the bot-check).
 */
async function applyCouponsViaSpa(
  page: Page,
  codes: string[],
  baseUrl: string,
  log: (msg: string) => void,
): Promise<void> {
  const VOUCHER_URL = `${baseUrl}/webapp/wcs/stores/servlet/EnclosedVoucherView?langId=44&storeId=10151`;
  log(`navigating to coupon page to apply ${codes.length} code(s): ${codes.join(", ")}`);
  await page.goto(VOUCHER_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  const stillUnapplied: string[] = [];
  for (const code of codes) {
    const link = page.locator(`a#walletVoucher${code}`).first();
    try {
      await link.waitFor({ state: "visible", timeout: 5_000 });
      const text = (await link.textContent())?.toLowerCase() ?? "";
      if (text.includes("remove")) {
        log(`  coupon ${code} already applied`);
        continue;
      }
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await link.click({ force: true, timeout: 5_000 });
      log(`  applied ${code}`);
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(800);
      // Verify by re-querying the link's text
      const after = (await link.textContent())?.toLowerCase() ?? "";
      if (!after.includes("remove")) {
        log(`  WARN: ${code} click didn't transition to 'Remove' state`);
        stillUnapplied.push(code);
      }
    } catch {
      log(`  WARN: coupon ${code} not visible on voucher page — skipping`);
      stillUnapplied.push(code);
    }
  }

  if (stillUnapplied.length > 0) {
    throw new Error(
      `couldn't apply ${stillUnapplied.length} coupon(s): ${stillUnapplied.join(", ")}. Refusing to checkout. Apply manually via the website or remove from the account.`,
    );
  }

  // Navigate back to the SPA flow so the rest of the checkout loop has something to do.
  log(`coupons applied; returning to trolley`);
  await page.goto(`${baseUrl}/gol-ui/trolley`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
}

async function hydrateCookies(
  context: BrowserContext,
  sessionPath: string,
  log: (msg: string) => void,
): Promise<void> {
  const session = await loadSession(sessionPath);
  if (!session) {
    log("no session.json — relying on persistent context's existing cookies");
    return;
  }
  // Playwright's addCookies wants the same shape we store, near-enough.
  const playwrightCookies = session.cookies.map((c: SessionCookie) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
  await context.addCookies(playwrightCookies as Parameters<BrowserContext["addCookies"]>[0]);
  log(`hydrated ${playwrightCookies.length} cookies from session.json`);
}

async function firstVisible(page: Page, selectors: string[], waitMs: number) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state: "visible", timeout: waitMs });
      return loc;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

async function waitForOrderId(
  page: Page,
  getId: () => string | undefined,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getId()) return;
    if (CONFIRMATION_URL_RE.test(page.url())) return;
    await page.waitForTimeout(500);
  }
}

async function dismissCookieBanner(page: Page, log: (msg: string) => void): Promise<void> {
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
      await page
        .locator(".onetrust-pc-dark-filter")
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
      return;
    } catch {
      /* try next */
    }
  }
}

async function defaultConfirm(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("Place order? (yes/no) ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
