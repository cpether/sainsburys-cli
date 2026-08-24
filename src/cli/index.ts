#!/usr/bin/env node
import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { basketCommand } from "./commands/basket.js";
import { checkoutCommand } from "./commands/checkout.js";
import { customerCommand } from "./commands/customer.js";
import { orderCommand } from "./commands/order.js";
import { productCommand } from "./commands/product.js";
import { slotCommand } from "./commands/slot.js";

const program = new Command();

program
  .name("sainsburys")
  .description(
    [
      "Agent-friendly CLI for Sainsbury's Groceries Online.",
      "",
      "Auth: run `sainsburys auth login` once. Sessions are auto-refreshed on 401/403.",
      "Output: pass --json on any command for structured output. Default is human-readable.",
      "Stores: --store overrides the store number; otherwise pulled from the session.",
      "",
      "Run `sainsburys <topic> --help` to drill into a topic, e.g. `sainsburys order --help`.",
    ].join("\n"),
  )
  .version("0.1.0")
  .option("--json", "Emit structured JSON output to stdout")
  .option("-v, --verbose", "Verbose progress logging to stderr")
  .option("--store <number>", "Override store_number (4-digit, e.g. 2168)")
  .showHelpAfterError();

program.addCommand(authCommand());
program.addCommand(basketCommand());
program.addCommand(orderCommand());
program.addCommand(productCommand());
program.addCommand(customerCommand());
program.addCommand(checkoutCommand());
program.addCommand(slotCommand());

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
