import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getActiveResourcesInfo } from "node:process";
import {
  GroceriesClient, RETAILER_ORIGIN, ApiError, AuthError, ResponseValidationError,
  RequestTimeoutError, RequestCancelledError, UnknownOutcomeError,
} from "../src/client/http.js";
import { record, identifier, finiteNumber, boolean, array, string, optional, ValidationError } from "../src/api/validation.js";
import { fakeSession, makeFakeFetch } from "./_helpers.js";

const client = (fetchImpl: typeof fetch, reauth?: () => Promise<ReturnType<typeof fakeSession>>) =>
  new GroceriesClient({ session: fakeSession(), baseUrl: RETAILER_ORIGIN, fetchImpl, reauth });
const responseFetch = (response: Response): typeof fetch => async () => response;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// These tests call the shipped HTTP implementation with dummy credentials. No retailer requests occur.
describe("authenticated request confinement", () => {
  it("rejects non-retailer base URLs before sending credentials", () => {
    for (const baseUrl of ["http://www.sainsburys.co.uk", "https://sainsburys.co.uk", "https://www.sainsburys.co.uk.evil.test", "https://www.sainsburys.co.uk:444", "https://dummy@www.sainsburys.co.uk", `${RETAILER_ORIGIN}/other`]) {
      assert.throws(() => new GroceriesClient({ baseUrl, session: fakeSession() }));
    }
  });

  it("rejects external, credential-bearing and fragment URLs before fetch", async () => {
    let calls = 0;
    const c = client(async () => { calls++; return json({}); });
    for (const path of ["https://evil.test/x", "//evil.test/x", "http://www.sainsburys.co.uk/x", "https://dummy@www.sainsburys.co.uk/x", "/x#secret", "https://www.sainsburys.co.uk.evil.test/x", "\\\\evil.test\\x"]) {
      await assert.rejects(c.request(path));
    }
    assert.equal(calls, 0);
    assert.equal(c.buildUrl(`${RETAILER_ORIGIN}/x`), `${RETAILER_ORIGIN}/x`);
  });

  it("uses manual redirect mode and refuses every redirect without another request", async () => {
    let calls = 0;
    const c = client(async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(null, { status: 302, headers: { location: "https://evil.test" } });
    });
    await assert.rejects(c.request("/x"), ResponseValidationError);
    assert.equal(calls, 1);
  });

  it("rejects a fetch adapter that followed an unsafe URL", async () => {
    const response = json({});
    Object.defineProperty(response, "url", { value: "https://evil.test" });
    await assert.rejects(client(responseFetch(response)).request("/x"), ResponseValidationError);
  });

  it("redacts invalid cached authentication and custom header values", async () => {
    const c = new GroceriesClient({ session: fakeSession({ userAgent: "dummy-password\ninvalid" }), baseUrl: RETAILER_ORIGIN });
    await assert.rejects(c.request("/x"), (error: unknown) => error instanceof AuthError && !String(error).includes("dummy-password"));
    assert.throws(() => client(async () => json({})).buildHeaders({ "x-custom": "dummy-password\ninvalid" }), (error: unknown) => error instanceof Error && !String(error).includes("dummy-password"));
  });

  it("rejects overrides of authentication and origin headers", () => {
    const c = client(async () => json({}));
    for (const header of ["cookie", "Authorization", "wcauthtoken", "origin", "referer", "host"]) {
      assert.throws(() => c.buildHeaders({ [header]: "dummy" }));
    }
  });

  it("does not send fixed Linux/Chromium hints alongside a captured Mac user agent", async () => {
    const { fetch, calls } = makeFakeFetch([{ body: {} }]);
    const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36";
    const c = new GroceriesClient({ session: fakeSession({ userAgent }), baseUrl: RETAILER_ORIGIN, fetchImpl: fetch });
    await c.request("/groceries-api/gol-services/customer/v1/customer/profile");
    assert.equal(calls[0]?.headers["user-agent"], userAgent);
    assert.equal(calls[0]?.headers["sec-ch-ua-platform"], undefined);
    assert.equal(calls[0]?.headers["sec-ch-ua"], undefined);
  });
});

describe("bounded requests and cancellation", () => {
  it("enforces its deadline even when fetch ignores the abort signal", async () => {
    let observedSignal: AbortSignal | null | undefined;
    const c = client(async (_url, init) => { observedSignal = init?.signal; return new Promise<Response>(() => {}); });
    const started = Date.now();
    await assert.rejects(c.request("/x", { timeoutMs: 20 }), RequestTimeoutError);
    assert.equal(observedSignal?.aborted, true);
    assert.ok(Date.now() - started < 1000);
  });

  it("bounds response-body reads and cancels their stream", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
    await assert.rejects(client(responseFetch(response)).request("/x", { timeoutMs: 20 }), RequestTimeoutError);
    assert.equal(cancelled, true);
  });

  it("honors cancellation before fetch and while fetch is pending without exposing abort reasons", async () => {
    let calls = 0;
    const c = client(async () => { calls++; return new Promise<Response>(() => {}); });
    const before = new AbortController();
    before.abort(new Error("dummy-password"));
    await assert.rejects(c.request("/x", { signal: before.signal }), RequestCancelledError);
    assert.equal(calls, 0);
    const during = new AbortController();
    const request = c.request("/x", { signal: during.signal });
    during.abort("dummy-password");
    await assert.rejects(request, (error: unknown) => error instanceof RequestCancelledError && !String(error).includes("dummy-password"));
  });

  it("clears deadline timers after successful and failed requests", async () => {
    const timersBefore = getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    await client(responseFetch(json({}))).request("/x");
    await assert.rejects(client(responseFetch(new Response("bad", { headers: { "content-type": "application/json" } }))).request("/x"));
    const timersAfter = getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    assert.equal(timersAfter, timersBefore);
  });

  it("rejects invalid/unbounded deadline and size options before fetch", async () => {
    const { fetch, calls } = makeFakeFetch();
    const c = client(fetch);
    for (const timeoutMs of [0, -1, NaN, Infinity, 120001, 1.2]) await assert.rejects(c.request("/x", { timeoutMs }));
    for (const maxResponseBytes of [0, -1, Infinity, 16 * 1024 * 1024 + 1]) await assert.rejects(c.request("/x", { maxResponseBytes }));
    assert.equal(calls.length, 0);
  });
});

describe("response validation", () => {
  it("requires explicit permission for an empty response", async () => {
    for (const method of ["GET", "POST"] as const) {
      await assert.rejects(client(responseFetch(new Response(null, { status: 204 }))).request("/x", { method }), method === "GET" ? ResponseValidationError : UnknownOutcomeError);
      assert.equal(await client(responseFetch(new Response(null, { status: 204 }))).request("/x", { method, allowEmpty: true }), undefined);
    }
  });

  it("rejects HTML, mislabeled HTML, malformed JSON, scalar JSON and non-JSON", async () => {
    const samples = [
      ["<html>dummy-password</html>", "text/html"],
      ["<html>dummy-cookie challenge</html>", "application/json"],
      ["{dummy-token", "application/json"],
      ["null", "application/json"],
      ['"dummy-token"', "application/json"],
      ["{}", "text/plain"],
    ];
    for (const [text, contentType] of samples) {
      const c = client(responseFetch(new Response(text, { headers: { "content-type": contentType! } })));
      await assert.rejects(c.request("/x"), (error: unknown) => error instanceof ResponseValidationError && !String(error).includes("dummy-"));
    }
  });

  it("passes explicitly allowed null and empty responses to endpoint validators", async () => {
    const validate = (value: unknown): null => { assert.ok(value === null || value === undefined); return null; };
    assert.equal(await client(responseFetch(json(null))).request("/x", { validate }), null);
    assert.equal(await client(responseFetch(new Response(null, { status: 204 }))).request("/x", { allowEmpty: true, validate }), null);
  });

  it("executes endpoint runtime validation and redacts schema errors", async () => {
    const c = client(async () => json({ quantity: "dummy-password" }));
    await assert.rejects(c.request("/x", { validate: (value) => finiteNumber(record(value).quantity) }), ResponseValidationError);
    await assert.rejects(c.request("/x", { validate: () => { throw new Error("dummy-token"); } }), (error: unknown) => error instanceof ResponseValidationError && !String(error).includes("dummy-token"));
    assert.equal(await client(async () => json({ quantity: 3 })).request("/x", { validate: (value) => finiteNumber(record(value).quantity) }), 3);
  });

  it("caps both declared and streamed body sizes", async () => {
    await assert.rejects(client(responseFetch(new Response("{}", { headers: { "content-length": "100", "content-type": "application/json" } }))).request("/x", { maxResponseBytes: 10 }), ResponseValidationError);
    await assert.rejects(client(responseFetch(json({ x: "01234567890123456789" }))).request("/x", { maxResponseBytes: 10 }), ResponseValidationError);
  });

  it("does not expose raw fetch errors, retailer bodies, paths or query strings", async () => {
    const c = client(async () => { throw new Error("dummy-password"); });
    await assert.rejects(c.request("/dummy-cookie?token=dummy-token"), (error: unknown) => error instanceof ApiError && !String(error).includes("dummy-"));
    await assert.rejects(client(async () => json({ token: "dummy-token" }, 500)).request("/x"), (error: unknown) => error instanceof ApiError && error.body === undefined && !JSON.stringify(error).includes("dummy-token"));
  });
});

describe("authentication and mutation outcomes", () => {
  it("coalesces simultaneous reauthentication and updates retry credentials", async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const c = client(async (_url, init) => {
      fetchCalls++;
      const auth = new Headers(init?.headers).get("wcauthtoken");
      return auth === "fresh" ? json({ ok: true }) : json({}, 401);
    }, async () => {
      authCalls++;
      await new Promise((resolve) => setImmediate(resolve));
      return fakeSession({ wcauthtoken: "fresh" });
    });
    const results = await Promise.all([c.request("/x"), c.request("/y"), c.request("/z")]);
    assert.equal(results.length, 3);
    assert.equal(authCalls, 1);
    assert.equal(fetchCalls, 6);
  });

  it("does not start a second refresh for a late old-session failure", async () => {
    let authCalls = 0;
    let releaseLate!: () => void;
    let announcedLate!: () => void;
    const lateStarted = new Promise<void>((resolve) => { announcedLate = resolve; });
    const lateGate = new Promise<void>((resolve) => { releaseLate = resolve; });
    const c = client(async (url, init) => {
      if (new Headers(init?.headers).get("wcauthtoken") === "fresh") return json({});
      if (String(url).endsWith("/late")) { announcedLate(); await lateGate; }
      return json({}, 401);
    }, async () => { authCalls++; return fakeSession({ wcauthtoken: "fresh" }); });
    const late = c.request("/late");
    await lateStarted;
    // A newer explicit session can replace an in-flight in-memory read.
    // Serialized requests cannot overtake that read on the same client.
    c.setSession(fakeSession({ wcauthtoken: "fresh" }));
    releaseLate();
    await late;
    assert.equal(authCalls, 0);
  });

  it("permits read semantics only for the known slot-inspection POST", async () => {
    const opts = { method: "POST", semanticRead: true, headers: { "X-HTTP-Method-Override": "GET" } } as const;
    let authCalls = 0;
    const { fetch, calls } = makeFakeFetch([{ status: 401 }, { body: { slots: [] } }]);
    const c = client(fetch, async () => { authCalls++; return fakeSession(); });
    assert.deepEqual(await c.request("/groceries-api/gol-services/slot/v2/slots", opts), { slots: [] });
    assert.equal(authCalls, 1);
    assert.equal(calls.length, 2);
    for (const path of ["/basket", "/groceries-api/gol-services/slot/v2/slots/other"]) await assert.rejects(c.request(path, opts));
    await assert.rejects(c.request("/groceries-api/gol-services/slot/v2/slots", { ...opts, headers: {} }));
    assert.equal(calls.length, 2);
    await assert.rejects(client(async () => { throw new Error("dummy"); }).request("/groceries-api/gol-services/slot/v2/slots", opts), (error: unknown) => error instanceof ApiError && !(error instanceof UnknownOutcomeError));
  });

  it("does not issue a retry after cancellation during reauthentication", async () => {
    let calls = 0;
    let started!: () => void;
    let finish!: (value: ReturnType<typeof fakeSession>) => void;
    const refreshStarted = new Promise<void>(resolve => { started = resolve; });
    const refreshFinished = new Promise<ReturnType<typeof fakeSession>>(resolve => { finish = resolve; });
    const c = client(async () => { calls++; return json({}, 401); }, async () => { started(); return refreshFinished; });
    const controller = new AbortController();
    const request = c.request("/x", { signal: controller.signal });
    await refreshStarted;
    controller.abort();
    await assert.rejects(request, RequestCancelledError);
    finish(fakeSession());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });

  it("reports cancellation after a mutation starts as an unknown outcome", async () => {
    const controller = new AbortController();
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const request = client(async () => { began(); return new Promise<Response>(() => {}); }).request("/x", { method: "PUT", signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(request, UnknownOutcomeError);
  });

  it("never reauthenticates or retries mutations, even on explicit auth failure", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      let calls = 0;
      let authCalls = 0;
      const c = client(async () => { calls++; return json({}, 401); }, async () => { authCalls++; return fakeSession(); });
      await assert.rejects(c.request("/x", { method }), AuthError);
      assert.equal(calls, 1);
      assert.equal(authCalls, 0);
    }
  });

  it("reports transport, deadline, response, redirects and server failures as unknown writes without retry", async () => {
    const factories: Array<() => typeof fetch> = [
      () => async () => { throw new Error("dummy-token"); },
      () => async () => new Promise<Response>(() => {}),
      () => responseFetch(new Response("<html>challenge</html>", { headers: { "content-type": "text/html" } })),
      () => responseFetch(json({}, 503)),
      () => responseFetch(new Response(null, { status: 302, headers: { location: "https://evil.test" } })),
    ];
    for (const factory of factories) {
      let calls = 0;
      const mock = factory();
      const c = client(async (...args) => { calls++; return mock(...args); });
      await assert.rejects(c.request("/x", { method: "PUT", timeoutMs: 20 }), (error: unknown) => error instanceof UnknownOutcomeError && error.outcome === "unknown");
      assert.equal(calls, 1);
    }
  });

  it("preserves definite client rejection and never retries it", async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 400, body: { error: "invalid" } }]);
    await assert.rejects(client(fetch).request("/x", { method: "POST" }), (error: unknown) => error instanceof ApiError && error.status === 400);
    assert.equal(calls.length, 1);
  });

  it("redacts reauthentication failures and permits a later independent refresh", async () => {
    let calls = 0;
    const c = client(async () => json({}, 401), async () => { calls++; throw new Error("dummy-password"); });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(c.request("/x"), (error: unknown) => error instanceof AuthError && !String(error).includes("dummy-password"));
    }
    assert.equal(calls, 2);
  });
});

describe("API validation helpers", () => {
  it("normalizes observed identifiers and rejects unsafe numeric identifiers", () => {
    assert.equal(identifier(12345), "12345");
    assert.equal(identifier("5mhzwp13"), "5mhzwp13");
    for (const value of [Infinity, NaN, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, {}, "", "../x"]) assert.throws(() => identifier(value), ValidationError);
  });
  it("checks runtime shapes without echoing data", () => {
    assert.equal(finiteNumber(2), 2);
    assert.equal(boolean(false), false);
    assert.deepEqual(array([]), []);
    assert.equal(string("a"), "a");
    assert.equal(optional(undefined, string), undefined);
    for (const validate of [record, array, finiteNumber, boolean]) assert.throws(() => validate("dummy-password"), (error: unknown) => error instanceof ValidationError && !String(error).includes("dummy-password"));
  });
});
