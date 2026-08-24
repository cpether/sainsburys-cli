import type { GroceriesClient } from "../client/http.js";
import type { CustomerProfile, SlotReservation } from "./types.js";

export async function getProfile(client: GroceriesClient): Promise<CustomerProfile> {
  return client.request<CustomerProfile>(
    "/groceries-api/gol-services/customer/v1/customer/profile",
  );
}

export async function getSlotReservation(
  client: GroceriesClient,
  orderUid?: string,
): Promise<SlotReservation | null> {
  const result = await client.request<SlotReservation | null | "">(
    "/groceries-api/gol-services/slot/v1/slot/reservation",
    { query: orderUid ? { order_uid: orderUid } : undefined },
  );
  if (!result || typeof result !== "object" || !("reservation_type" in result)) return null;
  return result;
}
