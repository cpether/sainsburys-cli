import { Command } from "commander";
import { getActiveOrderStatus, listOrders, getOrder } from "../../api/order.js";
import { createClient } from "../../client/factory.js";
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
  cmd.command("status").action(async (_opts, ref) => {
    try {const status=await getActiveOrderStatus(await createClient());printData({format:getFormat(ref)}, {active:!!status,...status},()=>JSON.stringify(status));}
    catch(err){printError(err);process.exitCode=exitCodeFor(err);}
  });
  return cmd;
}
