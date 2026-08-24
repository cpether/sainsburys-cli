import type { GroceriesClient } from "../client/http.js";

export interface CouponPromotion {
  value: number;
  description: string;
  expiry_date: string;
  promotion_id: number;
  discount_type: "MONETARY" | string;
  /** True once the coupon is on the active cart. */
  is_already_applied_to_cart: boolean;
  is_same_type_already_in_cart?: boolean;
  user_specific_voucher?: boolean;
  sub_price_promise_voucher?: boolean;
  free_delivery_voucher?: boolean;
  giftcard_voucher?: boolean;
  nectar_voucher?: boolean;
  brand_match_voucher?: boolean;
  occ_coupon?: boolean;
  campaigns?: unknown;
  start_date?: string | null;
  short_description?: string | null;
  sub_description?: string | null;
  cart_coupon_code?: string | null;
  cart_coupon_id?: string | null;
}

export interface Coupon {
  /** User-visible code. */
  code: string;
  /** All the interesting fields are nested under `promotion`, not at the top level. */
  promotion: CouponPromotion;
  error: unknown;
}

export interface CouponListResponse {
  coupons: Coupon[];
}

/**
 * List coupons available on the account (substitution refunds, etc.).
 * Verified shape live 2026-06-08 — fields are nested under `promotion`.
 */
export async function listCoupons(client: GroceriesClient): Promise<CouponListResponse> {
  return client.request<CouponListResponse>(
    "/groceries-api/gol-services/coupon/v1/coupon",
  );
}

export interface ApplyCouponArgs {
  /** Order id from /order/status — for amend flows, this is the draft basket id from /basket. */
  orderId: string;
  /** Numeric promotion id from coupon.promotion.promotion_id. */
  promoId: number | string;
  /** WCS-internal store catalog id. Observed value: 10151 (not the same as the 4-digit store_number). */
  storeId?: string;
  langId?: string;
  /** "A" = apply (default), "R" = remove. */
  taskType?: "A" | "R";
}

/**
 * NOTE: applying a coupon happens via the legacy WebSphere Commerce endpoint
 * `/shop/PromotionCodeManage?taskType=A&orderId=…&promoId=…&storeId=10151&langId=44`,
 * which Akamai's bot-check rejects when called directly from our HTTP client (returns
 * an "enable cookies/JavaScript" HTML fallback). It only works when triggered from a
 * real browser context.
 *
 * The apply is therefore done inside the Playwright-driven checkout flow
 * (`src/checkout/finalise.ts`) by clicking the SPA anchors with id `walletVoucher<CODE>`.
 * No standalone applyCoupon HTTP function exists — see finaliseCheckout for the click
 * sequence.
 */
