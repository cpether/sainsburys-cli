import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroceriesClient, AuthError, ApiError } from "../src/client/http.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const baseUrl = "https://www.sainsburys.co.uk";

describe("GroceriesClient.buildUrl", () => {
  it("merges path against baseUrl and serialises query params", () => {
    const { fetch } = makeFakeFetch();
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const url = c.buildUrl("/groceries-api/x", {
      a: 1,
      b: "two words",
      c: undefined,
      d: true,
    });
    assert.match(url, /^https:\/\/www\.sainsburys\.co\.uk\/groceries-api\/x\?/);
    assert.match(url, /a=1/);
    assert.match(url, /b=two\+words|b=two%20words/); // either is fine
    assert.match(url, /d=true/);
    assert.doesNotMatch(url, /\bc=/);
  });

  it("supports array query values (repeated key)", () => {
    const { fetch } = makeFakeFetch();
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const url = c.buildUrl("/x", { tag: ["a", "b", "c"] });
    const u = new URL(url);
    assert.deepEqual(u.searchParams.getAll("tag"), ["a", "b", "c"]);
  });
});

describe("GroceriesClient.buildHeaders", () => {
  it("includes wcauthtoken, Bearer JWT, cookie, content-type and SPA UA headers", () => {
    const { fetch } = makeFakeFetch();
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const h = c.buildHeaders();
    assert.equal(h.get("wcauthtoken"), "123456789%2CAbCdEfGhIjKlMnOpQrStUvWxYz0%3D");
    assert.equal(h.get("authorization"), "Bearer test-jwt-abc.def.ghi");
    assert.match(h.get("cookie") ?? "", /^WC_AUTHENTICATION_123456789=/);
    assert.equal(h.get("content-type"), "application/json");
    assert.equal(h.get("accept"), "application/json");
    assert.equal(h.get("origin"), baseUrl);
    assert.equal(h.get("user-agent"), "TestAgent/1.0");
    assert.ok((h.get("enabled-feature-flags") ?? "").length > 100);
  });

  it("merges extra headers, allowing overrides", () => {
    const { fetch } = makeFakeFetch();
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const h = c.buildHeaders({ "x-custom": "yes", "user-agent": "Override/1.0" });
    assert.equal(h.get("x-custom"), "yes");
    assert.equal(h.get("user-agent"), "Override/1.0");
  });
});

describe("GroceriesClient.request", () => {
  it("returns parsed JSON on 200", async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200, body: { ok: true } }]);
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const res = await c.request<{ ok: boolean }>("/x");
    assert.deepEqual(res, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");
  });

  it("returns undefined on 204 with no body", async () => {
    const { fetch } = makeFakeFetch([{ status: 204, body: undefined }]);
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    const res = await c.request<unknown>("/x");
    assert.equal(res, undefined);
  });

  it("throws ApiError with body on non-2xx (non-auth)", async () => {
    const { fetch } = makeFakeFetch([{ status: 500, body: { code: "OOPS" } }]);
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    await assert.rejects(
      () => c.request("/x"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 500);
        assert.deepEqual(err.body, { code: "OOPS" });
        return true;
      },
    );
  });

  it("retries once with reauth on 401, then succeeds", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 401, body: { error: "expired" } },
      { status: 200, body: { ok: 1 } },
    ]);
    let reauthCalls = 0;
    const c = new GroceriesClient({
      session: fakeSession(),
      baseUrl,
      fetchImpl: fetch,
      reauth: async () => {
        reauthCalls++;
        return fakeSession({ wcauthtoken: "newtoken" });
      },
    });
    const res = await c.request<{ ok: number }>("/x");
    assert.deepEqual(res, { ok: 1 });
    assert.equal(reauthCalls, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.headers["wcauthtoken"], "newtoken");
  });

  it("throws AuthError on 401 if no reauth configured", async () => {
    const { fetch } = makeFakeFetch([{ status: 401, body: {} }]);
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    await assert.rejects(
      () => c.request("/x"),
      (err: unknown) => err instanceof AuthError && (err as AuthError).status === 401,
    );
  });

  it("does not retry forever — second 401 surfaces as AuthError", async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 401, body: {} },
      { status: 401, body: {} },
    ]);
    const c = new GroceriesClient({
      session: fakeSession(),
      baseUrl,
      fetchImpl: fetch,
      reauth: async () => fakeSession(),
    });
    await assert.rejects(() => c.request("/x"), AuthError);
    assert.equal(calls.length, 2);
  });

  it("serialises body as JSON for POST", async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200, body: {} }]);
    const c = new GroceriesClient({ session: fakeSession(), baseUrl, fetchImpl: fetch });
    await c.request("/x", { method: "POST", body: { a: 1 } });
    assert.equal(calls[0]?.body, '{"a":1}');
    assert.equal(calls[0]?.headers["content-type"], "application/json");
  });
});
