import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient } from "../src/client/http.js";
import { addItem, getBasket, removeItem, updateItems } from "../src/api/basket.js";
import { getActiveOrderStatus, listOrders } from "../src/api/order.js";
import { getProductsByUid, searchProducts } from "../src/api/product.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const baseUrl = "https://www.sainsburys.co.uk";

function clientWith(responses: Parameters<typeof makeFakeFetch>[0]) {
  const { fetch, calls } = makeFakeFetch(responses);
  const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
  return { c, calls };
}

describe("basket api", () => {
  it("getBasket sends account context and normalizes identifiers", async () => {
    const { c, calls } = clientWith([{ body: { basket_id: 42, items: [{item_uid: 12, quantity: 1, uom: "ea", product: { sku: 9126 }}], total_price: 1, is_in_amend_mode: false } }]);
    const basket = await getBasket(c, { storeNumber: "2168", pickTime: "2026-10-15T12:00:00Z", slotBooked: true });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get("store_number"), "2168");
    assert.equal(url.searchParams.get("slot_booked"), "true");
    assert.equal(url.searchParams.get("calculate"), "true");
    assert.equal(basket.items[0]?.product?.sku, "9126");
    assert.equal(basket.items[0]?.item_uid, "12");
  });
  it("addItem preserves the canonical body shape", async () => {
    const { c, calls } = clientWith([{ status: 204 }]);
    await addItem(c, { storeNumber: "2168" }, { productUid: "8194039" });
    assert.deepEqual(JSON.parse(calls[0]!.body!), {product_uid:"8194039",quantity:1,uom:"ea",selected_catchweight:""});
  });
  it("updates and removals preserve weight selections", async () => {
    const { c, calls } = clientWith([{ status: 204 }, { status: 204 }]);
    await updateItems(c, {storeNumber:"2168"}, [{productUid:"1234",itemUid:"5678",quantity:0.75,uom:"kg",selectedCatchweight:"0.75"}]);
    await removeItem(c, {storeNumber:"2168"}, {productUid:"1234",itemUid:"5678",uom:"kg",selectedCatchweight:"0.75"});
    assert.equal(JSON.parse(calls[0]!.body!).items[0].selected_catchweight, "0.75");
    assert.equal(JSON.parse(calls[1]!.body!).items[0].quantity, 0);
    assert.equal(JSON.parse(calls[1]!.body!).items[0].decreasing_quantity, true);
    assert.equal(JSON.parse(calls[1]!.body!).items[0].uom, "kg");
  });
  it("accepts the observed JSON null basket-write response", async () => {
    const { c } = clientWith([{ body: null }, { body: null }, { body: null }]);
    await addItem(c, {storeNumber:"2168"}, {productUid:"1234"});
    await updateItems(c, {storeNumber:"2168"}, [{productUid:"1234",itemUid:"5678",quantity:2}]);
    await removeItem(c, {storeNumber:"2168"}, {productUid:"1234",itemUid:"5678"});
  });
  it("rejects malformed basket data with the structured response error", async () => {
    const { c } = clientWith([{ body: {items:[]} }]);
    await assert.rejects(getBasket(c,{storeNumber:"2168"}), {name:"ResponseValidationError"});
  });
  it("rejects scalar basket-write acknowledgements as unknown outcomes", async () => {
    const { c } = clientWith([{ body: true }]);
    await assert.rejects(addItem(c,{storeNumber:"2168"},{productUid:"1234"}), {name:"UnknownOutcomeError"});
  });
  it("rejects conflicting numeric product identifiers instead of picking one", async () => {
    let { c } = clientWith([{ body: {basket_id:"1",is_in_amend_mode:false,total_price:2,items:[{item_uid:"2",quantity:1,uom:"ea",product:{sku:"1234",product_uid:"5678"}}]} }]);
    await assert.rejects(getBasket(c,{storeNumber:"2168"}),{name:"ResponseValidationError"});
    ({c}=clientWith([{body:{products:[{product_uid:"1234",sku:"5678",name:"Conflict"}]}}]));
    await assert.rejects(getProductsByUid(c,{uids:["1234"],ctx:{storeIdentifier:"2168"}}),{name:"ResponseValidationError"});
  });
  it("invalid write quantities fail before sending anything", async () => {
    const { c, calls } = clientWith([]);
    for (const quantity of [NaN,Infinity,-1,1.5,100]) await assert.rejects(addItem(c,{storeNumber:"2168"},{productUid:"1234",quantity}));
    await assert.rejects(addItem(c,{storeNumber:"2168"},{productUid:"1234",quantity:0.0001,uom:"kg"}));
    assert.equal(calls.length, 0);
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

  it("getActiveOrderStatus rejects a malformed object", async () => {
    const { c } = clientWith([{ status: 200, body: { foo: 1 } }]);
    await assert.rejects(getActiveOrderStatus(c));
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
