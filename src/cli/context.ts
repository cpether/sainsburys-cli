import type { Command } from "commander";
import { createClient, inferStoreNumber } from "../client/factory.js";
import type { GroceriesClient } from "../client/http.js";
import type { Format, OutputContext } from "./output.js";

export interface CommandContext extends OutputContext {
  client: GroceriesClient;
  storeNumber: string;
}

export function getFormat(cmd: Command): Format {
  // commander exposes inherited opts via opts() at any level
  const opts = cmd.optsWithGlobals();
  return opts.json ? "json" : "text";
}

export async function buildContext(cmd: Command): Promise<CommandContext> {
  const opts = cmd.optsWithGlobals();
  const client = await createClient({
    log: opts.verbose ? (msg) => process.stderr.write(`# ${msg}\n`) : undefined,
  });
  return {
    client,
    storeNumber: inferStoreNumber(client, opts.store),
    format: opts.json ? "json" : "text",
  };
}
