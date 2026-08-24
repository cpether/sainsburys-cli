import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient } from "../src/client/http.js";
import { addItem, getBasket, removeItem, updateItems } from "../src/api/basket.js";
import { getActiveOrderStatus, listOrders, startAmend } from "../src/api/order.js";
import { getProductsByUid, searchProducts } from "../src/api/product.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const baseUrl = "https://www.sainsburys.co.uk";

function clientWith(responses: Parameters<typeof makeFakeFetch>[0]) {
  const { fetch, calls } = makeFakeFetch(responses);
  const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
  return { c, calls };
}

describe("basket api", () => {
  it("getBasket sends required query params", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { items: [] } }]);
    await getBasket(c, { storeNumber: "2168", slotBooked: false });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/groceries-api/gol-services/basket/v2/basket");
    assert.equal(url.searchParams.get("store_number"), "2168");
    assert.equal(url.searchParams.get("slot_booked"), "false");
    assert.equal(url.searchParams.get("calculate"), "true");
    assert.match(url.searchParams.get("pick_time") ?? "", /^\d{4}-\d{2}-\d{2}T/);
  });

  it("addItem POSTs the canonical body shape", async () => {
    const { c, calls } = clientWith([{ status: 200, body: {} }]);
    await addItem(c, { storeNumber: "2168" }, { productUid: "8194039" });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(
      new URL(calls[0]!.url).pathname,
      "/groceries-api/gol-services/basket/v2/basket/item",
    );
    const body = JSON.parse(calls[0]!.body!);
    assert.deepEqual(body, {
      product_uid: "8194039",
      quantity: 1,
      uom: "ea",
      selected_catchweight: "",
    });
  });

  it("updateItems PUTs an items array", async () => {
    const { c, calls } = clientWith([{ status: 200, body: null }]);
    await updateItems(c, { storeNumber: "2168" }, [
      { productUid: "7566892", itemUid: "28177740249", quantity: 2 },
    ]);
    assert.equal(calls[0]!.method, "PUT");
    const body = JSON.parse(calls[0]!.body!);
    assert.deepEqual(body, {
      items: [
        {
          product_uid: "7566892",
          quantity: 2,
          uom: "ea",
          selected_catchweight: "",
          item_uid: "28177740249",
        },
      ],
    });
  });

  it("removeItem PUTs quantity 0 with decreasing_quantity flag", async () => {
    const { c, calls } = clientWith([{ status: 200, body: null }]);
    await removeItem(
      c,
      { storeNumber: "2168" },
      { productUid: "8202235", itemUid: "28466370549" },
    );
    const body = JSON.parse(calls[0]!.body!);
    assert.equal(body.items[0].quantity, 0);
    assert.equal(body.items[0].decreasing_quantity, true);
  });
});

describe("order api", () => {
  it("listOrders sends pagination params", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { orders: [] } }]);
    await listOrders(c, { pageSize: 5, pageNumber: 2 });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/groceries-api/gol-services/order/v1/order");
    assert.equal(url.searchParams.get("page_size"), "5");
    assert.equal(url.searchParams.get("page_number"), "2");
  });

  it("getActiveOrderStatus returns null when body empty/non-object", async () => {
    const { c } = clientWith([{ status: 200, body: "" }]);
    const r = await getActiveOrderStatus(c);
    assert.equal(r, null);
  });

  it("getActiveOrderStatus returns null when body lacks order_uid", async () => {
    const { c } = clientWith([{ status: 200, body: { foo: 1 } }]);
    const r = await getActiveOrderStatus(c);
    assert.equal(r, null);
  });

  it("startAmend POSTs to /amend with empty body", async () => {
    const { c, calls } = clientWith([{ status: 200, body: {} }]);
    await startAmend(c, "1281009470");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(
      new URL(calls[0]!.url).pathname,
      "/groceries-api/gol-services/order/v1/order/1281009470/amend",
    );
    assert.equal(calls[0]!.body, "{}");
  });
});

describe("product api", () => {
  it("getProductsByUid joins SKUs with comma and includes context", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { products: [] } }]);
    await getProductsByUid(c, {
      uids: ["7457282", "7659331", "9126"],
      ctx: { storeIdentifier: "2168", slotDate: "2026-04-07", slotType: "delivery" },
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("uids"), "7457282,7659331,9126");
    assert.equal(url.searchParams.get("store_identifier"), "2168");
    assert.equal(url.searchParams.get("slot_type"), "delivery");
    assert.equal(url.searchParams.get("filter[available]"), "true");
  });

  it("searchProducts uses filter[keyword] on /product", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { products: [] } }]);
    await searchProducts(c, {
      keyword: "test keyword",
      ctx: { storeIdentifier: "2168" },
    });
    const url = new URL(calls[0]!.url);
    assert.equal(url.pathname, "/groceries-api/gol-services/product/v1/product");
    assert.equal(url.searchParams.get("filter[keyword]"), "test keyword");
    assert.equal(url.searchParams.get("page_size"), "60");
    assert.equal(url.searchParams.get("page_number"), "1");
  });
});
