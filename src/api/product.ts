import type { GroceriesClient } from "../client/http.js";
import type { ProductListResponse } from "./types.js";

const BASE = "/groceries-api/gol-services/product/v1/product";

export interface ProductQueryContext {
  storeIdentifier: string;
  slotDate?: string;
  slotDatetime?: string;
  slotType?: "delivery" | "collection";
  flexiStores?: string[];
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
    query: {
      "filter[keyword]": args.keyword,
      page_size: args.pageSize ?? 60,
      page_number: args.pageNumber ?? 1,
      sort_order: "FAVOURITES_FIRST",
      store_identifier: args.ctx.storeIdentifier,
      flexi_stores: args.ctx.flexiStores?.join(",") ?? "2168",
      region: "England",
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
    { query: { search } },
  );
  if (Array.isArray(result)) return result;
  return result?.suggestions ?? [];
}
