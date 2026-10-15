import { Command } from "commander";
import { getActiveOrderStatus } from "../../api/order.js";
import { createClient } from "../../client/factory.js";
import { getFormat } from "../context.js";
import { exitCodeFor, printData, printError } from "../output.js";
export function orderCommand(): Command {
  const cmd = new Command("order").description("Inspect active order state; amendments are unavailable");
  cmd.command("status").action(async (_opts, ref) => {
    try {const status=await getActiveOrderStatus(await createClient());printData({format:getFormat(ref)}, {active:!!status,...status},()=>JSON.stringify(status));}
    catch(err){printError(err);process.exitCode=exitCodeFor(err);}
  });
  return cmd;
}
