import { record, string, finiteNumber, boolean, ValidationError } from "./validation.js";
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
    { validate: value => {
      const r=record(value);
      if(!Array.isArray(r.coupons)) throw new ValidationError("Invalid coupons response");
      for(const value of r.coupons){const c=record(value);string(c.code);const p=record(c.promotion);finiteNumber(p.value);boolean(p.is_already_applied_to_cart);}
      return r as unknown as CouponListResponse;
    } },
  );
}
