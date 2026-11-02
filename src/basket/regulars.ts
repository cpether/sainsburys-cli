import { productUid } from "../api/basket.js";
import type { Order } from "../api/types.js";

export interface RegularPurchase {
  product_uid: string;
  name: string;
  /** Number of the summarised orders that contained this product. */
  orders: number;
  /** Median quantity across those orders, in `uom`. */
  typical_quantity: number;
  uom: string;
  last_bought: string;
  /** Bought only in the most recent summarised order. */
  new_in_latest: boolean;
  purchases: { order_uid: string; slot_start_time: string; quantity: number; uom: string }[];
}
export interface RegularsSummary {
  orders: { order_uid: string; status: string; slot_start_time: string; item_count: number }[];
  products: RegularPurchase[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2 * 1000) / 1000;
}

/**
 * Purchase frequency across recent orders. Frequency is evidence of a regular,
 * not proof that the household needs it now; callers still check the current basket.
 */
export function summariseRegulars(orders: Order[]): RegularsSummary {
  const sorted = [...orders].sort((a, b) => Date.parse(b.slot_start_time) - Date.parse(a.slot_start_time));
  const latest = sorted[0]?.order_uid;
  const products = new Map<string, RegularPurchase>();
  for (const order of sorted) {
    for (const item of order.order_items) {
      const uid = productUid(item);
      if (!uid) continue;
      let entry = products.get(uid);
      if (!entry) {
        entry = { product_uid: uid, name: typeof item.product?.name === "string" ? item.product.name : "", orders: 0, typical_quantity: 0,
          uom: item.uom, last_bought: order.slot_start_time, new_in_latest: false, purchases: [] };
        products.set(uid, entry);
      }
      // An order can list the same product twice; count the order once and add the quantities.
      const existing = entry.purchases.find(purchase => purchase.order_uid === order.order_uid && purchase.uom === item.uom);
      if (existing) existing.quantity += item.quantity;
      else entry.purchases.push({ order_uid: order.order_uid, slot_start_time: order.slot_start_time, quantity: item.quantity, uom: item.uom });
    }
  }
  for (const entry of products.values()) {
    entry.orders = new Set(entry.purchases.map(purchase => purchase.order_uid)).size;
    // Purchases are newest first, so the latest unit wins.
    const sameUnit = entry.purchases.filter(purchase => purchase.uom === entry.uom).map(purchase => purchase.quantity);
    entry.typical_quantity = median(sameUnit);
    entry.new_in_latest = sorted.length > 1 && entry.orders === 1 && entry.purchases[0]!.order_uid === latest;
  }
  return {
    orders: sorted.map(order => ({ order_uid: order.order_uid, status: order.status, slot_start_time: order.slot_start_time, item_count: order.order_items.length })),
    products: [...products.values()].sort((a, b) => b.orders - a.orders || Date.parse(b.last_bought) - Date.parse(a.last_bought) || a.name.localeCompare(b.name)),
  };
}
