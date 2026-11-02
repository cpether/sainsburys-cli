import { Command } from "commander";
import { getActiveOrderStatus, listOrders, getOrder } from "../../api/order.js";
import { createClient } from "../../client/factory.js";
import { summariseRegulars } from "../../basket/regulars.js";
import { getFormat } from "../context.js";
import { exitCodeFor, printData, printError } from "../output.js";
export function orderCommand(): Command {
  const cmd = new Command("order").description("Inspect active order state; amendments are unavailable");
  cmd.command("list").description("Read recent orders")
    .option("--page-size <n>", "Orders per page, 1 to 50", "5")
    .option("--page <n>", "Page number", "1")
    .action(async (opts, ref) => {
      try {
        const pageSize = Number(opts.pageSize), pageNumber = Number(opts.page);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) throw new Error("Provide page size 1 to 50 and page 1 to 1000");
        const result = await listOrders(await createClient(), {pageSize, pageNumber});
        printData({format:getFormat(ref)}, result, () => JSON.stringify(result));
      } catch (err) { printError(err); process.exitCode = exitCodeFor(err); }
    });
  cmd.command("get <order-id>").description("Read a previous order and its items")
    .action(async (orderId: string, _opts, ref) => {
      try {
        if (!/^\d+$/.test(orderId)) throw new Error("Provide a numeric order ID");
        const result = await getOrder(await createClient(), orderId);
        printData({format:getFormat(ref)}, result, () => JSON.stringify(result));
      } catch (err) { printError(err); process.exitCode = exitCodeFor(err); }
    });
  cmd.command("regulars").description("Summarise how often each product appears in recent orders")
    .option("--orders <n>", "Most recent orders to read, 1 to 10", "4")
    .action(async (opts, ref) => {
      try {
        const count = Number(opts.orders);
        if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("Provide --orders 1 to 10");
        const client = await createClient();
        const list = await listOrders(client, {pageSize: count, pageNumber: 1});
        const orders = [];
        for (const order of list.orders.slice(0, count)) orders.push(await getOrder(client, order.order_uid));
        const result = summariseRegulars(orders);
        printData({format:getFormat(ref)}, result, () => [
          `${result.orders.length} orders: ${result.orders.map(order => `${order.order_uid} (${order.slot_start_time.slice(0, 10)})`).join(", ")}`,
          ...result.products.map(p => `${String(p.orders).padStart(2)}/${result.orders.length} ${p.product_uid.padEnd(8)} typical ${p.typical_quantity} ${p.uom.padEnd(3)} last ${p.last_bought.slice(0, 10)}${p.new_in_latest ? " [new]" : "      "} ${JSON.stringify(p.name)}`),
        ].join("\n"));
      } catch (err) { printError(err); process.exitCode = exitCodeFor(err); }
    });
  cmd.command("status").action(async (_opts, ref) => {
    try {const status=await getActiveOrderStatus(await createClient());printData({format:getFormat(ref)}, {active:!!status,...status},()=>JSON.stringify(status));}
    catch(err){printError(err);process.exitCode=exitCodeFor(err);}
  });
  return cmd;
}
