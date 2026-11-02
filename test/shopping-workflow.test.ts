import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient } from "../src/client/http.js";
import { looseEstimate, lookupProducts, withDerived } from "../src/api/product.js";
import { summariseRegulars } from "../src/basket/regulars.js";
import type { Order, Product } from "../src/api/types.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const ctx = { storeIdentifier: "2168", slotDate: "2026-11-01", slotType: "delivery" as const };
function clientWith(responses: Parameters<typeof makeFakeFetch>[0]) {
  const { fetch, calls } = makeFakeFetch(responses);
  return { c: new GroceriesClient({ session: fakeSession(), baseUrl: "https://www.sainsburys.co.uk", fetchImpl: fetch }), calls };
}

describe("product lookup explains missing SKUs", () => {
  it("separates products unavailable for the slot from SKUs the catalogue no longer returns", async () => {
    const { c, calls } = clientWith([
      { status: 200, body: { products: [{ product_uid: "111", name: "Bananas", retail_price: { price: 1.9, measure: "ea" } }] } },
      { status: 200, body: { products: [{ product_uid: "222", name: "Broccoli", is_available: false }] } },
    ]);
    const result = await lookupProducts(c, { uids: ["111", "222", "333"], ctx });
    assert.deepEqual(result.products.map(p => p.product_uid), ["111"]);
    assert.deepEqual(result.unavailable, [{ product_uid: "222", name: "Broccoli" }]);
    assert.deepEqual(result.not_found, ["333"]);
    const second = new URL(calls[1]!.url);
    assert.equal(second.searchParams.get("uids"), "222,333");
    assert.equal(second.searchParams.get("filter[available]"), "false");
  });

  it("makes one request when every SKU resolves", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { products: [{ product_uid: "111", name: "Bananas" }] } }]);
    const result = await lookupProducts(c, { uids: ["111"], ctx });
    assert.equal(calls.length, 1);
    assert.deepEqual([result.unavailable, result.not_found], [[], []]);
  });

  it("reports every SKU as not found when nothing resolves", async () => {
    const { c } = clientWith([{ status: 200, body: { products: [] } }, { status: 200, body: { products: [] } }]);
    const result = await lookupProducts(c, { uids: ["7575577"], ctx });
    assert.deepEqual([result.products, result.unavailable, result.not_found], [[], [], ["7575577"]]);
  });
});

describe("loose produce estimates", () => {
  const loose = (average_weight?: unknown): Product => ({ product_uid: "1", name: "Loose broccoli", retail_price: { price: 2.39, measure: "kg" }, average_weight });

  it("estimates the price of one item from the catalogue's average weight", () => {
    assert.deepEqual(looseEstimate(loose({ amount: 0.2, measure: "kg" })), { sold_by: "kg", average_item_kg: 0.2, estimated_item_price: 0.48 });
    assert.deepEqual(looseEstimate(loose({ amount: 350, measure: "g" })), { sold_by: "kg", average_item_kg: 0.35, estimated_item_price: 0.84 });
  });

  it("marks kg products without a usable weight and leaves counted products alone", () => {
    assert.deepEqual(looseEstimate(loose()), { sold_by: "kg" });
    assert.deepEqual(looseEstimate(loose({ amount: -1, measure: "kg" })), { sold_by: "kg" });
    const counted: Product = { product_uid: "2", name: "Bananas", retail_price: { price: 1.9, measure: "ea" } };
    assert.equal(looseEstimate(counted), undefined);
    assert.equal(withDerived([counted])[0], counted);
    assert.deepEqual(withDerived([loose({ amount: 0.2, measure: "kg" })])[0]!.derived, { sold_by: "kg", average_item_kg: 0.2, estimated_item_price: 0.48 });
  });
});

describe("regular purchase summary", () => {
  const item = (sku: string, name: string, quantity: number, uom = "ea") => ({ quantity, uom, product: { product_uid: sku, name } as Product });
  const order = (order_uid: string, day: string, items: ReturnType<typeof item>[]): Order => ({
    order_uid, status: "previous", order_type: "delivery", slot_start_time: `2026-10-${day}T10:00:00Z`, slot_end_time: `2026-10-${day}T11:00:00Z`,
    total: 1, sub_total: 1, address_uid: "a", order_items: items,
  });

  it("counts orders per product, takes the median quantity and flags products new in the latest order", () => {
    const summary = summariseRegulars([
      order("1", "01", [item("100", "Cucumber", 1), item("200", "Chicken", 2), item("300", "Sweet potatoes", 1, "C62")]),
      order("3", "22", [item("100", "Cucumber", 1), item("200", "Chicken", 2), item("400", "Almond butter", 1), item("300", "Sweet potatoes", 1, "kg")]),
      order("2", "16", [item("100", "Cucumber", 2), item("200", "Chicken", 2), item("300", "Sweet potatoes", 0.5, "kg"), item("300", "Sweet potatoes", 0.5, "kg")]),
    ]);
    assert.deepEqual(summary.orders.map(o => o.order_uid), ["3", "2", "1"]);
    const bySku = Object.fromEntries(summary.products.map(p => [p.product_uid, p]));
    assert.deepEqual([bySku["100"]!.orders, bySku["100"]!.typical_quantity, bySku["100"]!.last_bought], [3, 1, "2026-10-22T10:00:00Z"]);
    // Duplicate lines in one order add up; the newest unit is reported.
    assert.deepEqual([bySku["300"]!.orders, bySku["300"]!.uom, bySku["300"]!.typical_quantity], [3, "kg", 1]);
    assert.equal(bySku["400"]!.new_in_latest, true);
    assert.equal(bySku["100"]!.new_in_latest, false);
    assert.deepEqual(summary.products.at(-1)!.product_uid, "400");
  });

  it("does not call anything new when only one order is summarised", () => {
    const summary = summariseRegulars([order("1", "01", [item("100", "Cucumber", 1)])]);
    assert.equal(summary.products[0]!.new_in_latest, false);
  });
});
