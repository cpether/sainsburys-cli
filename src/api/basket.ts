import type { GroceriesClient } from "../client/http.js";
import type { Basket, BasketItem } from "./types.js";

export interface BasketContext {
  pickTime?: string;
  storeNumber: string;
  slotBooked?: boolean;
}

const BASE = "/groceries-api/gol-services/basket/v2/basket";

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function basketQuery(ctx: BasketContext, extra: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    pick_time: ctx.pickTime ?? isoNow(),
    store_number: ctx.storeNumber,
    slot_booked: ctx.slotBooked ?? false,
    ...extra,
  };
}

export async function getBasket(client: GroceriesClient, ctx: BasketContext): Promise<Basket> {
  return client.request<Basket>(BASE, {
    query: basketQuery(ctx, { calculate: true }),
  });
}

export interface AddItemArgs {
  productUid: string;
  quantity?: number;
  uom?: string;
  selectedCatchweight?: string;
}

export async function addItem(
  client: GroceriesClient,
  ctx: BasketContext,
  args: AddItemArgs,
): Promise<void> {
  await client.request<void>(`${BASE}/item`, {
    method: "POST",
    query: basketQuery(ctx),
    body: {
      product_uid: args.productUid,
      quantity: args.quantity ?? 1,
      uom: args.uom ?? "ea",
      selected_catchweight: args.selectedCatchweight ?? "",
    },
  });
}

export interface UpdateItemArgs {
  productUid: string;
  itemUid: string;
  quantity: number;
  uom?: string;
  selectedCatchweight?: string;
  /** present in the SPA when going down. Optional but mirrored. */
  decreasingQuantity?: boolean;
}

export async function updateItems(
  client: GroceriesClient,
  ctx: BasketContext,
  items: UpdateItemArgs[],
): Promise<Basket | void> {
  return client.request<Basket | void>(BASE, {
    method: "PUT",
    query: basketQuery(ctx),
    body: {
      items: items.map((i) => {
        const body: Record<string, unknown> = {
          product_uid: i.productUid,
          quantity: i.quantity,
          uom: i.uom ?? "ea",
          selected_catchweight: i.selectedCatchweight ?? "",
          item_uid: i.itemUid,
        };
        if (i.decreasingQuantity) body.decreasing_quantity = true;
        return body;
      }),
    },
  });
}

/** Delete = update to qty 0. The backend removes the line. */
export async function removeItem(
  client: GroceriesClient,
  ctx: BasketContext,
  args: { productUid: string; itemUid: string; uom?: string },
): Promise<Basket | void> {
  return updateItems(client, ctx, [
    {
      productUid: args.productUid,
      itemUid: args.itemUid,
      quantity: 0,
      uom: args.uom,
      decreasingQuantity: true,
    },
  ]);
}

/**
 * Find a basket line by product SKU. The user-facing SKU can be either the numeric
 * `product_uid` (e.g. "9126") or the 8-char alphanumeric `sain_id` (e.g. "5mhzwp13").
 *
 * Quirk: the basket GET response does NOT carry `product_uid` at all — only `sain_id`.
 * If the caller passes a numeric SKU and we can't match, the caller must look up the
 * product first to translate numeric → sain_id (see `findItemBySkuViaLookup`).
 */
export function findItemBySku(basket: Basket, sku: string): BasketItem | undefined {
  return basket.items.find(
    (i) => i.sain_id === sku || i.product?.product_uid === sku || i.product_uid === sku,
  );
}

/**
 * Resolve a numeric SKU to a sain_id by hitting the product endpoint, then find the
 * matching basket line. Returns undefined if either the product or its basket line
 * can't be found.
 */
export async function findItemBySkuViaLookup(
  client: import("../client/http.js").GroceriesClient,
  basket: Basket,
  sku: string,
  storeNumber: string,
): Promise<BasketItem | undefined> {
  const direct = findItemBySku(basket, sku);
  if (direct) return direct;
  // Look up the product to learn its sain_id.
  const res = await client.request<{ products: { product_uid?: string; sainId?: string }[] }>(
    "/groceries-api/gol-services/product/v1/product",
    { query: { uids: sku, store_identifier: storeNumber, minimised: true } },
  );
  const sainId = res.products?.[0]?.sainId;
  if (!sainId) return undefined;
  return basket.items.find((i) => i.sain_id === sainId);
}
