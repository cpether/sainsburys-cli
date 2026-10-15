import type { GroceriesClient } from "../client/http.js";
import type { Order, OrderListResponse, OrderStatus } from "./types.js";
import { record, identifier, boolean, finiteNumber, string } from "./validation.js";
const BASE = "/groceries-api/gol-services/order/v1/order";

export function parseOrderStatus(value: unknown): OrderStatus | null {
  if (value === undefined || value === null || value === "") return null;
  const r = record(value);
  const order_uid = identifier(r.order_uid);
  const is_in_amend_mode = boolean(r.is_in_amend_mode);
  const is_cutoff = boolean(r.is_cutoff);
  if (r.total !== undefined) finiteNumber(r.total);
  return { ...r, order_uid, is_in_amend_mode, is_cutoff } as OrderStatus;
}
export async function getActiveOrderStatus(client: GroceriesClient): Promise<OrderStatus | null> {
  try { return await client.request(`${BASE}/status`, {allowEmpty:true, validate:parseOrderStatus}); }
  catch (err) { if (err instanceof Error && "status" in err && err.status === 404) return null; throw err; }
}
// Retained read-only API knowledge; no amendment or payment implementation is shipped.
export async function listOrders(client: GroceriesClient, args: {pageSize?:number;pageNumber?:number} = {}): Promise<OrderListResponse> {
  return client.request(BASE, {query:{page_size:args.pageSize??10,page_number:args.pageNumber??1}, validate:value=>{
    const r=record(value); if(!Array.isArray(r.orders)) throw new Error("Invalid order list");
    const orders=r.orders.map(v=>{const o=record(v);identifier(o.order_uid);string(o.status);finiteNumber(o.total);return o;});
    return {...r,orders} as unknown as OrderListResponse;
  }});
}
export async function getOrder(client: GroceriesClient, orderId:string, opts:{placed?:boolean;deliveryPass?:boolean}={}):Promise<Order>{
  return client.request(`${BASE}/${encodeURIComponent(orderId)}`,{query:{placed:opts.placed??true,deliveryPass:opts.deliveryPass??false},validate:value=>{
    const r=record(value);identifier(r.order_uid);string(r.status);finiteNumber(r.total);if(!Array.isArray(r.order_items))throw new Error("Invalid order items");return r as unknown as Order;
  }});
}
