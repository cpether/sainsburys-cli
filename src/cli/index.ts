#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { printError, printInterruption, exitCodeFor } from "./output.js";
import { installInterruptionReporter } from "../auth/lifecycle.js";
import { authCommand } from "./commands/auth.js";
import { basketCommand } from "./commands/basket.js";
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
      "Auth: run `sainsburys auth login` once. Login and MFA are manual. Expiry requires another local login.",
      "Output: pass --json on any command for structured output. Default is human-readable.",
      "Stores: --store overrides the store number; otherwise derived from the account reservation.",
      "",
      "Run `sainsburys <topic> --help` to drill into a topic, e.g. `sainsburys order --help`.",
    ].join("\n"),
  )
  .version("0.1.0")
  .option("--json", "Emit structured JSON output to stdout")
  .option("-v, --verbose", "Verbose progress logging to stderr")
  .option("--store <number>", "Override store_number (4-digit, e.g. 2168)")
  .configureOutput({ outputError: (text, write) => { if (!process.argv.includes("--json")) write(text); } })
  .exitOverride();

program.addCommand(authCommand());
program.addCommand(basketCommand());
program.addCommand(orderCommand());
program.addCommand(productCommand());
program.addCommand(customerCommand());
program.addCommand(slotCommand());

// Commands are constructed separately, so configure error handling on every level.
function configureErrors(command: Command): void {
  command.configureOutput({ outputError: (text, write) => { if (!process.argv.includes("--json")) write(text); } }).exitOverride();
  for (const child of command.commands) configureErrors(child);
}
configureErrors(program);

const unregisterInterruptionReporter = installInterruptionReporter(printInterruption);
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof CommanderError && err.exitCode === 0) return;
  if (err instanceof CommanderError) {
    printError(new Error("Invalid command or arguments; run --help for supported operations"));
    process.exitCode = 1;
    return;
  }
  printError(err);
  process.exitCode = exitCodeFor(err);
}).finally(unregisterInterruptionReporter);
