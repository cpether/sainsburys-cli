import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient } from "../src/client/http.js";
import { listSlots } from "../src/api/slot.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const baseUrl = "https://www.sainsburys.co.uk";

function clientWith(responses: Parameters<typeof makeFakeFetch>[0]) {
  const { fetch, calls } = makeFakeFetch(responses);
  const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
  return { c, calls };
}

describe("slot api", () => {
  it("listSlots POSTs the canonical body shape", async () => {
    const { c, calls } = clientWith([{ status: 200, body: { slots: [] } }]);
    await listSlots(c, {
      weekNumber: 1,
      storeIdentifier: "2168",
      productUids: ["7457282", "9126"],
    });
    assert.equal(calls[0]!.method, "POST");
    assert.equal(
      new URL(calls[0]!.url).pathname,
      "/groceries-api/gol-services/slot/v2/slots",
    );
    // The endpoint is a POST-shaped GET; without the override header the BFF returns 400.
    assert.equal(calls[0]!.headers["x-http-method-override"], "GET");
    const body = JSON.parse(calls[0]!.body!);
    assert.deepEqual(body, {
      week_number: 1,
      slot_type: "DELIVERY",
      product_uids: ["7457282", "9126"],
      is_slot_locked: false,
      store_identifier: "2168",
      delivery_type: ["1hour"],
    });
  });

});
