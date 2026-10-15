import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtemp, rm, stat, writeFile, readFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "../src/config.js";
import { saveSession, loadSession, type Session } from "../src/auth/session.js";
import { runResidentService, type ResidentEngine, type ResidentEngineFactory } from "../src/auth/service.js";
import {
  ensureResidentService, residentLogin, residentFetch, residentStatus, stopResidentService, logoutResidentSession,
  residentRpc, residentServicePaths, residentAccountHash, readResidentOwner, cleanDeadResident,
  prepareResidentDirectory, RESIDENT_INPUT_LIMIT, RESIDENT_OUTPUT_LIMIT,
} from "../src/client/resident-service.js";
import { ApiError, AuthError, GroceriesClient, RequestCancelledError, RequestTimeoutError, ResponseValidationError, RETAILER_ORIGIN } from "../src/client/http.js";
import { fakeSession } from "./_helpers.js";

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const initial = () => fakeSession({ accountEmail: "dummy@example.invalid", authGeneration: randomUUID(), browserManaged: true });
function config(sessionPath: string): Config { return { email: "dummy@example.invalid", sessionPath, headed: true, baseUrl: RETAILER_ORIGIN, loginBaseUrl: "https://account.sainsburys.co.uk" }; }

class FakeEngine implements ResidentEngine {
  starts = 0; logins = 0; closes = 0; active = false; calls: Array<{url: string; method: string; headers: Record<string, string>; body?: string}> = [];
  requestImpl?: ResidentEngine["request"];
  startGate?: Promise<void>;
  constructor(readonly options: {config: Config; session?: Session}) {}
  async start() { this.starts++; if (this.startGate) await this.startGate; this.active = !!this.options.session; }
  async login() {
    this.logins++; this.active = true;
    const session = initial(); this.options.session = session;
    await saveSession(this.options.config.sessionPath, session);
    return session;
  }
  async request(input: Parameters<ResidentEngine["request"]>[0], signal?: AbortSignal) {
    if (!this.active) throw new AuthError(401);
    this.calls.push(input);
    if (this.requestImpl) return this.requestImpl(input, signal);
    return {status: 200, headers: {"content-type": "application/json", "set-cookie": "dummy-secret-cookie", authorization: "Bearer dummy-secret-token"}, body: JSON.stringify({products: []})};
  }
  getSession() { return this.active ? this.options.session : undefined; }
  status() { return { authenticated: this.active, needsLogin: !this.active }; }
  async close() { this.closes++; this.active = false; }
}

async function running<T>(run: (value: {config: Config; session: Session; engine: FakeEngine; path: string; lifetime: Promise<void>}) => Promise<T>, setup?: (engine: FakeEngine) => void, cached = true): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "sainsburys-resident-ipc-test-"));
  const path = join(home, "session.json");
  const cfg = config(path); const session = initial();
  if (cached) await saveSession(path, session);
  let engine!: FakeEngine;
  const factory: ResidentEngineFactory = options => { engine = new FakeEngine(options); setup?.(engine); return engine; };
  const lifetime = runResidentService(cfg, factory);
  let endedError: unknown;
  void lifetime.catch(error => { endedError = error; });
  try {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (endedError) throw endedError;
      try { if ((await residentStatus(path)).running) break; } catch {}
      await new Promise(done => setTimeout(done, 10));
    }
    assert.equal((await residentStatus(path)).running, true);
    return await run({config: cfg, session, engine, path, lifetime});
  } finally {
    await stopResidentService(path).catch(() => {});
    await lifetime.catch(() => {});
    await rm(home, {recursive: true, force: true});
    await rm(residentServicePaths(path).directory, {recursive: true, force: true});
  }
}

async function rawRpc(path: string, input: Buffer): Promise<string> {
  return new Promise((done, reject) => {
    const socket = createConnection(residentServicePaths(path).socket);
    let output = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Dummy RPC timed out")); }, 3000);
    socket.on("connect", () => socket.write(input));
    socket.on("data", value => { output += String(value); if (output.includes("\n")) { clearTimeout(timer); socket.destroy(); done(output); } });
    socket.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

describe("private resident service IPC", () => {
  it("creates private socket/owner state, retains one engine, and status/login never expose credentials", () => running(async ({config: cfg, path, engine}) => {
    const paths = residentServicePaths(path);
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.socket)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.owner)).mode & 0o777, 0o600);
    await Promise.all(Array.from({length: 4}, () => ensureResidentService(cfg)));
    assert.equal(engine.starts, 1);
    const status = await residentStatus(path);
    assert.deepEqual(status, {running: true, authenticated: true, needsLogin: false});
    const login = await residentLogin(cfg);
    assert.deepEqual(Object.keys(login).sort(), ["session_path", "user_id"]);
    assert.equal(engine.logins, 1);
    assert.doesNotMatch(JSON.stringify({status, login}), /bearer|wcauthtoken|cookie|test-jwt|abc%2B/);
    assert.equal(engine.starts, 1);
  }));

  it("publishes status before initial start finishes and login waits then uses the same engine", () => {
    const gate = deferred();
    return running(async ({path, config: cfg, engine}) => {
      assert.equal((await residentStatus(path)).authenticated, false);
      const login = residentLogin(cfg);
      await new Promise(done => setTimeout(done, 20));
      assert.equal(engine.logins, 0);
      gate.resolve();
      await login;
      assert.equal(engine.starts, 1);
      assert.equal(engine.logins, 1);
    }, engine => { engine.startGate = gate.promise; });
  });

  it("a fresh account with no cache waits for explicit login instead of starting a browser automatically", () => running(async ({config: cfg, path, engine}) => {
    assert.equal(engine.starts, 0);
    assert.equal((await residentStatus(path)).needsLogin, true);
    await residentLogin(cfg);
    assert.equal(engine.logins, 1);
    assert.equal((await loadSession(path))?.browserManaged, true);
  }, undefined, false));

  it("runs real GroceriesClient over IPC, strips auth headers and returns only body/content type/status", () => running(async ({path, session, engine}) => {
    const client = new GroceriesClient({session, baseUrl: RETAILER_ORIGIN, fetchImpl: residentFetch(path, session)});
    assert.deepEqual(await client.request("/groceries-api/gol-services/product/v1/product"), {products: []});
    assert.equal(engine.calls.length, 1);
    assert.deepEqual(Object.keys(engine.calls[0]!.headers).sort(), ["accept", "content-type", "enabled-feature-flags"]);
    assert.doesNotMatch(JSON.stringify(engine.calls), /test-jwt|wcauthtoken|WC_AUTHENTICATION|abc%2B/);
    const response = await residentFetch(path, session)(`${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(response.headers.has("authorization"), false);
  }));

  it("rejects stale generation and account IDs before the engine request", () => running(async ({path, session, engine}) => {
    for (const stale of [{...session, userId: "999"}, {...session, authGeneration: randomUUID()}]) {
      const response = await residentFetch(path, stale)(`${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`);
      assert.equal(response.status, 401);
    }
    assert.equal(engine.calls.length, 0);
  }));

  it("lets a bound read recover after an earlier recovery failed without opening login or admitting stale bindings", () => running(async ({path, session, engine}) => {
    let resumed = false, dispatches = 0, networkWrites = 0;
    // Model the retained engine after a failed silent refresh. Its identity
    // remains pinned even though getSession no longer reports authenticated.
    Object.assign(engine, {getSessionBinding: () => ({userId: session.userId, authGeneration: session.authGeneration})});
    engine.request = async input => {
      dispatches++;
      if (input.method !== "GET") { if (!engine.active) throw new AuthError(401); networkWrites++; }
      if (!resumed) { engine.active = false; throw new AuthError(401); }
      engine.active = true;
      return {status: 200, headers: {"content-type": "application/json"}, body: JSON.stringify({products: []})};
    };
    const url = `${RETAILER_ORIGIN}/groceries-api/gol-services/product/v1/product`;
    const fetch = residentFetch(path, session);
    assert.equal((await fetch(url)).status, 401);
    assert.deepEqual(await residentStatus(path), {running: true, authenticated: false, needsLogin: true});
    assert.equal(engine.getSession(), undefined);
    for (const stale of [{...session, userId: "999"}, {...session, authGeneration: randomUUID()}]) {
      assert.equal((await residentFetch(path, stale)(url)).status, 401);
    }
    assert.equal(dispatches, 1, "stale bindings never reach the engine");
    assert.equal((await fetch(`${RETAILER_ORIGIN}/groceries-api/gol-services/basket/v2/basket`, {method: "PUT", body: "{}"})).status, 401);
    assert.equal(networkWrites, 0, "the unauthenticated engine rejects writes before transport");
    resumed = true;
    assert.equal((await fetch(url)).status, 200);
    assert.equal(dispatches, 3, "a subsequent read can reach retained-context recovery");
    assert.equal(engine.starts, 1); assert.equal(engine.logins, 0);
  }));

  it("refuses a new email while a live daemon belongs to another account", () => running(async ({config: cfg, engine}) => {
    await assert.rejects(ensureResidentService({...cfg, email: "other@example.invalid"}), /logout/);
    assert.equal(engine.logins, 0);
  }));

  it("preserves definite auth and amendment rejection without retrying or reflecting browser errors", () => running(async ({path, session, engine}) => {
    engine.requestImpl = async () => { throw new ApiError(409, "dummy-secret browser log"); };
    const c = new GroceriesClient({session, baseUrl: RETAILER_ORIGIN, fetchImpl: residentFetch(path, session)});
    await assert.rejects(c.request("/groceries-api/gol-services/basket/v2/basket", {method: "PUT", body: {items: []}}), (error: unknown) => error instanceof ApiError && error.status === 409 && !String(error).includes("dummy-secret"));
    assert.equal(engine.calls.length, 1);
    engine.requestImpl = async () => { throw new AuthError(401, "dummy-secret cookie"); };
    await assert.rejects(c.request("/groceries-api/gol-services/customer/v1/customer/profile"), AuthError);
    assert.equal(engine.calls.length, 2);
  }));

  it("disconnect cancels queued and active work, so a queued PUT cannot run later", () => running(async ({path, session, engine}) => {
    const began = deferred(); const release = deferred();
    engine.requestImpl = async (_input, signal) => { began.resolve(); await release.promise; if (signal?.aborted) throw new RequestCancelledError(); return {status: 200, headers: {}, body: "{}"}; };
    const firstAbort = new AbortController();
    const first = residentFetch(path, session)(`${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`, {signal: firstAbort.signal});
    await began.promise;
    const secondAbort = new AbortController();
    const queued = residentFetch(path, session)(`${RETAILER_ORIGIN}/groceries-api/gol-services/basket/v2/basket`, {method: "PUT", body: "{}", signal: secondAbort.signal});
    await new Promise(done => setTimeout(done, 20));
    secondAbort.abort();
    await assert.rejects(queued);
    firstAbort.abort(); await assert.rejects(first);
    release.resolve(); await new Promise(done => setTimeout(done, 30));
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0]!.method, "GET");
  }));

  it("enforces RPC deadlines including queued work without an extra engine request", () => running(async ({path, session, engine}) => {
    const began = deferred(); const release = deferred();
    engine.requestImpl = async (_input, signal) => { began.resolve(); await release.promise; if (signal?.aborted) throw new RequestCancelledError(); return {status: 200, headers: {}, body: "{}"}; };
    const firstAbort = new AbortController();
    const first = residentFetch(path, session)(`${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`, {signal: firstAbort.signal});
    await began.promise;
    await assert.rejects(residentRpc(path, {operation: "request", expectedUserId: session.userId, authGeneration: session.authGeneration, request: {url: `${RETAILER_ORIGIN}/groceries-api/gol-services/basket/v2/basket`, method: "PUT", headers: {}, body: "{}"}}, 20));
    firstAbort.abort(); await assert.rejects(first);
    release.resolve(); await new Promise(done => setTimeout(done, 30));
    assert.equal(engine.calls.length, 1);
  }));

  it("bounds malformed/oversized input and output and never reflects the offending data", () => running(async ({path, session, engine}) => {
    const bad = await rawRpc(path, Buffer.from("{dummy-secret invalid json}\n"));
    assert.equal(JSON.parse(bad).error.code, "INVALID_REQUEST");
    assert.doesNotMatch(bad, /dummy-secret/);
    const large = await rawRpc(path, Buffer.alloc(RESIDENT_INPUT_LIMIT + 1, 65));
    assert.equal(JSON.parse(large).error.code, "REQUEST_TOO_LARGE");
    engine.requestImpl = async () => ({status: 200, headers: {"content-type": "application/json"}, body: "x".repeat(RESIDENT_OUTPUT_LIMIT + 1)});
    await assert.rejects(residentFetch(path, session)(`${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`));
  }));

  it("stop closes the engine and releases the profile lock before success", () => running(async ({path, engine, lifetime}) => {
    await stopResidentService(path);
    await lifetime;
    assert.equal(engine.closes, 1);
    assert.deepEqual(await residentStatus(path), {running: false, authenticated: false, needsLogin: true});
    await assert.rejects(stat(`${path}.profile.lock`), {code: "ENOENT"});
    assert.ok(await loadSession(path), "stop does not delete the cached session");
  }));
});

it("refuses insecure/symlink storage and never kills or removes an unrecognized live owner", async () => {
  const home = await mkdtemp(join(tmpdir(), "sainsburys-resident-owner-test-"));
  const paths = residentServicePaths(join(home, "session.json"));
  try {
    await prepareResidentDirectory(paths);
    await writeFile(paths.owner, JSON.stringify({version: 1, pid: process.pid, instanceId: randomUUID(), sessionHash: paths.sessionHash, accountHash: residentAccountHash("dummy@example.invalid")}), {mode: 0o600});
    await assert.rejects(cleanDeadResident(paths), /still running/);
    assert.ok(await readResidentOwner(paths));
    await rm(paths.owner);
    await symlink(join(home, "outside"), paths.owner);
    await assert.rejects(readResidentOwner(paths), /unsafe/);
  } finally { await rm(paths.directory, {recursive: true, force: true}); await rm(home, {recursive: true, force: true}); }
});

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

it("handles fragmented dispatch acknowledgement and rejects stacked RPC frames", () => running(async ({path, session, engine}) => {
  const owner = (await readResidentOwner(residentServicePaths(path)))!;
  const input = {operation: "request", instanceId: owner.instanceId, timeoutMs: 2000, deadlineMs: Date.now() + 2000, expectedUserId: session.userId, authGeneration: session.authGeneration,
    request: {url: `${RETAILER_ORIGIN}/groceries-api/gol-services/customer/v1/customer/profile`, method: "GET", headers: {}}};
  const reply = await new Promise<string>((done, reject) => {
    const socket = createConnection(residentServicePaths(path).socket);
    let text = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify(input) + "\n"));
    socket.on("data", chunk => {
      text += String(chunk);
      if (text.includes('"ready":true')) {
        text = "";
        socket.write('{"pro');
        setTimeout(() => socket.write('ceed":true}\n'), 10);
      } else if (text.includes("\n")) { socket.destroy(); done(text); }
    });
  });
  assert.equal(JSON.parse(reply).ok, true);
  assert.equal(engine.calls.length, 1);
  const rejected = await rawRpc(path, Buffer.from(JSON.stringify({operation: "status", instanceId: owner.instanceId}) + "\n{}\n"));
  assert.equal(JSON.parse(rejected).error.code, "INVALID_REQUEST");
}));

it("cleans dead owned worker state and SIGTERM closes a live dummy engine before releasing its lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "sainsburys-resident-worker-test-"));
  const path = join(home, "session.json");
  const paths = residentServicePaths(path);
  const marker = join(home, "closed");
  await saveSession(path, initial());
  const serviceModule = pathToFileURL(resolve("src/auth/service.ts")).href;
  const configValue = config(path);
  const code = `
    import {runResidentService} from ${JSON.stringify(serviceModule)};
    import {writeFile} from 'node:fs/promises';
    await runResidentService(JSON.parse(process.env.RESIDENT_TEST_CONFIG),options=>({
      start:async()=>{},login:async()=>options.session,getSession:()=>options.session,
      status:()=>({authenticated:true,needsLogin:false}),
      request:async()=>({status:200,headers:{'content-type':'application/json'},body:'{}'}),
      close:async()=>{await new Promise(done=>setTimeout(done,20));await writeFile(process.env.RESIDENT_TEST_MARKER,'closed',{mode:0o600});}
    }));
  `;
  const launch = () => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {env: {...process.env, HOME: home, RESIDENT_TEST_CONFIG: JSON.stringify(configValue), RESIDENT_TEST_MARKER: marker}, stdio: "ignore"});
    const exited = new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("exit", done); });
    return {child, exited};
  };
  let worker = launch();
  const ready = async () => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { try { if ((await residentStatus(path)).running) return; } catch {} await new Promise(done => setTimeout(done, 10)); }
    throw new Error("Dummy resident worker did not start");
  };
  try {
    await ready();
    worker.child.kill("SIGKILL"); await worker.exited;
    assert.ok(await stat(paths.owner));
    await cleanDeadResident(paths);
    await assert.rejects(stat(paths.owner), {code: "ENOENT"});
    worker = launch();
    await ready();
    worker.child.kill("SIGTERM");
    assert.equal(await worker.exited, 143);
    assert.ok(await stat(marker));
    await assert.rejects(stat(`${path}.profile.lock`), {code: "ENOENT"});
    assert.deepEqual(await residentStatus(path), {running: false, authenticated: false, needsLogin: true});
  } finally {
    worker.child.kill("SIGKILL"); await worker.exited;
    await cleanDeadResident(paths).catch(() => {});
    await rm(home, {recursive: true, force: true});
    await rm(paths.directory, {recursive: true, force: true});
  }
});

it("rejects an already-expired absolute dispatch deadline without touching the engine", () => running(async ({path, session, engine}) => {
  const owner = (await readResidentOwner(residentServicePaths(path)))!;
  const message = {operation: "request", instanceId: owner.instanceId, timeoutMs: 2000, deadlineMs: Date.now() - 1,
    expectedUserId: session.userId, authGeneration: session.authGeneration,
    request: {url: `${RETAILER_ORIGIN}/groceries-api/gol-services/basket/v2/basket`, method: "PUT", headers: {}, body: "{}"}};
  const reply = JSON.parse(await rawRpc(path, Buffer.from(JSON.stringify(message) + "\n")));
  assert.equal(reply.error.code, "TIMEOUT");
  assert.equal(engine.calls.length, 0);
}));

import {createBasketPlan, applyBasketPlan, BasketApplyError} from "../src/basket/plan.js";

it("preserves trusted renderer validation/deadline/cancel types over IPC without leaking their messages", () => running(async ({path, session, engine}) => {
  const c = new GroceriesClient({session, baseUrl: RETAILER_ORIGIN, fetchImpl: residentFetch(path, session), trustedTransportErrors: true});
  for (const error of [new ResponseValidationError("dummy-secret redirect body"), new RequestTimeoutError(), new RequestCancelledError()]) {
    engine.requestImpl = async () => { throw error; };
    await assert.rejects(c.request("/groceries-api/gol-services/customer/v1/customer/profile"), (actual: unknown) => {
      assert.ok(actual instanceof error.constructor);
      assert.doesNotMatch(String(actual), /dummy-secret/);
      return true;
    });
  }
  assert.equal(engine.calls.length, 3);
}));

it("does not retry post-write validation, timeout or cancellation failures masked by the IPC boundary", async () => {
  for (const [failure, category] of [[new ResponseValidationError("dummy-secret redirect"), "validation"], [new RequestTimeoutError(), "timeout"], [new RequestCancelledError(), "cancelled"]] as const) {
    await running(async ({path, session, engine}) => {
      let writes = 0; let readbacks = 0;
      engine.requestImpl = async input => {
        const url = new URL(input.url);
        if (url.pathname.endsWith("/status")) return {status: 404, headers: {}, body: ""};
        if (url.pathname.includes("product/v1/product")) return {status: 200, headers: {"content-type": "application/json"}, body: JSON.stringify({products: [{product_uid: "12345", name: "Dummy", retail_price: {price: 2, measure: "ea"}}]})};
        if (input.method === "PUT") { writes++; return {status: 200, headers: {"content-type": "application/json"}, body: "null"}; }
        if (writes) { readbacks++; throw failure; }
        return {status: 200, headers: {"content-type": "application/json"}, body: JSON.stringify({basket_id: "basket-1", total_price: 2, is_in_amend_mode: false, items: [{item_uid: "line-1", quantity: 1, uom: "ea", subtotal_price: 2, product: {sku: "12345"}}]})};
      };
      const client = new GroceriesClient({session, baseUrl: RETAILER_ORIGIN, fetchImpl: residentFetch(path, session), trustedTransportErrors: true});
      const context = {client, basketContext: {storeNumber: "0123", slotBooked: false}, productContext: {storeIdentifier: "0123"}};
      const plan = await createBasketPlan(context, [{sku: "12345", quantity: 0}], {maxTotal: 10, maxQuantity: 2});
      await assert.rejects(applyBasketPlan(context, plan, plan.approval), (error: unknown) => {
        assert.ok(error instanceof BasketApplyError);
        assert.equal(error.outcome, "unknown");
        assert.equal(error.readbackFailure?.category, category);
        assert.doesNotMatch(JSON.stringify(error), /dummy-secret/);
        return true;
      });
      assert.equal(writes, 1);
      assert.equal(readbacks, 1);
    });
  }
});

it("logout holds startup coordination through browser closure and credential deletion", () => running(async ({config: cfg, path, session, engine, lifetime}) => {
  const closing = deferred(); const releaseClose = deferred();
  engine.close = async () => { engine.closes++; closing.resolve(); await releaseClose.promise; engine.active = false; };
  const logout = logoutResidentSession(path);
  await closing.promise;
  const queued = ensureResidentService(cfg, {userId: session.userId, authGeneration: session.authGeneration});
  // Attach rejection handling before releasing the old daemon so no startup can
  // escape the cached-session check once logout deletes authentication state.
  const rejected = assert.rejects(queued, AuthError);
  releaseClose.resolve();
  await logout;
  await rejected;
  await lifetime;
  assert.equal(engine.closes, 1);
  assert.equal(await loadSession(path), null);
  assert.equal(await readResidentOwner(residentServicePaths(path)), null);
  assert.deepEqual(await residentStatus(path), {running: false, authenticated: false, needsLogin: true});
}));

it("normal-command startup rejects a replaced cached account or generation before daemon reuse", () => running(async ({config: cfg, path, session, engine}) => {
  for (const expected of [{userId: "999", authGeneration: session.authGeneration}, {userId: session.userId, authGeneration: randomUUID()}]) {
    await assert.rejects(ensureResidentService(cfg, expected), AuthError);
  }
  assert.equal(engine.starts, 1);
  assert.equal(engine.logins, 0);
}));

it("logout refuses an unrecognized live socket instead of clearing credentials beneath it", () => running(async ({path}) => {
  const paths = residentServicePaths(path);
  const owner = await readFile(paths.owner, "utf8");
  await rm(paths.owner);
  try {
    await assert.rejects(logoutResidentSession(path), /unrecognized resident socket/);
    assert.ok(await loadSession(path));
  } finally { await writeFile(paths.owner, owner, {mode: 0o600}); }
}));
