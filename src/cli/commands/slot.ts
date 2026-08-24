import { Command } from "commander";
import { getBasket } from "../../api/basket.js";
import { getSlotReservation } from "../../api/customer.js";
import { getActiveOrderStatus, getOrder, listOrders } from "../../api/order.js";
import { bookSlot, listSlots, type AvailableSlot } from "../../api/slot.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError, shortDate } from "../output.js";

function renderSlot(s: AvailableSlot): string {
  const time = `${shortDate(s.start_time)} → ${shortDate(s.end_time)}`;
  const flags = [
    s.is_available === false ? "oos" : "",
    s.is_booked_by_customer ? "booked" : "",
    s.is_green ? "green" : "",
    s.is_same_day ? "same-day" : "",
    s.slot_type === "saver_slot" ? "saver" : "1hr",
  ]
    .filter(Boolean)
    .join(",");
  return `${time}  ${formatMoney(s.price).padStart(7)}  ${flags.padEnd(22)}  key=${s.booking_key.slice(0, 14)}…`;
}

export function slotCommand(): Command {
  const cmd = new Command("slot").description("List, book, and change delivery slots.");

  cmd
    .command("current")
    .description("Show the active slot reservation (or the slot on the active order).")
    .option("--order-uid <id>", "Look up the reservation bound to a specific order")
    .action(async (opts: { orderUid?: string }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const r = await getSlotReservation(c.client, opts.orderUid);
        if (!r) {
          printData(c, { reserved: false }, () => "no slot reservation");
          return;
        }
        printData(c, r, () =>
          [
            `slot:        ${shortDate(r.slot?.start_time)} → ${shortDate(r.slot?.end_time)}`,
            `type:        ${r.reservation_type} / ${r.slot?.slot_type ?? "-"}`,
            `price:       ${formatMoney(r.slot?.price)}`,
            `held until:  ${shortDate(r.reserved_until)}`,
            `store:       ${r.store_identifier ?? "-"}`,
          ].join("\n"),
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("list")
    .description("List available delivery slots for a given week.")
    .option("-w, --week <n>", "Week number (1=this week, 2=next, ...)", (v) => Number(v), 1)
    .option("--slot-booked", "Pass slot_booked=true when reading basket SKUs.")
    .option("--type <t>", "DELIVERY | COLLECTION", "DELIVERY")
    .action(
      async (opts: { week: number; slotBooked?: boolean; type: string }, cmdRef) => {
        try {
          const c = await buildContext(cmdRef);
          // /slot/v2/slots requires non-empty product_uids — it returns per-line availability.
          // Try basket first; if it's empty (no active draft) fall back to the most recent
          // active order's line items.
          let productUids: string[] = [];
          const basket = await getBasket(c.client, {
            storeNumber: c.storeNumber,
            slotBooked: !!opts.slotBooked,
          });
          // Basket items expose SKU via sain_id; we need numeric product_uids for the
          // slot API. If the basket has items but no product_uids (the normal case),
          // fall through to the order fallback which has full product info.
          productUids = basket.items
            .map((i) => i.product?.product_uid ?? i.product_uid)
            .filter((x): x is string => Boolean(x));
          if (productUids.length === 0) {
            // Try the active order first, then fall back to the most recent placed order.
            let orderUid: string | undefined;
            const status = await getActiveOrderStatus(c.client);
            if (status?.order_uid) {
              orderUid = status.order_uid;
            } else {
              const list = await listOrders(c.client, { pageSize: 1, pageNumber: 1 });
              orderUid = list.orders?.[0]?.order_uid;
            }
            if (orderUid) {
              const order = await getOrder(c.client, orderUid);
              productUids = (order.order_items ?? [])
                .map((i) => (i.product as { product_uid?: string } | undefined)?.product_uid)
                .filter((x): x is string => Boolean(x));
            }
          }
          if (productUids.length === 0) {
            throw new Error(
              "no product SKUs available — basket is empty and no active order found. Add at least one item before listing slots.",
            );
          }
          const result = await listSlots(c.client, {
            weekNumber: opts.week,
            storeIdentifier: c.storeNumber,
            productUids,
            slotType: opts.type as "DELIVERY" | "COLLECTION",
          });
          printData(c, result, () => {
            const slots = result.slots ?? [];
            if (slots.length === 0) return "(no slots returned)";
            // Group by date for readability.
            const byDay = new Map<string, typeof slots>();
            for (const s of slots) {
              const day = s.start_time.slice(0, 10);
              const arr = byDay.get(day) ?? [];
              arr.push(s);
              byDay.set(day, arr);
            }
            const lines: string[] = [];
            for (const [day, ss] of byDay) {
              lines.push(`\n${day}  (${ss.length} slots, ${ss.filter((s) => s.is_available).length} available)`);
              for (const s of ss) lines.push(`  ${renderSlot(s)}`);
            }
            return lines.join("\n");
          });
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  cmd
    .command("book <booking-key> <slot-datetime>")
    .description(
      "Reserve a slot by its booking_key (from `slot list`). slot-datetime is ISO-8601 like 2026-05-26T13:00:00Z.",
    )
    .option(
      "--changes-confirmed",
      "Set changes_confirmed=true (used when re-booking on an amend).",
      false,
    )
    .action(
      async (
        bookingKey: string,
        slotDatetime: string,
        opts: { changesConfirmed: boolean },
        cmdRef,
      ) => {
        try {
          const c = await buildContext(cmdRef);
          await bookSlot(c.client, {
            bookingKey,
            newSlotDate: slotDatetime,
            newStoreNumber: c.storeNumber,
            changesConfirmed: opts.changesConfirmed,
          });
          printData(
            c,
            { ok: true, new_slot_date: slotDatetime },
            () => `Slot reserved: ${slotDatetime}`,
          );
        } catch (err) {
          printError(err);
          process.exit(exitCodeFor(err));
        }
      },
    );

  return cmd;
}
