import { Command } from "commander";
import {
  getActiveOrderStatus,
  getOrder,
  listOrders,
  startAmend,
} from "../../api/order.js";
import type { Order, OrderListItem } from "../../api/types.js";
import { buildContext } from "../context.js";
import {
  exitCodeFor,
  formatMoney,
  printData,
  printError,
  shortDate,
} from "../output.js";

function renderOrderRow(o: OrderListItem): string {
  return `${o.order_uid}  ${o.status.padEnd(12)} ${o.order_type.padEnd(10)} ${shortDate(
    o.slot_start_time,
  )}  ${formatMoney(o.total)}${o.is_in_amend_mode ? "  [amend]" : ""}`;
}

function renderOrder(o: Order): string {
  const head = [
    `Order ${o.order_uid}  status=${o.status}  type=${o.order_type}`,
    `  slot:    ${shortDate(o.slot_start_time)} → ${shortDate(o.slot_end_time)}`,
    `  totals:  ${formatMoney(o.total)}  (sub ${formatMoney(o.sub_total)})`,
    `  store:   ${o.store_identifier ?? "-"}    cancellable=${o.is_cancellable ?? "-"}    amend=${o.is_in_amend_mode ?? "-"}`,
  ].join("\n");
  const lines = (o.order_items ?? []).map(
    (i) =>
      `  ${String(i.product?.product_uid ?? i.product_uid ?? i.sain_id ?? "?").padEnd(8)} qty=${String(i.quantity).padStart(3)} ${(i.uom ?? "").padEnd(2)} ${formatMoney(
        i.sub_total,
      ).padStart(7)}  ${i.product?.name ?? ""}`,
  );
  return [head, "  items:", ...lines].join("\n");
}

export function orderCommand(): Command {
  const cmd = new Command("order").description("List, inspect, and amend orders");

  cmd
    .command("list")
    .description("List recent orders")
    .option("-n, --page-size <n>", "Page size (default 10)", (v) => Number(v), 10)
    .option("-p, --page <n>", "Page number (default 1)", (v) => Number(v), 1)
    .action(async (opts: { pageSize: number; page: number }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const result = await listOrders(c.client, {
          pageSize: opts.pageSize,
          pageNumber: opts.page,
        });
        printData(c, result, () =>
          (result.orders ?? []).map(renderOrderRow).join("\n") || "no orders",
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("status")
    .description("Show the active in-flight order summary (if any)")
    .action(async (_opts, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const status = await getActiveOrderStatus(c.client);
        if (!status) {
          printData(c, { active: false }, () => "no active order");
          return;
        }
        printData(c, { active: true, ...status }, () =>
          [
            `active order: ${status.order_uid}`,
            `  slot:    ${shortDate(status.slot_start_time)} → ${shortDate(status.slot_end_time)}`,
            `  type:    ${status.order_type ?? "-"}`,
            `  total:   ${formatMoney(status.total)}`,
            `  amend:   ${status.is_in_amend_mode}`,
            `  cutoff:  ${shortDate(status.cutoff_time)}  (passed=${status.is_cutoff})`,
          ].join("\n"),
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("show <orderId>")
    .description("Show full details for an order")
    .option("--placed", "Treat as placed (default true)", true)
    .action(async (orderId: string, opts: { placed: boolean }, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        const order = await getOrder(c.client, orderId, { placed: opts.placed });
        printData(c, order, () => renderOrder(order));
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("amend <orderId>")
    .description(
      "Flip an order into amend mode. After this, `basket show` returns the order's items as an editable basket.",
    )
    .action(async (orderId: string, _opts, cmdRef) => {
      try {
        const c = await buildContext(cmdRef);
        await startAmend(c.client, orderId);
        printData(
          c,
          { ok: true, order_uid: orderId, message: "amend mode active" },
          () =>
            `Order ${orderId} is now in amend mode. Use \`basket show --slot-booked\` and \`basket add/set/remove ...\`. Finalise via the checkout flow (not yet wired into this CLI).`,
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  return cmd;
}
