/**
 * Output helpers. All commands accept a global --json flag; when set, structured
 * data is printed as JSON to stdout. Otherwise human-readable text is printed.
 * Errors always go to stderr; data always goes to stdout. Exit codes are stable
 * so agents can branch on them.
 */

export type Format = "json" | "text";

export interface OutputContext {
  format: Format;
}

export function printData(ctx: OutputContext, data: unknown, textFn: () => string): void {
  if (ctx.format === "json") {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write(textFn() + "\n");
  }
}

export function printText(ctx: OutputContext, text: string): void {
  if (ctx.format === "json") return; // suppress chatter in JSON mode
  process.stdout.write(text + "\n");
}

export function printError(err: unknown): void {
  if (err instanceof Error) {
    process.stderr.write(`error: ${err.message}\n`);
  } else {
    process.stderr.write(`error: ${String(err)}\n`);
  }
}

export function exitCodeFor(err: unknown): number {
  if (err && typeof err === "object" && "name" in err) {
    if ((err as { name: string }).name === "AuthError") return 2;
    if ((err as { name: string }).name === "ApiError") return 3;
  }
  return 1;
}

export function formatMoney(value: number | undefined): string {
  if (value === undefined || value === null) return "-";
  return `£${value.toFixed(2)}`;
}

export function shortDate(iso: string | undefined): string {
  if (!iso) return "-";
  return iso.replace("T", " ").replace(/Z$/, " UTC");
}
