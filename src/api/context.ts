import type { GroceriesClient } from "../client/http.js";
import type { BasketContext } from "./basket.js";
import type { ProductQueryContext } from "./product.js";
import { getProfile, getSlotReservation } from "./customer.js";
import { ValidationError } from "./validation.js";

export interface ShoppingContext {
  basketContext: BasketContext;
  productContext: ProductQueryContext;
  reservationId: string | null;
  source: "override" | "reservation" | "account";
}
export async function resolveShoppingContext(client: GroceriesClient, override?: string): Promise<ShoppingContext> {
  const profile = await getProfile(client);
  const reservation = await getSlotReservation(client);
  const accountStore = profile.store_identifier ?? profile.store_number ?? profile.home_store_number;
  const store = override ?? reservation?.store_identifier ?? accountStore;
  if ((typeof store !== "string" && typeof store !== "number") || !/^\d{4}$/.test(String(store))) {
    throw new ValidationError("Store is unknown; compare the website and provide --store or SAINSBURYS_STORE_NUMBER");
  }
  const active = !!reservation?.slot && !reservation.is_expired && Date.parse(reservation.slot.end_time) > Date.now() &&
    (!reservation.reserved_until || Date.parse(reservation.reserved_until) > Date.now());
  const pickTime = active ? reservation!.slot!.start_time : undefined;
  const type = reservation?.reservation_type.toLowerCase();
  if (active && type !== "delivery" && type !== "collection") throw new ValidationError("Unknown reservation type");
  return {
    basketContext: { storeNumber: String(store), slotBooked: active, ...(pickTime ? {pickTime} : {}) },
    productContext: { storeIdentifier: String(store), ...(active ? {slotDate:pickTime!.slice(0,10),slotDatetime:pickTime,slotType:type as "delivery"|"collection"}:{}), flexiStores: reservation?.flexi_stores, region: reservation?.region },
    reservationId: active ? reservation!.slot!.reservation_id : null,
    source: override ? "override" : reservation?.store_identifier ? "reservation" : "account",
  };
}
