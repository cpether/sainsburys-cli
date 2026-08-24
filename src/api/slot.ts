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

export interface BookSlotArgs {
  bookingKey: string;
  /** ISO datetime of the new slot's start time. */
  newSlotDate: string;
  /** Store number ("2168"). */
  newStoreNumber: string;
  changesConfirmed?: boolean;
}

/**
 * Reserve a slot. Used both for fresh bookings and for changing an existing booking
 * (same endpoint, body has new_slot_date + new_store_number to indicate a change).
 *
 * Important: if used on a placed order to change the slot, the order must first be
 * flipped into amend mode via POST /order/{id}/amend, and the amendment confirmed
 * via the checkout flow afterwards (otherwise the slot change isn't committed).
 */
export async function bookSlot(client: GroceriesClient, args: BookSlotArgs): Promise<void> {
  await client.request<void>(
    "/groceries-api/gol-services/slot/v1/slot/reservation",
    {
      method: "POST",
      body: {
        booking_key: args.bookingKey,
        changes_confirmed: args.changesConfirmed ?? false,
        new_slot_date: args.newSlotDate,
        new_store_number: args.newStoreNumber,
      },
    },
  );
}
