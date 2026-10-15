import type { GroceriesClient } from "../client/http.js";
import { record, identifier, string, finiteNumber, ValidationError } from "./validation.js";
import type { ProductListResponse } from "./types.js";

const BASE = "/groceries-api/gol-services/product/v1/product";

export interface ProductQueryContext {
  storeIdentifier: string;
  slotDate?: string;
  slotDatetime?: string;
  slotType?: "delivery" | "collection";
  flexiStores?: string[];
  region?: string;
}

function ctxQuery(ctx: ProductQueryContext): Record<string, string | undefined> {
  return {
    store_identifier: ctx.storeIdentifier,
    slot_date: ctx.slotDate,
    slot_datetime: ctx.slotDatetime,
    slot_type: ctx.slotType,
    flexi_stores: ctx.flexiStores?.join(",") ?? undefined,
  };
}

export interface GetByUidArgs {
  uids: string[];
  ctx: ProductQueryContext;
  available?: boolean;
  minimised?: boolean;
}

export async function getProductsByUid(
  client: GroceriesClient,
  args: GetByUidArgs,
): Promise<ProductListResponse> {
  return client.request<ProductListResponse>(BASE, {
    validate: parseProducts,
    query: {
      uids: args.uids.join(","),
      "filter[available]": args.available ?? true,
      "include[MAIN_CATEGORIES]": true,
      "include[DIETARY_PROFILE]": true,
      "include[REPLACEMENT_PRODUCTS]": true,
      minimised: args.minimised ?? false,
      ...ctxQuery(args.ctx),
    },
  });
}

export interface SearchArgs {
  keyword: string;
  ctx: ProductQueryContext;
  pageSize?: number;
  pageNumber?: number;
  available?: boolean;
  minimised?: boolean;
}

export async function searchProducts(
  client: GroceriesClient,
  args: SearchArgs,
): Promise<ProductListResponse> {
  // Keyword search uses a different param set than bulk-by-uid lookup — the SPA sends
  // store/region/flexi/salesWindow but NOT slot_date / slot_datetime / slot_type
  // (those gate the bulk lookup, not the search index).
  return client.request<ProductListResponse>(BASE, {
    validate: parseProducts,
    query: {
      "filter[keyword]": args.keyword,
      page_size: args.pageSize ?? 60,
      page_number: args.pageNumber ?? 1,
      sort_order: "FAVOURITES_FIRST",
      store_identifier: args.ctx.storeIdentifier,
      flexi_stores: args.ctx.flexiStores?.join(",") ?? undefined,
      region: args.ctx.region,
      salesWindow: 1,
      citrus_max_number_ads: 0,
    },
  });
}

export async function searchSuggestions(
  client: GroceriesClient,
  search: string,
): Promise<string[]> {
  const result = await client.request<string[] | { suggestions?: string[] }>(
    `${BASE}/search/suggestions`,
    { query: { search }, validate: value => {
      const suggestions = Array.isArray(value) ? value : record(value).suggestions;
      if (!Array.isArray(suggestions) || !suggestions.every(x => typeof x === "string")) throw new ValidationError("Invalid suggestions");
      return suggestions;
    } },
  );
  if (Array.isArray(result)) return result;
  return result?.suggestions ?? [];
}

export function parseProducts(value: unknown): ProductListResponse {
  const r = record(value);
  if (!Array.isArray(r.products)) throw new ValidationError("Invalid products response");
  const products = r.products.map(value => {
    const p = record(value);
    const product_uid = identifier(p.product_uid ?? p.sku);
    if (!/^\d+$/.test(product_uid)) throw new ValidationError("Invalid product SKU");
    if (p.sku !== undefined && identifier(p.sku) !== product_uid) throw new ValidationError("conflicting product SKUs");
    const name = string(p.name);
    if (p.is_available !== undefined && typeof p.is_available !== "boolean") throw new ValidationError("Invalid availability");
    if (p.retail_price !== undefined) {
      const price = record(p.retail_price);
      if (finiteNumber(price.price) < 0) throw new ValidationError("Invalid product price");
    }
    if (p.unit_price !== undefined) {
      const unit = record(p.unit_price);
      if (finiteNumber(unit.price) < 0) throw new ValidationError("product unit price");
      string(unit.measure); finiteNumber(unit.measure_amount);
    }
    return { ...p, product_uid, name };
  });
  if (r.controls !== undefined) {
    const controls = record(r.controls);
    if (controls.total_record_count !== undefined && finiteNumber(controls.total_record_count) < 0) throw new ValidationError("product count");
  }
  return { ...r, products } as ProductListResponse;
}
