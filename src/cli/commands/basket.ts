import { Command } from "commander";
import {
  addItem,
  findItemBySku,
  findItemBySkuViaLookup,
  getBasket,
  removeItem,
  updateItems,
  type BasketContext,
} from "../../api/basket.js";
import type { Basket } from "../../api/types.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError } from "../output.js";

function ctx(storeNumber: string, slotBooked: boolean): BasketContext {
  return { storeNumber, slotBooked };
}

function renderBasket(b: Basket): string {
  // Basket items expose the numeric SKU only under product.sku; the top-level
  // identifier is the 8-char sain_id. Line price is subtotal_price, not sub_total.
  const sub = b.subtotal_price ?? b.total_price;
  const head = `Basket ${b.basket_id || "(empty)"}  items=${b.item_count}  subtotal=${formatMoney(sub)}  total=${formatMoney(b.total_price)}  savings=${formatMoney(b.savings)}  min=${formatMoney(b.minimum_spend)}${
    sub < b.minimum_spend ? ` [BELOW MINIMUM by ${formatMoney(b.minimum_spend - sub)}]` : ""
  }${b.is_in_amend_mode ? "  [amend mode]" : ""}`;
  const lines = (b.items ?? []).map((i) => {
    const sku = String(i.product?.sku ?? i.sain_id ?? "?").padEnd(8);
    const qty = String(i.quantity ?? "?").padStart(3);
    const uom = String(i.uom ?? "").padEnd(2);
    const price = formatMoney(i.subtotal_price ?? i.sub_total).padStart(7);
    return `  ${sku} qty=${qty} ${uom} ${price}  ${i.product?.name ?? ""}`;
  });
  return [head, ...lines].join("\n");
}

export function basketCommand(): Command {
  const cmd = new Command("basket").description("Inspect and modify the active basket");

  cmd
    .command("show")
    .description("Show the active basket (or the order's basket if in amend mode)")
    .option("--slot-booked", "Pass slot_booked=true (use when an order is being amended)")
    .action(async (opts: { slotBooked?: boolean }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const basket = await getBasket(c.client, ctx(c.storeNumber, !!opts.slotBooked));
        printData(c, basket, () => renderBasket(basket));
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("add <sku>")
    .description("Add a product to the basket by SKU (product_uid)")
    .option("-q, --qty <n>", "Quantity (default 1)", (v) => Number(v), 1)
    .option("--uom <uom>", "Unit of measure (ea|kg|...)", "ea")
    .option("--catchweight <value>", "Catchweight selection (loose meat, etc.)", "")
    .option("--slot-booked", "Pass slot_booked=true")
    .action(
      async (
        sku: string,
        opts: { qty: number; uom: string; catchweight: string; slotBooked?: boolean },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          await addItem(c.client, ctx(c.storeNumber, !!opts.slotBooked), {
            productUid: sku,
            quantity: opts.qty,
            uom: opts.uom,
            selectedCatchweight: opts.catchweight,
          });
          const basket = await getBasket(c.client, ctx(c.storeNumber, !!opts.slotBooked));
          printData(c, { ok: true, basket }, () => `Added ${opts.qty}× ${sku}\n${renderBasket(basket)}`);
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  cmd
    .command("set <sku> <qty>")
    .description("Set the quantity of a basket line. qty=0 removes the line.")
    .option("--uom <uom>", "Unit of measure (default looked up from basket)")
    .option("--slot-booked", "Pass slot_booked=true")
    .action(
      async (
        sku: string,
        qtyStr: string,
        opts: { uom?: string; slotBooked?: boolean },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          const qty = Number(qtyStr);
          if (!Number.isFinite(qty) || qty < 0) throw new Error(`invalid qty: ${qtyStr}`);
          const bctx = ctx(c.storeNumber, !!opts.slotBooked);
          const basket = await getBasket(c.client, bctx);
          const line = await findItemBySkuViaLookup(c.client, basket, sku, c.storeNumber);
          if (!line || !line.item_uid)
            throw new Error(`SKU ${sku} not in basket — add it first with \`basket add\`.`);
          await updateItems(c.client, bctx, [
            {
              productUid: sku,
              itemUid: line.item_uid,
              quantity: qty,
              uom: opts.uom ?? line.uom,
              decreasingQuantity: qty < line.quantity,
            },
          ]);
          const after = await getBasket(c.client, bctx);
          printData(
            c,
            { ok: true, basket: after },
            () => `Set ${sku} qty=${qty}\n${renderBasket(after)}`,
          );
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  cmd
    .command("remove <sku>")
    .description("Remove a SKU from the basket (alias for `basket set <sku> 0`)")
    .option("--slot-booked", "Pass slot_booked=true")
    .action(async (sku: string, opts: { slotBooked?: boolean }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const bctx = ctx(c.storeNumber, !!opts.slotBooked);
        const basket = await getBasket(c.client, bctx);
        const line = await findItemBySkuViaLookup(c.client, basket, sku, c.storeNumber);
        if (!line || !line.item_uid) throw new Error(`SKU ${sku} not in basket.`);
        await removeItem(c.client, bctx, {
          productUid: sku,
          itemUid: line.item_uid,
          uom: line.uom,
        });
        const after = await getBasket(c.client, bctx);
        printData(
          c,
          { ok: true, basket: after },
          () => `Removed ${sku}\n${renderBasket(after)}`,
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  return cmd;
}
