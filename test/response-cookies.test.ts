import { mock } from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { AuthError, ApiError, ResponseValidationError, RequestCancelledError, RequestTimeoutError, UnknownOutcomeError } from "../src/client/http.js";
import { clearSession, withAuthLock } from "../src/auth/session.js";
import { createClient } from "../src/client/factory.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroceriesClient, RETAILER_ORIGIN } from "../src/client/http.js";
import { saveSession, loadSession } from "../src/auth/session.js";
import { fakeSession } from "./_helpers.js";

async function temporary<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sainsburys-cookie-test-"));
  try { return await run(join(dir, "session.json")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
function response(cookies: string[] = [], status = 200): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ ok: true }), { status, headers });
}
function rotatingFetch() {
  let revision = 0;
  const impl: typeof fetch = async (_input, init) => {
    const sent = new Headers(init?.headers).get("cookie") ?? "";
    assert.ok(sent.includes(`rotation=dummy-${revision}`), "The next request must use the previously rotated cookie");
    revision++;
    return response([`rotation=dummy-${revision}; Secure; HttpOnly; Path=/`]);
  };
  return impl;
}
const initial = () => fakeSession({ accountEmail: "dummy@example.invalid", cookies: [{ name: "rotation", value: "dummy-0", domain: "www.sainsburys.co.uk", path: "/", secure: true }] });

describe("HTTP response cookie lifecycle", () => {
  it("uses a successful response's rotated cookie on the next real client read", async () => {
    const client = new GroceriesClient({ session: initial(), baseUrl: RETAILER_ORIGIN, fetchImpl: rotatingFetch() });
    await client.request("/first");
    await client.request("/second");
    assert.equal(client.getSession().cookies.find(cookie => cookie.name === "rotation")?.value, "dummy-2");
  });

  it("persists rotation privately and a fresh client reloads it", () => temporary(async path => {
    await saveSession(path, initial());
    const fetchImpl = rotatingFetch();
    const first = new GroceriesClient({ session: (await loadSession(path))!, sessionPath: path, baseUrl: RETAILER_ORIGIN, fetchImpl });
    await first.request("/first");
    assert.equal((await loadSession(path))?.cookies.find(cookie => cookie.name === "rotation")?.value, "dummy-1");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const second = new GroceriesClient({ session: (await loadSession(path))!, sessionPath: path, baseUrl: RETAILER_ORIGIN, fetchImpl });
    await second.request("/second");
    assert.equal((await loadSession(path))?.cookies.find(cookie => cookie.name === "rotation")?.value, "dummy-2");
  }));
});

const exec = promisify(execFile);
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function managed(path: string, session: ReturnType<typeof initial>, fetchImpl: typeof fetch) {
  return new GroceriesClient({ session, sessionPath: path, baseUrl: RETAILER_ORIGIN, fetchImpl });
}

describe("RFC response cookie rules through the real transport", () => {
  it("keeps repeated Set-Cookie with Expires commas and applies deletion and Max-Age precedence", () => temporary(async path => {
    const started = Date.now();
    await saveSession(path, initial());
    let count = 0;
    const c = managed(path, (await loadSession(path))!, async (_url, init) => {
      count++;
      if (count === 1) return response([
        "rotation=; Max-Age=0; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Path=/; Secure",
        "short=dummy-short; Max-Age=60; Expires=Wed, 01 Jan 2000 00:00:00 GMT; Path=/; Secure",
        "long=dummy-long; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Path=/; Secure",
        "bounded=dummy-bounded; Max-Age=60; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Path=/; Secure",
      ]);
      const sent = new Headers(init?.headers).get("cookie")!;
      assert.doesNotMatch(sent, /rotation=/);
      assert.match(sent, /short=dummy-short/);
      assert.match(sent, /long=dummy-long/);
      assert.match(sent, /bounded=dummy-bounded/);
      return response();
    });
    await c.request("/first");
    const stored = (await loadSession(path))!;
    assert.equal(stored.cookies.some(cookie => cookie.name === "rotation"), false);
    const expires = stored.cookies.find(cookie => cookie.name === "short")!.expires! * 1000;
    assert.ok(expires >= started + 59_000 && expires <= Date.now() + 61_000);
    const bounded = stored.cookies.find(cookie => cookie.name === "bounded")!.expires! * 1000;
    assert.ok(bounded >= started + 59_000 && bounded <= Date.now() + 61_000);
    const reloaded = managed(path, stored, async (_url, init) => {
      const sent = new Headers(init?.headers).get("cookie")!;
      assert.doesNotMatch(sent, /short=|bounded=/);
      assert.match(sent, /long=/);
      return response();
    });
    // Absolute expiry must remain enforced after disk reload, without a 60s wait.
    const future = mock.method(Date, "now", () => expires + 1000);
    try { await reloaded.request("/later"); }
    finally { future.mock.restore(); }
    await c.request("/second");
  }));

  it("expires cookies on an explicit Expires deletion and preserves new cookie additions", () => temporary(async path => {
    await saveSession(path, initial());
    const c = managed(path, initial(), async () => response(["rotation=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/", "added=dummy; Path=/; Secure"]));
    await c.request("/read");
    const saved = (await loadSession(path))!;
    assert.equal(saved.cookies.some(cookie => cookie.name === "rotation"), false);
    assert.equal(saved.cookies.find(cookie => cookie.name === "added")?.value, "dummy");
  }));

  it("selects host-only, domain, Secure and path cookies by the exact URL without by-name dedupe", async () => {
    const c = new GroceriesClient({ session: fakeSession({ cookies: [
      { name: "dup", value: "root", domain: ".sainsburys.co.uk", path: "/", secure: true },
      { name: "dup", value: "path", domain: "www.sainsburys.co.uk", path: "/groceries-api", secure: true },
      { name: "hostroot", value: "excluded", domain: "sainsburys.co.uk", path: "/" },
      { name: "account", value: "excluded", domain: "account.sainsburys.co.uk", path: "/" },
      { name: "foreign", value: "excluded", domain: ".evil.test", path: "/" },
    ] }), baseUrl: RETAILER_ORIGIN, fetchImpl: async () => response() });
    assert.equal(c.buildHeaders(undefined, `${RETAILER_ORIGIN}/groceries-api/x`).get("cookie"), "dup=path; dup=root");
    assert.equal(c.buildHeaders(undefined, `${RETAILER_ORIGIN}/groceries-api-other`).get("cookie"), "dup=root");
    assert.throws(() => c.buildHeaders(undefined, "http://www.sainsburys.co.uk/groceries-api/x"));
    assert.throws(() => c.buildHeaders(undefined, "https://evil.test/groceries-api/x"));
  });

  it("enforces response default paths, cookie prefixes, public suffixes and foreign domains", async () => {
    const c = new GroceriesClient({ session: fakeSession({ cookies: [] }), baseUrl: RETAILER_ORIGIN, fetchImpl: async () => response([
      "default=dummy; Secure", "wide=dummy; Domain=.sainsburys.co.uk; Path=/; Secure",
      "bad=dummy; Domain=evil.test; Path=/", "suffix=dummy; Domain=co.uk; Path=/",
      "__Secure-invalid=dummy; Path=/", "__Host-invalid=dummy; Domain=.sainsburys.co.uk; Path=/; Secure",
      "__Host-valid=dummy; Secure; Path=/", "bad\tname=dummy; Path=/",
    ]) });
    await c.request("/groceries-api/x");
    const api = c.buildHeaders(undefined, `${RETAILER_ORIGIN}/groceries-api/y`).get("cookie")!;
    assert.match(api, /default=dummy/);
    assert.match(api, /wide=dummy/);
    assert.match(api, /__Host-valid=dummy/);
    assert.doesNotMatch(api, /bad|suffix|invalid/);
    assert.doesNotMatch(c.buildHeaders(undefined, `${RETAILER_ORIGIN}/other`).get("cookie")!, /default=/);
  });

  it("accepts trusted 401, 404 and HTML response cookies before returning the sanitized error", () => temporary(async path => {
    for (const status of [401, 404, 200]) {
      await saveSession(path, initial());
      const c = managed(path, initial(), async () => status === 200
        ? new Response("<html>dummy-secret challenge</html>", { headers: { "content-type": "text/html", "set-cookie": "rotation=dummy-next; Path=/; Secure" } })
        : response(["rotation=dummy-next; Path=/; Secure"], status));
      await assert.rejects(c.request("/read"), (error: unknown) => error instanceof Error && !error.message.includes("dummy-secret"));
      assert.equal((await loadSession(path))?.cookies.find(cookie => cookie.name === "rotation")?.value, "dummy-next");
    }
  }));

  it("never accepts cookies from redirects or a foreign response and never sends to a foreign origin", () => temporary(async path => {
    await saveSession(path, initial());
    let calls = 0;
    const c = managed(path, initial(), async () => { calls++; return response(["rotation=dummy-evil; Path=/"], 302); });
    await assert.rejects(c.request("/redirect"), ResponseValidationError);
    const foreign = response(["rotation=dummy-evil; Path=/"]);
    Object.defineProperty(foreign, "url", { value: "https://evil.test/read" });
    await assert.rejects(c.request("/foreign", { fetchImpl: async () => foreign }), ResponseValidationError);
    await assert.rejects(c.request("https://evil.test/read"));
    assert.equal(calls, 1);
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-0");
  }));
});

describe("cookie persistence and authenticated request concurrency", () => {
  it("serializes concurrent in-memory requests so every request uses the latest response", async () => {
    const c = new GroceriesClient({ session: initial(), baseUrl: RETAILER_ORIGIN, fetchImpl: rotatingFetch() });
    await Promise.all(Array.from({ length: 5 }, () => c.request("/read")));
    assert.equal(c.getSession().cookies[0]?.value, "dummy-5");
  });

  it("reloads newer same-generation cookies for competing cached clients", () => temporary(async path => {
    await saveSession(path, initial());
    const fetchImpl = rotatingFetch();
    const clients = Array.from({ length: 5 }, () => managed(path, initial(), fetchImpl));
    await Promise.all(clients.map(client => client.request("/read")));
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-5");
  }));

  it("uses persisted cookie refresh through the factory without automatic login or reauthentication", () => temporary(async path => {
    const previous = process.env.SAINSBURYS_SESSION_PATH;
    process.env.SAINSBURYS_SESSION_PATH = path;
    try {
      await saveSession(path, initial());
      const fetchImpl = rotatingFetch();
      await (await createClient({ fetchImpl })).request("/read");
      await (await createClient({ fetchImpl })).request("/read");
      assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-2");
    } finally { if (previous === undefined) delete process.env.SAINSBURYS_SESSION_PATH; else process.env.SAINSBURYS_SESSION_PATH = previous; }
  }));

  it("coordinates separate CLI processes without stale cookie overwrites", () => temporary(async path => {
    await saveSession(path, initial());
    const state = `${path}.retailer-state`;
    await writeFile(state, "0", { mode: 0o600 });
    const factory = pathToFileURL(resolve("src/client/factory.ts")).href;
    const code = `
      import assert from 'node:assert/strict';
      import {readFile,writeFile} from 'node:fs/promises';
      import {createClient} from ${JSON.stringify(factory)};
      const client=await createClient({fetchImpl:async(_url,init)=>{
        const revision=Number(await readFile(process.env.COOKIE_TEST_STATE,'utf8'));
        assert.equal(new Headers(init.headers).get('cookie'),'rotation=dummy-'+revision);
        await new Promise(done=>setTimeout(done,15));
        await writeFile(process.env.COOKIE_TEST_STATE,String(revision+1));
        return new Response('{}',{headers:{'content-type':'application/json','set-cookie':'rotation=dummy-'+(revision+1)+'; Path=/; Secure'}});
      }});
      await client.request('/read');await client.request('/read');
    `;
    await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: resolve("."), env: { ...process.env, HOME: dirname(path), SAINSBURYS_SESSION_PATH: path, COOKIE_TEST_STATE: state },
    })));
    assert.equal(await readFile(state, "utf8"), "8");
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-8");
  }));

  it("does not replay a mutation when rotation is followed by a malformed response", () => temporary(async path => {
    await saveSession(path, initial());
    let calls = 0;
    const c = managed(path, initial(), async () => {
      calls++;
      return new Response("bad json", { headers: { "content-type": "application/json", "set-cookie": "rotation=dummy-next; Path=/; Secure" } });
    });
    await assert.rejects(c.request("/write", { method: "PUT" }), UnknownOutcomeError);
    assert.equal(calls, 1);
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-next");
  }));
});

describe("cookie refresh lifecycle races and failures", () => {
  it("a queued cancelled request never fetches after the active in-memory request completes", async () => {
    const started = deferred();
    const finish = deferred<Response>();
    let calls = 0;
    const c = new GroceriesClient({ session: initial(), baseUrl: RETAILER_ORIGIN, fetchImpl: async () => { calls++; started.resolve(); return finish.promise; } });
    const active = c.request("/active");
    await started.promise;
    const controller = new AbortController();
    const queued = c.request("/queued", { method: "PUT", signal: controller.signal });
    controller.abort("dummy-secret reason");
    await assert.rejects(queued, RequestCancelledError);
    finish.resolve(response());
    await active;
    await new Promise(done => setImmediate(done));
    assert.equal(calls, 1);
  });

  it("includes profile-lock wait in deadlines and never fetches an aborted queued write", () => temporary(async path => {
    await saveSession(path, initial());
    const held = deferred();
    const release = deferred();
    const lock = withAuthLock(`${path}.profile.lock`, async () => { held.resolve(); await release.promise; });
    await held.promise;
    let calls = 0;
    const c = managed(path, initial(), async () => { calls++; return response(); });
    try {
      await assert.rejects(c.request("/queued", { method: "PUT", timeoutMs: 20 }), RequestTimeoutError);
    } finally { release.resolve(); await lock; }
    await new Promise(done => setTimeout(done, 35));
    assert.equal(calls, 0);
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-0");
    await assert.rejects(stat(`${path}.profile.lock`), { code: "ENOENT" });
  }));

  it("rejects missing, changed-account and new-login-generation snapshots before fetch", () => temporary(async path => {
    for (const update of [
      { ...initial(), authGeneration: randomUUID() },
      { ...initial(), userId: "999" },
      { ...initial(), accountEmail: "other@example.invalid" },
      { ...initial(), bearerToken: "dummy-new-bearer" },
    ]) {
      await saveSession(path, initial());
      let calls = 0;
      const c = managed(path, initial(), async () => { calls++; return response(); });
      await withAuthLock(`${path}.profile.lock`, () => saveSession(path, update));
      await assert.rejects(c.request("/stale"), AuthError);
      assert.equal(calls, 0);
    }
    await saveSession(path, initial());
    const c = managed(path, initial(), async () => { throw new Error("Must not fetch after logout"); });
    await clearSession(path);
    await assert.rejects(c.request("/logged-out"), AuthError);
    assert.equal(await loadSession(path), null);
  }));

  it("a queued old client cannot cross a newer login even with the same tokens and timestamp", () => temporary(async path => {
    await saveSession(path, initial());
    const started = deferred();
    const finish = deferred();
    const newer = { ...initial(), authGeneration: randomUUID() };
    const login = withAuthLock(`${path}.profile.lock`, async () => {
      started.resolve(); await finish.promise; await saveSession(path, newer);
    });
    await started.promise;
    let calls = 0;
    const old = managed(path, initial(), async () => { calls++; return response(["rotation=dummy-stale; Path=/"]); });
    const queued = old.request("/old");
    finish.resolve();
    await login;
    await assert.rejects(queued, AuthError);
    assert.equal(calls, 0);
    assert.equal((await loadSession(path))?.authGeneration, newer.authGeneration);
    assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-0");
  }));

  it("logout waits for an accepted response then deletes refreshed authentication without resurrection", () => temporary(async path => {
    await saveSession(path, initial());
    const started = deferred();
    const finish = deferred<Response>();
    const c = managed(path, initial(), async () => { started.resolve(); return finish.promise; });
    const active = c.request("/active");
    await started.promise;
    const logout = clearSession(path);
    finish.resolve(response(["rotation=dummy-final; Path=/; Secure"]));
    await active;
    await logout;
    assert.equal(await loadSession(path), null);
    await assert.rejects(c.request("/old"), AuthError);
    assert.equal(await loadSession(path), null);
  }));

  it("an ignored-fetch response arriving after timeout/logout cannot restore cookies or authentication", () => temporary(async path => {
    await saveSession(path, initial());
    const finish = deferred<Response>();
    const c = managed(path, initial(), async () => finish.promise);
    await assert.rejects(c.request("/slow", { timeoutMs: 20 }), RequestTimeoutError);
    await clearSession(path);
    finish.resolve(response(["rotation=dummy-late; Path=/; Secure"]));
    await new Promise(done => setTimeout(done, 20));
    assert.equal(await loadSession(path), null);
    assert.equal(c.getSession().cookies[0]?.value, "dummy-0");
  }));

  it("a cancelled cookie save never commits after logout or recreates a profile lock", () => temporary(async path => {
    await saveSession(path, initial());
    const started = deferred();
    const release = deferred();
    const held = withAuthLock(`${path}.lock`, async () => { started.resolve(); await release.promise; });
    await started.promise;
    const fetched = deferred();
    const c = managed(path, initial(), async () => { fetched.resolve(); return response(["rotation=dummy-late; Path=/; Secure"]); });
    const request = c.request("/read", { timeoutMs: 40 });
    await fetched.promise;
    await assert.rejects(request, RequestTimeoutError);
    release.resolve(); await held;
    await clearSession(path);
    await new Promise(done => setTimeout(done, 35));
    assert.equal(await loadSession(path), null);
    await assert.rejects(stat(`${path}.profile.lock`), { code: "ENOENT" });
    await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
  }));

  it("private persistence failures are explicit, cancel unread bodies and make writes unknown without retry", () => temporary(async path => {
    for (const method of ["GET", "PUT"] as const) {
      await saveSession(path, initial());
      let calls = 0;
      let cancelled = false;
      const c = managed(path, initial(), async () => {
        calls++;
        await chmod(dirname(path), 0o755);
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "application/json", "set-cookie": "rotation=dummy-secret; Path=/; Secure" } });
      });
      try {
        await assert.rejects(c.request("/write", { method }), (error: unknown) => {
          if (method === "PUT") assert.ok(error instanceof UnknownOutcomeError);
          else { assert.ok(error instanceof ApiError); assert.match(error.message, /could not be saved privately/); }
          assert.doesNotMatch(String(error), /dummy-secret/);
          return true;
        });
        assert.equal(calls, 1);
        assert.equal(cancelled, true);
      } finally { await chmod(dirname(path), 0o700); }
      assert.equal((await loadSession(path))?.cookies[0]?.value, "dummy-0");
    }
  }));

  it("never lets an old in-memory response overwrite a replacement session's cookies", async () => {
    const started = deferred();
    const finish = deferred<Response>();
    const c = new GroceriesClient({ session: initial(), baseUrl: RETAILER_ORIGIN, fetchImpl: async () => { started.resolve(); return finish.promise; } });
    const pending = c.request("/old");
    await started.promise;
    const fresh = { ...initial(), authGeneration: randomUUID(), cookies: [{ ...initial().cookies[0]!, value: "dummy-fresh" }] };
    c.setSession(fresh);
    finish.resolve(response(["rotation=dummy-stale; Path=/"]));
    await assert.rejects(pending, AuthError);
    assert.equal(c.getSession().cookies[0]?.value, "dummy-fresh");
  });
});

it("shared read reauthentication cannot be overwritten by another old-cookie response", async () => {
  const refreshing = deferred<ReturnType<typeof initial>>();
  const oldStarted = deferred();
  const oldResponse = deferred<Response>();
  let calls = 0;
  let refreshCalls = 0;
  const fresh = { ...initial(), authGeneration: randomUUID(), cookies: [{ ...initial().cookies[0]!, value: "dummy-fresh" }] };
  const c = new GroceriesClient({
    session: initial(), baseUrl: RETAILER_ORIGIN,
    reauth: async () => { refreshCalls++; return refreshing.promise; },
    fetchImpl: async (_url, init) => {
      calls++;
      if (calls === 1) return response([], 401);
      if (calls === 2) { oldStarted.resolve(); return oldResponse.promise; }
      assert.equal(new Headers(init?.headers).get("cookie"), "rotation=dummy-fresh");
      return response();
    },
  });
  const a = c.request("/a");
  const b = c.request("/b");
  await oldStarted.promise;
  refreshing.resolve(fresh);
  await new Promise(done => setImmediate(done));
  oldResponse.resolve(response(["rotation=dummy-stale; Path=/; Secure"]));
  await Promise.all([a, b]);
  assert.equal(refreshCalls, 1);
  assert.equal(c.getSession().cookies[0]?.value, "dummy-fresh");
});
