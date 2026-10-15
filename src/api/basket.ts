import type { GroceriesClient } from "../client/http.js";
import type { Basket, BasketItem } from "./types.js";
import { identifier } from "./validation.js";

export interface BasketContext {
  pickTime?: string;
  storeNumber: string;
  slotBooked?: boolean;
}
const BASE = "/groceries-api/gol-services/basket/v2/basket";

export function normalizeIdentifier(value: unknown, label = "identifier"): string {
  let result: string;
  try { result = identifier(value, label); }
  catch { throw new Error(`Invalid ${label}`); }
  if (result.length > 128) throw new Error(`Invalid ${label}`);
  return result;
}

export function validateQuantity(quantity: number, uom: string): void {
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error("Quantity must be finite and non-negative");
  if (uom === "ea") {
    if (!Number.isInteger(quantity) || quantity > 99) throw new Error("Each quantities must be whole numbers between 0 and 99");
  } else if (uom === "kg") {
    if (quantity > 25 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 1e-7) {
      throw new Error("Weight quantities must be between 0 and 25 kg, in 0.001 kg increments");
    }
  } else throw new Error("Unsupported quantity unit; only ea and kg are supported initially");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid basket response");
  return value as Record<string, unknown>;
}

export function normalizeBasket(value: unknown): Basket {
  const b = object(value);
  if (!Array.isArray(b.items) || typeof b.is_in_amend_mode !== "boolean" ||
    typeof b.total_price !== "number" || !Number.isFinite(b.total_price) || b.total_price < 0) {
    throw new Error("Invalid basket response: items, total_price and amendment status are required");
  }
  const items = b.items.map((raw): BasketItem => {
    const i = object(raw);
    const product = i.product === undefined ? undefined : { ...object(i.product) };
    for (const key of ["sku", "product_uid", "sainId", "sain_id"]) {
      if (product?.[key] !== undefined) product[key] = normalizeIdentifier(product[key], `product ${key}`);
    }
    if (typeof i.quantity !== "number" || !Number.isFinite(i.quantity) || i.quantity <= 0 ||
      typeof i.uom !== "string" || !i.uom || (i.selected_catchweight !== undefined && typeof i.selected_catchweight !== "string")) {
      throw new Error("Invalid basket line quantity or unit");
    }
    const line = { ...i, product } as unknown as BasketItem;
    for (const key of ["product_uid", "sain_id", "item_uid"] as const) {
      if (i[key] !== undefined) line[key] = normalizeIdentifier(i[key], key);
    }
    productUid(line); // Reject conflicting numeric IDs before returning retailer data.
    if (!line.item_uid || !itemIdentifiers(line).length) throw new Error("Invalid basket line identifiers");
    for (const price of [line.subtotal_price, line.sub_total]) {
      if (price !== undefined && (!Number.isFinite(price) || price < 0)) throw new Error("Invalid basket line price");
    }
    return line;
  });
  if (new Set(items.map((i) => i.item_uid)).size !== items.length) throw new Error("Duplicate basket line identifier");
  return { ...b, basket_id: normalizeIdentifier(b.basket_id, "basket ID"), items } as unknown as Basket;
}

export function itemIdentifiers(item: BasketItem): string[] {
  return [item.product?.sku, item.product?.product_uid, item.product_uid, item.sain_id, item.product?.sainId, item.product?.sain_id]
    .filter((v) => v !== undefined).map((v) => normalizeIdentifier(v));
}

export function productUid(item: BasketItem): string | undefined {
  const values = [item.product?.sku, item.product?.product_uid, item.product_uid]
    .map((value) => value === undefined ? undefined : normalizeIdentifier(value))
    .filter((value): value is string => value !== undefined && /^\d+$/.test(value));
  if (new Set(values).size > 1) throw new Error("Conflicting numeric product SKUs");
  return values[0];
}

function basketQuery(ctx: BasketContext, extra: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  if (!/^\d+$/.test(ctx.storeNumber)) throw new Error("A valid account store number is required");
  if (ctx.pickTime !== undefined && !Number.isFinite(Date.parse(ctx.pickTime))) throw new Error("Invalid basket pick time");
  return { pick_time: ctx.pickTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), store_number: ctx.storeNumber, slot_booked: ctx.slotBooked ?? false, ...extra };
}

export async function getBasket(client: GroceriesClient, ctx: BasketContext): Promise<Basket> {
  return client.request<Basket>(BASE, { query: basketQuery(ctx, { calculate: true }), validate: normalizeBasket });
}

export interface AddItemArgs { productUid: string; quantity?: number; uom?: string; selectedCatchweight?: string }
function writeValues(args: AddItemArgs): { product_uid: string; quantity: number; uom: string; selected_catchweight: string } {
  const uid = normalizeIdentifier(args.productUid, "product SKU");
  if (!/^\d+$/.test(uid)) throw new Error("Writes require a numeric product SKU");
  const quantity = args.quantity ?? 1;
  const uom = args.uom ?? "ea";
  validateQuantity(quantity, uom);
  const selected = args.selectedCatchweight ?? "";
  if (typeof selected !== "string" || selected.length > 128 || /[\x00-\x1f]/.test(selected)) throw new Error("Invalid catchweight selection");
  return { product_uid: uid, quantity, uom, selected_catchweight: selected };
}

/** Write acknowledgements carry no success authority; the workflow always reads back. */
function validateWriteAcknowledgement(value: unknown): void {
  if (value === undefined || value === null) return;
  object(value);
}

/** Low-level protocol operation. Agent CLI mutations must use the approved-plan workflow. */
export async function addItem(client: GroceriesClient, ctx: BasketContext, args: AddItemArgs): Promise<void> {
  const body = writeValues(args);
  if (!body.quantity) throw new Error("Adding zero quantity is invalid");
  await client.request<unknown>(`${BASE}/item`, { method: "POST", query: basketQuery(ctx), body, allowEmpty: true, validate: validateWriteAcknowledgement });
}
export interface UpdateItemArgs extends AddItemArgs { itemUid: string; quantity: number; decreasingQuantity?: boolean }
export async function updateItems(client: GroceriesClient, ctx: BasketContext, items: UpdateItemArgs[]): Promise<void> {
  if (!items.length) throw new Error("No basket updates supplied");
  const body = { items: items.map((i) => ({ ...writeValues(i), item_uid: normalizeIdentifier(i.itemUid, "basket line ID"), ...(i.decreasingQuantity ? { decreasing_quantity: true } : {}) })) };
  await client.request<unknown>(BASE, { method: "PUT", query: basketQuery(ctx), body, allowEmpty: true, validate: validateWriteAcknowledgement });
}
export async function removeItem(client: GroceriesClient, ctx: BasketContext, args: { productUid: string; itemUid: string; uom?: string; selectedCatchweight?: string }): Promise<void> {
  return updateItems(client, ctx, [{ ...args, quantity: 0, decreasingQuantity: true }]);
}
export function findItemBySku(basket: Basket, sku: string): BasketItem | undefined {
  const id = normalizeIdentifier(sku);
  const matches = basket.items.filter((i) => itemIdentifiers(i).includes(id));
  if (matches.length > 1) throw new Error("Ambiguous product identifier; multiple basket lines match");
  return matches[0];
}
/** Numeric product SKU used for availability requests. */
export const productSku = productUid;
