import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAuthLock } from "../auth/session.js";
import { addItem, findItemBySku, getBasket, itemIdentifiers, normalizeIdentifier, productUid, updateItems, validateQuantity, type BasketContext } from "../api/basket.js";
import { getActiveOrderStatus } from "../api/order.js";
import { getProductsByUid, type ProductQueryContext } from "../api/product.js";
import type { Basket, BasketItem, Product } from "../api/types.js";
import type { GroceriesClient } from "../client/http.js";

export interface TargetInput { sku: string; quantity: number; uom?: string; selectedCatchweight?: string }
export interface Constraints { maxTotal: number; maxQuantity: number }
interface StateLine { key: string; sku?: string; itemUid: string; quantity: number; uom: string; selectedCatchweight: string; lineTotal: number }
export interface PlanChange { sku: string; key: string; name: string; from: number; to: number; uom: string; selectedCatchweight: string; unitPrice: number }
export interface BasketPlan {
  version: 1;
  accountId: string;
  basketId: string;
  context: BasketContext;
  productContext: ProductQueryContext;
  reservationId: string | null;
  baseline: StateLine[];
  baselineTotal: number;
  changes: PlanChange[];
  estimatedTotal: number;
  constraints: Constraints;
  approval: string;
}
export interface PlanContext { client: GroceriesClient; basketContext: BasketContext; productContext: ProductQueryContext; reservationId?: string | null }
export class BasketApplyError extends Error {
  constructor(message: string, public readonly outcome: "mismatch" | "unknown" | "partial", public readonly verifiedChanges: number, public readonly basket?: Basket) {
    super(message); this.name = "BasketApplyError";
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function planApproval(plan: Omit<BasketPlan, "approval"> | BasketPlan): string {
  const { approval: _, ...rest } = plan as BasketPlan;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}
function stableContext(ctx: BasketContext): BasketContext {
  return { storeNumber: ctx.storeNumber, slotBooked: !!ctx.slotBooked, ...(ctx.slotBooked ? { pickTime: ctx.pickTime } : {}) };
}
function lineKey(i: BasketItem): string {
  const key = i.sain_id ?? i.product?.sainId ?? i.product?.sain_id ?? productUid(i);
  if (!key) throw new Error("Basket line has no stable product identifier");
  return normalizeIdentifier(key);
}
function state(basket: Basket, identities: {key:string;sku?:string}[] = []): StateLine[] {
  return basket.items.map((i) => {
    const lineTotal = i.subtotal_price ?? i.sub_total;
    if (typeof lineTotal !== "number" || !Number.isFinite(lineTotal) || lineTotal < 0) throw new Error("Basket line is missing its price");
    const sku = productUid(i);
    const ids = itemIdentifiers(i);
    const matches = identities.filter(identity => ids.includes(identity.key) || (identity.sku !== undefined && ids.includes(identity.sku)));
    if (new Set(matches.map(identity => identity.key)).size > 1 || matches.some(identity => sku !== undefined && identity.sku !== undefined && sku !== identity.sku)) {
      throw new Error("Basket product identifiers conflict with the reviewed plan");
    }
    return { key: matches[0]?.key ?? lineKey(i), sku, itemUid: i.item_uid!, quantity: i.quantity, uom: i.uom, selectedCatchweight: i.selected_catchweight ?? "", lineTotal };
  }).sort((a, b) => a.itemUid.localeCompare(b.itemUid));
}
function stateForPlan(basket: Basket, plan: BasketPlan): StateLine[] {
  return state(basket, [...plan.baseline, ...plan.changes]);
}
function findPlannedLine(basket: Basket, plan: BasketPlan, key: string): BasketItem | undefined {
  const matches = stateForPlan(basket, plan).filter(line => line.key === key);
  if (matches.length > 1) throw new Error("Multiple basket lines match the reviewed product");
  return basket.items.find(line => line.item_uid === matches[0]?.itemUid);
}
function quantityState(lines: StateLine[]): string {
  return canonical(lines.map(({ key, quantity, uom, selectedCatchweight }) => ({ key, quantity, uom, selectedCatchweight })).sort((a, b) => canonical(a).localeCompare(canonical(b))));
}
function expectedLines(plan: BasketPlan, changes: PlanChange[]): StateLine[] {
  const lines = structuredClone(plan.baseline);
  for (const change of changes) {
    const matches = lines.filter((i) => i.key === change.key);
    if (matches.length > 1) throw new Error("Ambiguous basket lines in plan");
    const existing = matches[0];
    if (existing) {
      if (!change.to) lines.splice(lines.indexOf(existing), 1);
      else { existing.quantity = change.to; existing.lineTotal = change.unitPrice * change.to; }
    } else if (change.to) lines.push({ key: change.key, sku: change.sku, itemUid: "pending", quantity: change.to, uom: change.uom, selectedCatchweight: change.selectedCatchweight, lineTotal: change.unitPrice * change.to });
  }
  return lines;
}
function estimateTotal(baseline: StateLine[], baselineTotal: number, changes: PlanChange[]): number {
  const total = baselineTotal + changes.reduce((sum, change) => {
    const old = baseline.find(line => line.key === change.key);
    return sum - (old?.lineTotal ?? 0) + change.unitPrice * change.to;
  }, 0);
  return Math.max(0, Math.round(total * 100) / 100);
}
function checkConstraints(constraints: Constraints): void {
  if (!constraints || !Number.isFinite(constraints.maxTotal) || constraints.maxTotal < 0 || constraints.maxTotal > 10000 ||
    !Number.isFinite(constraints.maxQuantity) || constraints.maxQuantity <= 0 || constraints.maxQuantity > 99) {
    throw new Error("Explicit maxTotal (0–10000 GBP) and maxQuantity (0–99) constraints are required");
  }
}
function enforceBasket(b: Basket, constraints: Constraints): void {
  if (b.total_price > constraints.maxTotal + 0.005) throw new Error("Basket exceeds the approved maximum total");
  if (b.items.some((i) => i.quantity > constraints.maxQuantity)) throw new Error("Basket exceeds the approved per-line maximum quantity");
}
async function guard(c: PlanContext, b: Basket): Promise<void> {
  const status = await getActiveOrderStatus(c.client);
  if (b.is_in_amend_mode !== false || status?.is_in_amend_mode) throw new Error("Basket changes are unavailable while an order is in amend mode");
}
async function lookup(c: PlanContext, sku: string): Promise<Product> {
  const response = await getProductsByUid(c.client, { uids: [sku], ctx: c.productContext, available: false });
  if (!response || !Array.isArray(response.products)) throw new Error("Invalid product lookup response");
  const matches = response.products.filter((p) => [p.sku, p.product_uid, p.sainId, p.sain_id].some((v) => v !== undefined && normalizeIdentifier(v) === sku));
  if (matches.length !== 1) throw new Error("Product lookup did not resolve exactly one matching product");
  return matches[0]!;
}
function soldByUnit(product: Product): "ea" | "kg" {
  const measure = product.retail_price?.measure;
  if (measure === "ea" || measure === "unit") return "ea";
  if (measure === "kg") return "kg";
  throw new Error("Product sold-by unit is unknown; verify this item on the website before adding it");
}
function price(p: Product, line?: BasketItem): number {
  const value = p.retail_price?.price;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Product has no valid retail price; cannot authorize a spending estimate");
  const effective = line ? (line.subtotal_price ?? line.sub_total ?? 0) / line.quantity : 0;
  return Math.max(value, effective);
}
export function validateTargets(targets: unknown, constraints: Constraints): asserts targets is TargetInput[] {
  checkConstraints(constraints);
  if (!Array.isArray(targets) || !targets.length || targets.length > 100) throw new Error("Supply 1–100 target quantities");
  // Reject malformed quantities before any network call.
  for (const t of targets as TargetInput[]) {
    if (!t || typeof t !== "object" || typeof t.quantity !== "number" || !Number.isFinite(t.quantity) || t.quantity < 0 || t.quantity > constraints.maxQuantity) throw new Error("Invalid target quantity or approved quantity limit exceeded");
    normalizeIdentifier(t.sku, "target SKU");
    if (t.uom !== undefined) validateQuantity(t.quantity, t.uom);
  }
}
export async function createBasketPlan(c: PlanContext, targets: TargetInput[], constraints: Constraints): Promise<BasketPlan> {
  validateTargets(targets, constraints);
  const basket = await getBasket(c.client, c.basketContext);
  await guard(c, basket);
  const baseline = state(basket);
  const changes: PlanChange[] = [];
  for (const target of targets) {
    const sku = normalizeIdentifier(target.sku);
    const existing = findItemBySku(basket, sku);
    const product = await lookup(c, productUid(existing ?? {} as BasketItem) ?? sku);
    const uid = normalizeIdentifier(product.product_uid ?? product.sku, "resolved numeric SKU");
    if (!/^\d+$/.test(uid)) throw new Error("Product lookup has no numeric SKU");
    const line = existing ?? findItemBySku(basket, uid) ?? (product.sainId ? findItemBySku(basket, normalizeIdentifier(product.sainId)) : undefined);
    const productUnit = !line && target.quantity > 0 ? soldByUnit(product) : undefined;
    const uom = target.uom ?? line?.uom ?? productUnit ?? "ea";
    if (productUnit && uom !== productUnit) throw new Error("New-line unit differs from the product's sold-by unit");
    validateQuantity(target.quantity, uom);
    if (line && target.uom !== undefined && target.uom !== line.uom) throw new Error("A target cannot change an existing line's unit");
    const selectedCatchweight = target.selectedCatchweight ?? line?.selected_catchweight ?? "";
    if (typeof selectedCatchweight !== "string" || selectedCatchweight.length > 128 || /[\x00-\x1f]/.test(selectedCatchweight)) throw new Error("Invalid catchweight selection");
    if (line && selectedCatchweight !== (line.selected_catchweight ?? "")) throw new Error("A target cannot change an existing line's catchweight selection");
    if (!line && selectedCatchweight) throw new Error("New catchweight selections require website review; existing selections can be preserved");
    if (target.quantity > 0 && product.is_available === false) throw new Error("Target product is unavailable");
    const key = line ? lineKey(line) : normalizeIdentifier(product.sainId ?? product.sain_id ?? uid);
    if (changes.some((ch) => ch.key === key)) throw new Error("Duplicate target product");
    changes.push({ sku: uid, key, name: typeof product.name === "string" ? product.name : "", from: line?.quantity ?? 0, to: target.quantity, uom, selectedCatchweight, unitPrice: price(product, line) });
  }
  const plan: BasketPlan = { version: 1, accountId: c.client.getSession().userId, basketId: basket.basket_id,
    context: stableContext(c.basketContext), productContext: c.productContext, reservationId: c.reservationId ?? null, baseline, baselineTotal: basket.total_price, changes,
    estimatedTotal: 0, constraints, approval: "" };
  plan.estimatedTotal = estimateTotal(baseline, basket.total_price, changes);
  if (plan.estimatedTotal > constraints.maxTotal || expectedLines(plan, changes).some((i) => i.quantity > constraints.maxQuantity)) throw new Error("Proposed basket exceeds the approved quantity or spending limit");
  plan.approval = planApproval(plan);
  validatePlan(plan, plan.approval);
  return plan;
}
function validatePlan(value: unknown, approval: string): BasketPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid basket plan");
  const p = value as BasketPlan;
  if (p.version !== 1 || typeof p.approval !== "string" || !/^[a-f0-9]{64}$/.test(approval) || p.approval !== approval || planApproval(p) !== approval) throw new Error("Plan approval does not match the reviewed plan");
  checkConstraints(p.constraints);
  if (!Array.isArray(p.changes) || !p.changes.length || p.changes.length > 100 || !Array.isArray(p.baseline) ||
    !Number.isFinite(p.baselineTotal) || p.baselineTotal < 0 || typeof p.accountId !== "string" ||
    !p.context || typeof p.context.slotBooked !== "boolean" || !p.productContext ||
    (p.reservationId !== null && typeof p.reservationId !== "string")) throw new Error("Invalid basket plan contents");
  normalizeIdentifier(p.accountId); normalizeIdentifier(p.basketId);
  const baselineKeys = new Set<string>();
  const lineIds = new Set<string>();
  for (const line of p.baseline) {
    normalizeIdentifier(line.key); normalizeIdentifier(line.itemUid);
    if (line.sku !== undefined && !/^\d+$/.test(normalizeIdentifier(line.sku))) throw new Error("Invalid baseline SKU");
    validateQuantity(line.quantity, line.uom);
    if (!line.quantity || baselineKeys.has(line.key) || lineIds.has(line.itemUid) || !Number.isFinite(line.lineTotal) || line.lineTotal < 0 || typeof line.selectedCatchweight !== "string") throw new Error("Invalid or ambiguous baseline line");
    baselineKeys.add(line.key); lineIds.add(line.itemUid);
  }
  const keys = new Set<string>();
  for (const ch of p.changes) {
    if (!/^\d+$/.test(normalizeIdentifier(ch.sku))) throw new Error("Invalid target SKU");
    normalizeIdentifier(ch.key); validateQuantity(ch.to, ch.uom); validateQuantity(ch.from, ch.uom);
    const old = p.baseline.find((line) => line.key === ch.key);
    if (keys.has(ch.key) || ch.from !== (old?.quantity ?? 0) || (old && (old.uom !== ch.uom || old.selectedCatchweight !== ch.selectedCatchweight || (old.sku !== undefined && old.sku !== ch.sku))) ||
      (!old && ch.selectedCatchweight !== "") || ch.to > p.constraints.maxQuantity || !Number.isFinite(ch.unitPrice) || ch.unitPrice < 0 || typeof ch.selectedCatchweight !== "string" || ch.selectedCatchweight.length > 128 || /[\x00-\x1f]/.test(ch.selectedCatchweight)) {
      throw new Error("Invalid plan quantity, price, unit, identity or weight");
    }
    keys.add(ch.key);
  }
  const estimate = estimateTotal(p.baseline, p.baselineTotal, p.changes);
  if (!Number.isFinite(p.estimatedTotal) || p.estimatedTotal !== estimate || estimate > p.constraints.maxTotal || expectedLines(p, p.changes).some((l) => l.quantity > p.constraints.maxQuantity)) throw new Error("Plan estimate or quantities violate the spending or quantity limit");
  return p;
}
async function applyLocked(c: PlanContext, value: unknown, approval: string): Promise<{ ok: true; alreadyApplied: boolean; verifiedChanges: number; basket: Basket }> {
  const plan = validatePlan(value, approval);
  if (plan.reservationId !== (c.reservationId ?? null) || plan.accountId !== c.client.getSession().userId || canonical(plan.context) !== canonical(stableContext(c.basketContext)) || canonical(plan.productContext) !== canonical(c.productContext)) throw new Error("Account or delivery context changed; create a new plan");
  let basket = await getBasket(c.client, c.basketContext);
  await guard(c, basket);
  if (basket.basket_id !== plan.basketId) throw new Error("Basket identity changed; create a new plan");
  const current = stateForPlan(basket, plan);
  const final = expectedLines(plan, plan.changes);
  if (quantityState(current) === quantityState(final)) {
    enforceBasket(basket, plan.constraints);
    return { ok: true, alreadyApplied: true, verifiedChanges: 0, basket };
  }
  if (canonical(current) !== canonical(plan.baseline) || basket.total_price !== plan.baselineTotal) throw new Error("Basket contents or prices changed; create a new plan");
  for (const ch of plan.changes) {
    const p = await lookup(c, ch.sku);
    const existing = findPlannedLine(basket, plan, ch.key);
    if (!existing && ch.to > 0 && ch.uom !== soldByUnit(p)) throw new Error("New-line unit differs from the product's sold-by unit");
    const resolved = normalizeIdentifier(p.product_uid ?? p.sku);
    const productKey = existing ? ch.key : normalizeIdentifier(p.sainId ?? p.sain_id ?? resolved);
    const productIds = [p.sku, p.product_uid, p.sainId, p.sain_id].filter((id) => id !== undefined).map((id) => normalizeIdentifier(id));
    const existingIds = existing ? [productUid(existing), existing.sain_id, existing.product?.sainId, existing.product?.sain_id].filter((id) => id !== undefined).map((id) => normalizeIdentifier(id)) : [];
    if (existing && !existingIds.some((id) => productIds.includes(id))) throw new Error("Product lookup does not match the existing basket line");
    if (resolved !== ch.sku || productKey !== ch.key || (ch.to > 0 && p.is_available === false) || price(p, existing) !== ch.unitPrice) throw new Error("Product price or availability changed; create a new plan");
  }
  let completed = 0;
  const applied: PlanChange[] = [];
  // Decreases first keep intermediate basket totals within the approved ceiling.
  const ordered = [...plan.changes].sort((a, b) => (a.to - a.from) - (b.to - b.from));
  for (const ch of ordered) {
    if (ch.from === ch.to) { applied.push(ch); continue; }
    try {
      const before = await getBasket(c.client, c.basketContext);
      await guard(c, before);
      if (quantityState(stateForPlan(before, plan)) !== quantityState(expectedLines(plan, applied))) throw new Error("Basket changed during application");
      if (before.basket_id !== plan.basketId) throw new Error("Basket identity changed during application");
      const line = findPlannedLine(before, plan, ch.key);
      let writeError: unknown;
      try {
        if (line) await updateItems(c.client, c.basketContext, [{ productUid: ch.sku, itemUid: line.item_uid!, quantity: ch.to, uom: ch.uom, selectedCatchweight: ch.selectedCatchweight, decreasingQuantity: ch.to < line.quantity }]);
        else if (ch.to) await addItem(c.client, c.basketContext, { productUid: ch.sku, quantity: ch.to, uom: ch.uom, selectedCatchweight: ch.selectedCatchweight });
      } catch (err) { writeError = err; }
      let after: Basket;
      let afterState: StateLine[];
      try { after = await getBasket(c.client, c.basketContext); afterState = stateForPlan(after, plan); }
      catch { throw new BasketApplyError("Write outcome is unknown because basket readback failed. Inspect the website before any further change.", "unknown", completed); }
      basket = after;
      if (after.basket_id !== plan.basketId || after.is_in_amend_mode || quantityState(afterState) !== quantityState(expectedLines(plan, [...applied, ch]))) {
        throw new BasketApplyError(writeError ? "Write outcome is uncertain or differs from the target. Inspect the basket before creating a new plan." : "Basket readback differs from the target or changed another line.", writeError ? "unknown" : "mismatch", completed, after);
      }
      completed++;
      applied.push(ch);
      enforceBasket(after, plan.constraints);
      // A failed HTTP write can still be verified by authoritative readback. Never retry it.
    } catch (error) {
      if (error instanceof BasketApplyError) throw error;
      throw new BasketApplyError(`Basket application stopped${completed ? " after partial completion" : ""}: ${error instanceof Error ? error.message : "verification failed"}`, completed ? "partial" : "mismatch", completed, basket);
    }
  }
  enforceBasket(basket, plan.constraints);
  return { ok: true, alreadyApplied: false, verifiedChanges: completed, basket };
}

/** Account-scoped cross-process lock also coordinates distinct session files. */
export async function applyBasketPlan(c: PlanContext, value: unknown, approval: string): Promise<{ ok: true; alreadyApplied: boolean; verifiedChanges: number; basket: Basket }> {
  const key = createHash("sha256").update(c.client.getSession().userId).digest("hex");
  return withAuthLock(join(tmpdir(), `sainsburys-basket-${process.getuid?.() ?? "user"}`, `${key}.lock`), () => applyLocked(c, value, approval));
}
