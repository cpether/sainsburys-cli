import type { GroceriesClient } from "../client/http.js";
import type { CustomerProfile, SlotReservation } from "./types.js";
import { record, identifier, string, boolean, finiteNumber, ValidationError } from "./validation.js";

export function parseProfile(value: unknown): CustomerProfile {
  const outer = record(value);
  const p = outer.customer === undefined ? outer : record(outer.customer);
  if (p.email === undefined && p.email_address !== undefined) p.email = p.email_address;
  const user_id = identifier(p.user_id);
  if (p.email !== undefined) string(p.email);
  return { ...p, user_id } as CustomerProfile;
}

export async function getProfile(client: GroceriesClient): Promise<CustomerProfile> {
  const result = await client.request("/groceries-api/gol-services/customer/v1/customer/profile", { validate: parseProfile });
  if (result.user_id !== client.getSession().userId) throw new ValidationError("Account identity differs from the cached session; log out and log in again");
  return result;
}

export function parseReservation(value: unknown): SlotReservation | null {
  if (value === undefined || value === null || value === "") return null;
  const r = record(value);
  const reservation_type = string(r.reservation_type);
  const is_expired = boolean(r.is_expired);
  if (r.store_identifier !== undefined) r.store_identifier = identifier(r.store_identifier);
  if (r.region !== undefined) string(r.region);
  if (r.flexi_stores !== undefined && (!Array.isArray(r.flexi_stores) || !r.flexi_stores.every(x => typeof x === "string" && /^\d{4}$/.test(x)))) throw new ValidationError("Invalid flexi stores");
  if (r.slot !== undefined && r.slot !== null) {
    const slot = record(r.slot);
    for (const field of ["start_time", "end_time"]) {
      if (typeof slot[field] !== "string" || !Number.isFinite(Date.parse(slot[field] as string))) throw new ValidationError("Invalid reservation datetime");
    }
    if (Date.parse(slot.end_time as string) <= Date.parse(slot.start_time as string)) throw new ValidationError("reservation time range");
    string(slot.reservation_id); string(slot.booking_key); string(slot.slot_type);
    if (finiteNumber(slot.price) < 0) throw new ValidationError("Invalid slot price");
  }
  if (r.reserved_until !== undefined && (typeof r.reserved_until !== "string" || !Number.isFinite(Date.parse(r.reserved_until)))) throw new ValidationError("Invalid reservation expiry");
  return { ...r, reservation_type, is_expired } as unknown as SlotReservation;
}

export async function getSlotReservation(client: GroceriesClient, orderUid?: string): Promise<SlotReservation | null> {
  return client.request("/groceries-api/gol-services/slot/v1/slot/reservation", {
    query: orderUid ? { order_uid: orderUid } : undefined,
    allowEmpty: true,
    validate: parseReservation,
  });
}
