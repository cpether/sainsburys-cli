import { Command } from "commander";
import { getBasket } from "../../api/basket.js";
import type { Basket } from "../../api/types.js";
import { listCoupons } from "../../api/coupon.js";
import { finaliseCheckout } from "../../checkout/finalise.js";
import { loadConfig } from "../../config.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError } from "../output.js";

export function checkoutCommand(): Command {
  const cmd = new Command("checkout")
    .description("Place the active basket (drives the SPA checkout in a real browser).")
    .option("--yes", "Skip the 'Place order?' prompt and auto-confirm (use with care).", false)
    .option("--headless", "Run the browser headless. Default: headed, so you can watch.", false)
    .option(
      "--slot-booked",
      "Pass slot_booked=true when reading the basket for the pre-flight check.",
      false,
    )
    .action(
      async (
        opts: { yes: boolean; headless: boolean; slotBooked: boolean },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          const config = loadConfig();
          const log = (msg: string) => process.stderr.write(`# ${msg}\n`);

          // Pre-flight: confirm the basket actually has items and meets minimum spend.
          const basket = await getBasket(c.client, {
            storeNumber: c.storeNumber,
            slotBooked: opts.slotBooked,
          });
          if (basket.item_count === 0) {
            throw new Error("basket is empty; nothing to check out");
          }
          // Minimum spend applies to the items-only subtotal (excluding delivery charge),
          // NOT the total_price. The website disables the Checkout button when subtotal
          // < minimum_spend — gate on the same field here to fail fast with a clear error.
          const subtotal = (basket as Basket & { subtotal_price?: number }).subtotal_price ?? basket.total_price;
          if (subtotal < basket.minimum_spend) {
            throw new Error(
              `basket subtotal ${formatMoney(subtotal)} is below minimum ${formatMoney(basket.minimum_spend)} (delivery charge doesn't count). Add £${(basket.minimum_spend - subtotal).toFixed(2)} more.`,
            );
          }

          log(
            `basket ${basket.basket_id}: ${basket.item_count} items, total ${formatMoney(basket.total_price)} (min ${formatMoney(basket.minimum_spend)})`,
          );

          // Collect any unapplied account coupons (substitution refunds etc.) so the
          // Playwright checkout flow can apply them inside the SPA before placing the
          // order. The legacy WCS apply endpoint can't be called directly (Akamai bot-
          // check rejects it), so it has to happen inside the real browser session.
          const couponRes = await listCoupons(c.client).catch(() => ({ coupons: [] }));
          const coupons = couponRes.coupons ?? [];
          let codesToApply: string[] = [];
          if (coupons.length === 0) {
            log("no stored coupons on account");
          } else {
            log(`${coupons.length} stored coupon(s):`);
            for (const cp of coupons) {
              log(
                `  code=${cp.code}  value=£${cp.promotion.value.toFixed(2)}  applied=${cp.promotion.is_already_applied_to_cart}  "${cp.promotion.description}"`,
              );
            }
            codesToApply = coupons
              .filter((cp) => !cp.promotion.is_already_applied_to_cart)
              .map((cp) => cp.code);
            if (codesToApply.length > 0) {
              log(`will auto-apply ${codesToApply.length} coupon(s) in the browser flow: ${codesToApply.join(", ")}`);
            }
          }

          const result = await finaliseCheckout({
            config,
            autoConfirm: opts.yes,
            headed: !opts.headless,
            couponCodesToApply: codesToApply,
            log,
          });

          if (result.order_id) {
            printData(
              c,
              { ok: true, order_id: result.order_id, end_url: result.endUrl },
              () => `Order placed: ${result.order_id}\n  end URL: ${result.endUrl}`,
            );
          } else {
            printData(
              c,
              { ok: false, end_url: result.endUrl, screenshot: result.screenshot },
              () =>
                `Checkout did not produce an order_id. ` +
                `End URL: ${result.endUrl}` +
                (result.screenshot ? `\nScreenshot: ${result.screenshot}` : ""),
            );
            process.exit(3);
          }
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  return cmd;
}
