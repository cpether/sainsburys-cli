import type { Command } from "commander";
import { createClient } from "../client/factory.js";
import type { GroceriesClient } from "../client/http.js";
import { resolveShoppingContext, type ShoppingContext } from "../api/context.js";
import { loadConfigPartial } from "../config.js";
import type { Format, OutputContext } from "./output.js";
export interface CommandContext extends OutputContext, ShoppingContext { client: GroceriesClient; storeNumber: string; }
export function getFormat(cmd: Command): Format { return cmd.optsWithGlobals().json ? "json" : "text"; }
export async function buildContext(cmd: Command): Promise<CommandContext> {
  const opts = cmd.optsWithGlobals();
  const client = await createClient({ log: opts.verbose ? msg => process.stderr.write(`# ${msg}\n`) : undefined });
  const ctx = await resolveShoppingContext(client, opts.store ?? loadConfigPartial().storeNumber);
  return { client, ...ctx, storeNumber: ctx.basketContext.storeNumber, format: getFormat(cmd) };
}
