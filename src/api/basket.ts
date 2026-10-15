import type { GroceriesClient } from "../client/http.js";
import type { Basket, BasketItem } from "./types.js";

export interface BasketContext {
  pickTime?: string;
  storeNumber: string;
  slotBooked?: boolean;
}
const BASE = "/groceries-api/gol-services/basket/v2/basket";

export function normalizeIdentifier(value: unknown, label = "identifier"): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) return value;
  throw new Error(`Invalid ${label}`);
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
  return [item.product?.sku, item.product?.product_uid, item.product_uid, item.sain_id, item.product?.sainId, item.product?.sain_id, item.item_uid]
    .filter((v) => v !== undefined).map((v) => normalizeIdentifier(v));
}

export function productUid(item: BasketItem): string | undefined {
  return [item.product?.sku, item.product?.product_uid, item.product_uid]
    .map((v) => v === undefined ? undefined : normalizeIdentifier(v))
    .find((v) => v !== undefined && /^\d+$/.test(v));
}

function basketQuery(ctx: BasketContext, extra: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  if (!/^\d+$/.test(ctx.storeNumber)) throw new Error("A valid account store number is required");
  if (ctx.pickTime !== undefined && !Number.isFinite(Date.parse(ctx.pickTime))) throw new Error("Invalid basket pick time");
  return { pick_time: ctx.pickTime ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), store_number: ctx.storeNumber, slot_booked: ctx.slotBooked ?? false, ...extra };
}

export async function getBasket(client: GroceriesClient, ctx: BasketContext): Promise<Basket> {
  return normalizeBasket(await client.request<unknown>(BASE, { query: basketQuery(ctx, { calculate: true }) }));
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

/** Low-level protocol operation. Agent CLI mutations must use the approved-plan workflow. */
export async function addItem(client: GroceriesClient, ctx: BasketContext, args: AddItemArgs): Promise<void> {
  const body = writeValues(args);
  if (!body.quantity) throw new Error("Adding zero quantity is invalid");
  await client.request<unknown>(`${BASE}/item`, { method: "POST", query: basketQuery(ctx), body, allowEmpty: true });
}
export interface UpdateItemArgs extends AddItemArgs { itemUid: string; quantity: number; decreasingQuantity?: boolean }
export async function updateItems(client: GroceriesClient, ctx: BasketContext, items: UpdateItemArgs[]): Promise<void> {
  if (!items.length) throw new Error("No basket updates supplied");
  const body = { items: items.map((i) => ({ ...writeValues(i), item_uid: normalizeIdentifier(i.itemUid, "basket line ID"), ...(i.decreasingQuantity ? { decreasing_quantity: true } : {}) })) };
  await client.request<unknown>(BASE, { method: "PUT", query: basketQuery(ctx), body, allowEmpty: true });
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
export async function findItemBySkuViaLookup(client: GroceriesClient, basket: Basket, sku: string, storeNumber: string): Promise<BasketItem | undefined> {
  const direct = findItemBySku(basket, sku);
  if (direct) return direct;
  const res = await client.request<{ products: Record<string, unknown>[] }>("/groceries-api/gol-services/product/v1/product", { query: { uids: normalizeIdentifier(sku), store_identifier: storeNumber, minimised: true } });
  if (!res || !Array.isArray(res.products)) throw new Error("Invalid product lookup response");
  const p = res.products[0];
  const sainId = p?.sainId ?? p?.sain_id;
  return sainId === undefined ? undefined : findItemBySku(basket, normalizeIdentifier(sainId));
}

/** Numeric product SKU used for availability requests. */
export const productSku = productUid;
