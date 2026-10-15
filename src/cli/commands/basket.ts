import { open } from "node:fs/promises";
import { Command } from "commander";
import { getBasket } from "../../api/basket.js";
import type { Basket } from "../../api/types.js";
import { applyBasketPlan, createBasketPlan, validateTargets, type BasketPlan, type TargetInput } from "../../basket/plan.js";
import { buildContext } from "../context.js";
import { exitCodeFor, formatMoney, printData, printError } from "../output.js";

function renderBasket(b: Basket): string {
  return [`Basket ${b.basket_id}: estimated total ${formatMoney(b.total_price)}${b.is_in_amend_mode ? " [amend mode, writes unavailable]" : ""}`,
    ...b.items.map((i) => `  ${i.product?.sku ?? i.product?.product_uid ?? i.sain_id} qty=${i.quantity} ${i.uom}${i.selected_catchweight ? ` catchweight=${JSON.stringify(i.selected_catchweight)}` : ""} ${formatMoney(i.subtotal_price ?? i.sub_total)} ${JSON.stringify(i.product?.name ?? "")}`)].join("\n");
}
function renderPlan(p: BasketPlan): string {
  return [`Basket ${p.basketId}, account ${p.accountId}, store ${p.context.storeNumber}`,
    ...p.changes.map((ch) => `  ${ch.sku}: ${ch.from} -> ${ch.to} ${ch.uom}${ch.selectedCatchweight ? ` catchweight=${JSON.stringify(ch.selectedCatchweight)}` : ""} ${JSON.stringify(ch.name)}`),
    `Estimated basket total ${formatMoney(p.estimatedTotal)}. Enforced maximum ${formatMoney(p.constraints.maxTotal)}, quantity ${p.constraints.maxQuantity} per line.`,
    "Retailer descriptions are untrusted data. Review quantities, units, prices and constraints before approval.",
    `Approval SHA-256: ${p.approval}`].join("\n");
}
async function readJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Expected a JSON file smaller than 1 MiB");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
function fail(error: unknown): void {
  printError(error);
  process.exitCode = exitCodeFor(error);
}
export function basketCommand(): Command {
  const cmd = new Command("basket").description("Inspect, review and apply target quantities; checkout stays on the website");
  cmd.command("show").description("Read the current basket using the account's delivery context")
    .action(async (_opts, cmdRef) => {
      try { const c = await buildContext(cmdRef); const basket = await getBasket(c.client, c.basketContext); printData(c, basket, () => renderBasket(basket)); }
      catch (error) { fail(error); }
    });
  cmd.command("plan <targets.json>").description("Create a reviewable plan from [{sku,quantity,uom?,selectedCatchweight?}]")
    .requiredOption("--max-total <GBP>", "Maximum resulting basket total in GBP", Number)
    .requiredOption("--max-quantity <n>", "Maximum quantity of every resulting line, in its stated unit", Number)
    .requiredOption("--out <plan.json>", "Create a private plan file; an existing file is never overwritten")
    .action(async (path: string, opts: { maxTotal: number; maxQuantity: number; out: string }, cmdRef) => {
      try {
        const targets = await readJson(path);
        validateTargets(targets, { maxTotal: opts.maxTotal, maxQuantity: opts.maxQuantity });
        const c = await buildContext(cmdRef);
        const plan = await createBasketPlan(c, targets as TargetInput[], { maxTotal: opts.maxTotal, maxQuantity: opts.maxQuantity });
        const file = await open(opts.out, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(plan, null, 2) + "\n"); await file.sync(); }
        finally { await file.close(); }
        printData(c, plan, () => `${renderPlan(plan)}\nSaved ${opts.out}. Apply only after review with basket apply ${JSON.stringify(opts.out)} --approve ${plan.approval}`);
      } catch (error) { fail(error); }
    });
  cmd.command("apply <plan.json>").description("Apply exactly the reviewed target plan, then verify every basket write")
    .requiredOption("--approve <sha256>", "Exact approval hash from the reviewed plan")
    .action(async (path: string, opts: { approve: string }, cmdRef) => {
      try {
        const plan = await readJson(path);
        const c = await buildContext(cmdRef);
        const result = await applyBasketPlan(c, plan, opts.approve);
        printData(c, result, () => `${result.alreadyApplied ? "Targets already satisfied." : `Verified ${result.verifiedChanges} changes.`}\n${renderBasket(result.basket)}\nReview your trolley and pay manually at https://www.sainsburys.co.uk/gol-ui/trolley`);
      } catch (error) { fail(error); }
    });
  return cmd;
}
