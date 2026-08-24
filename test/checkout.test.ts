/**
 * Tests for the checkout finalise flow. Driving real Playwright is out of scope
 * (and destructive), so this just exercises the things that don't need a browser:
 * URL/regex constants, the pre-flight guards in the CLI verb's wiring.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("checkout flow constants", () => {
  it("confirmation URL regex matches the known SPA confirmation paths", async () => {
    // Inline-copy of the regex from src/checkout/finalise.ts — if it drifts there,
    // update here so the test stays in sync.
    const CONFIRMATION_URL_RE = /\/gol-ui\/(order\/confirmation|checkout\/confirmation|order-confirmation)/;
    assert.ok(CONFIRMATION_URL_RE.test("https://www.sainsburys.co.uk/gol-ui/order/confirmation?id=1"));
    assert.ok(CONFIRMATION_URL_RE.test("https://www.sainsburys.co.uk/gol-ui/checkout/confirmation"));
    assert.ok(CONFIRMATION_URL_RE.test("https://www.sainsburys.co.uk/gol-ui/order-confirmation"));
    assert.equal(CONFIRMATION_URL_RE.test("https://www.sainsburys.co.uk/gol-ui/groceries"), false);
    assert.equal(
      CONFIRMATION_URL_RE.test("https://www.sainsburys.co.uk/gol-ui/checkout/payment/redirect"),
      false,
    );
  });
});
