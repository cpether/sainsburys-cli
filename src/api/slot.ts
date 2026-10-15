import { record, string, finiteNumber, ValidationError } from "./validation.js";
import type { GroceriesClient } from "../client/http.js";

export interface AvailableSlot {
  /** Opaque base64 token; required as input to bookSlot(). */
  booking_key: string;
  start_time: string;
  end_time: string;
  price?: number;
  is_available?: boolean;
  is_booked_by_customer?: boolean;
  is_green?: boolean;
  is_alcohol_restricted?: boolean;
  is_same_day?: boolean;
  is_delivery_pass_applicable?: boolean;
  is_xmas?: boolean;
  slot_type?: "saver_slot" | "1hour" | string;
  slot_message?: string;
  [key: string]: unknown;
}

export interface SlotsListResponse {
  /** Flat array — each slot has start_time/end_time/booking_key. Verified live 2026-05-25. */
  slots: AvailableSlot[];
  weeks?: unknown[];
  slot_types?: unknown[];
  has_xmas_slots?: boolean;
  postcode?: string;
  address_nickname?: string;
  store_identifier?: string;
}

export interface ListSlotsArgs {
  /** 1 = current week, 2 = next week, etc. Sainsbury's offers ~4 weeks ahead. */
  weekNumber?: number;
  storeIdentifier: string;
  /** Product SKUs in current basket — gates availability per-line. */
  productUids: string[];
  /** "DELIVERY" or "COLLECTION". */
  slotType?: "DELIVERY" | "COLLECTION";
  /**
   * delivery_type array. The SPA sends ["saver_slot","1hour"], but for delivery-pass
   * subscribers saver_slot is irrelevant (4-hour window) — default to ["1hour"] here.
   * Pass ["saver_slot","1hour"] explicitly if you want both.
   */
  deliveryType?: string[];
  isSlotLocked?: boolean;
}

/**
 * List available delivery slots. POSTs the current basket SKUs because per-product
 * availability is part of the response (some items only ship on certain days).
 */
export async function listSlots(
  client: GroceriesClient,
  args: ListSlotsArgs,
): Promise<SlotsListResponse> {
  // This is a POST-shaped GET — the product_uids list is too long for query params,
  // so the SPA POSTs the body but signals semantic GET with X-HTTP-Method-Override.
  // Without that header the BFF returns 400 HUMAN_VERIFICATION_FAILED.
  return client.request<SlotsListResponse>(
    "/groceries-api/gol-services/slot/v2/slots",
    {
      method: "POST",
      semanticRead: true,
      validate: value => {
        const r=record(value);
        if(!Array.isArray(r.slots)) throw new ValidationError("Invalid slots");
        for(const value of r.slots){const s=record(value);string(s.booking_key);for(const k of ["start_time","end_time"]){if(typeof s[k]!=="string" || !Number.isFinite(Date.parse(s[k] as string)))throw new ValidationError("Invalid slot datetime");}if(s.price!==undefined)finiteNumber(s.price);}
        return r as unknown as SlotsListResponse;
      },
      headers: { "x-http-method-override": "GET" },
      body: {
        week_number: args.weekNumber ?? 1,
        slot_type: args.slotType ?? "DELIVERY",
        product_uids: args.productUids,
        is_slot_locked: args.isSlotLocked ?? false,
        store_identifier: args.storeIdentifier,
        delivery_type: args.deliveryType ?? ["1hour"],
      },
    },
  );
}
