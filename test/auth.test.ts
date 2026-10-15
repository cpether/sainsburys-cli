import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, stat, readFile, readdir, chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { chromium, errors, request, type BrowserContext } from "playwright";
import { performLogin, type LoginOptions } from "../src/auth/login.js";
import { browserDataDir, launchContext } from "../src/auth/browser.js";
import { clearSession, saveSession, loadSession, profileRoot, withAuthLock } from "../src/auth/session.js";
import { createClient } from "../src/client/factory.js";
import { fakeSession } from "./_helpers.js";

async function temporary<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sainsburys-auth-test-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeBrowser(email = "dummy@example.com", emit = true, delay = 0) {
  let closes = 0;
  let launches = 0;
  const page = Object.assign(new EventEmitter(), {
    async goto() {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      if (emit) page.emit("request", {
        url: () => "https://www.sainsburys.co.uk/groceries-api/gol-services/customer/v1/customer/profile",
        headers: () => ({ wcauthtoken: fakeSession().wcauthtoken, authorization: `Bearer ${fakeSession().bearerToken}` }),
      });
    },
    async waitForURL() {},
    async evaluate() { return "DummyBrowser/1"; },
  });
  const context = {
    newPage: async () => page,
    cookies: async () => fakeSession().cookies,
    close: async () => { closes++; },
    request: { get: async () => ({
      body: async () => Buffer.from(JSON.stringify({ user_id: "123456789", email })),
      status: () => 200,
      headers: () => ({ "content-type": "application/json" }),
    }) },
  } as unknown as BrowserContext;
  const launch: NonNullable<LoginOptions["launch"]> = async () => { launches++; return context; };
  return { context, page, launch, get closes() { return closes; }, get launches() { return launches; } };
}

function options(dir: string, extra: Partial<LoginOptions> = {}): LoginOptions {
  return {
    config: { email: "dummy@example.com", sessionPath: join(dir, "session.json"), headed: true,
      baseUrl: "https://www.sainsburys.co.uk", loginBaseUrl: "https://account.sainsburys.co.uk" },
    ...extra,
  };
}

describe("private authentication storage", () => {
  it("creates new directories mode 0700 and files mode 0600; concurrent saves stay valid and atomic", () => temporary(async (dir) => {
    const path = join(dir, "nested", "session.json");
    await Promise.all(Array.from({ length: 8 }, (_, index) => saveSession(path, fakeSession({ capturedAt: index }))));
    assert.equal((await stat(join(dir, "nested"))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.ok(await loadSession(path));
    assert.deepEqual(await readdir(join(dir, "nested")), ["session.json"]);
  }));

  it("rejects insecure directories and files rather than ignoring permission failures", () => temporary(async (dir) => {
    const insecure = join(dir, "open");
    await mkdir(insecure, { mode: 0o755 });
    await assert.rejects(saveSession(join(insecure, "session.json"), fakeSession()), /0700/);
    const path = join(dir, "session.json");
    await saveSession(path, fakeSession());
    await chmod(path, 0o644);
    await assert.rejects(loadSession(path), /0600/);
    await chmod(path, 0o600);
    await writeFile(path, '{"bearerToken":"secret-unexpected-data"}');
    await assert.rejects(loadSession(path), /invalid shape/);
  }));

  it("does not delete an unknown legacy profile beside a custom session file", () => temporary(async (dir) => {
    const path = join(dir, "session.json");
    const legacy = join(dir, "browser-data");
    await saveSession(path, fakeSession());
    await mkdir(legacy);
    await writeFile(join(legacy, "unrelated"), "preserve");
    await assert.rejects(clearSession(path), /Logout is incomplete/);
    assert.equal(await readFile(join(legacy, "unrelated"), "utf8"), "preserve");
    assert.equal(await loadSession(path), null);
    await rm(legacy, {recursive:true});
    await clearSession(path);
    assert.equal(await loadSession(path), null);
  }));

  it("reports a busy lock without modifying another writer's lock", () => temporary(async (dir) => {
    const path = join(dir, "busy.lock");
    await writeFile(path, "other", { mode: 0o600 });
    await assert.rejects(withAuthLock(path, async () => {}, 10), /busy/);
    assert.equal(await readFile(path, "utf8"), "other");
  }));

  it("separates accounts and session filenames and removes all local profiles on logout", () => temporary(async (dir) => {
    const path = join(dir, "a.json");
    assert.notEqual(browserDataDir(path, "a@example.com"), browserDataDir(path, "b@example.com"));
    assert.notEqual(browserDataDir(path, "a@example.com"), browserDataDir(join(dir, "b.json"), "a@example.com"));
    assert.equal(browserDataDir(path, "A@EXAMPLE.COM"), browserDataDir(path, "a@example.com"));
    await mkdir(browserDataDir(path, "a@example.com"), { recursive: true, mode: 0o700 });
    await mkdir(browserDataDir(path, "b@example.com"), { recursive: true, mode: 0o700 });
    await saveSession(path, fakeSession());
    await clearSession(path);
    await clearSession(path);
    assert.equal(await loadSession(path), null);
    await assert.rejects(stat(profileRoot(path)), { code: "ENOENT" });
  }));
});

describe("manual local login", () => {
  it("verifies a real Playwright response with multiple Set-Cookie headers and retains refreshed cookies", () => temporary(async (dir) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": ["first=dummy-first; Path=/", "second=dummy-second; Path=/"] });
      res.end(JSON.stringify({ user_id: "123456789", email: "dummy@example.com" }));
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const transport = await request.newContext();
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const fake = fakeBrowser();
      fake.context.request.get = async (_input, init) => transport.get(`http://127.0.0.1:${address.port}/profile`, init);
      // BrowserContext.request shares its context's cookie jar. Model that here
      // with real Playwright storage state, mapping loopback dummy cookies to the
      // retailer domain solely for the session cookie allowlist under test.
      fake.context.cookies = async () => (await transport.storageState()).cookies.map(cookie => ({ ...cookie, domain: ".sainsburys.co.uk" }));
      const opts = options(dir, { launch: fake.launch });
      const session = await performLogin(opts);
      assert.equal(session.accountEmail, "dummy@example.com");
      assert.deepEqual(session.cookies.map(cookie => [cookie.name, cookie.value]).sort(), [["first", "dummy-first"], ["second", "dummy-second"]]);
      assert.deepEqual((await loadSession(opts.config.sessionPath))?.cookies.map(cookie => [cookie.name, cookie.value]).sort(), [["first", "dummy-first"], ["second", "dummy-second"]]);
    } finally {
      await transport.dispose();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    }
  }));

  it("reads browser metadata before the login redirect can replace its execution context", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    const goto = fake.page.goto;
    let navigating = false;
    fake.page.goto = async () => { navigating = true; await goto(); };
    fake.page.evaluate = async () => {
      assert.equal(navigating, false, "post-login redirects can destroy the evaluation context");
      return "DummyBrowser/1";
    };
    const session = await performLogin(options(dir, { launch: fake.launch }));
    assert.equal(session.userAgent, "DummyBrowser/1");
  }));

  it("verifies a completed login even when the initial document load times out", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    const goto = fake.page.goto;
    fake.page.goto = async () => {
      await goto(); // The browser has already sent an authenticated API request.
      throw new errors.TimeoutError("dummy private navigation URL");
    };
    const session = await performLogin(options(dir, { launch: fake.launch, timeoutMs: 1000 }));
    assert.equal(session.accountEmail, "dummy@example.com");
    assert.equal(fake.closes, 1);
  }));

  it("does not wait for the document load after authenticated API activity", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    const goto = fake.page.goto;
    fake.page.goto = async () => { await goto(); await new Promise(() => {}); };
    const session = await performLogin(options(dir, { launch: fake.launch, timeoutMs: 100 }));
    assert.equal(session.accountEmail, "dummy@example.com");
  }));

  for (const failure of [
    { status: 403, body: "private challenge with dummy-cookie", contentType: "text/html", expected: /HTTP 403/ },
    { status: 200, body: "<html>dummy-cookie</html>", contentType: "text/html", expected: /HTML/ },
    { status: 200, body: "{dummy-cookie", contentType: "application/json", expected: /malformed JSON/ },
    { status: 302, body: "", contentType: "text/html", expected: /redirects are refused/ },
    { status: 500, body: "dummy-cookie", contentType: "text/html", expected: /HTTP 500/ },
  ]) it(`identifies an identity read failure (${failure.status}, ${failure.expected.source}) without disclosing its response`, () => temporary(async (dir) => {
    const fake = fakeBrowser();
    fake.context.request.get = async () => ({
      body: async () => Buffer.from(failure.body),
      status: () => failure.status,
      headers: () => ({ "content-type": failure.contentType }),
    }) as never;
    const opts = options(dir, { launch: fake.launch });
    await assert.rejects(performLogin(opts), (err: Error) => {
      assert.match(err.message, /account verification/);
      assert.match(err.message, failure.expected);
      assert.doesNotMatch(err.message, /dummy-cookie|private challenge/);
      return true;
    });
    assert.equal(await loadSession(opts.config.sessionPath), null);
  }));

  for (const failure of [
    { message: "apiRequestContext.get: socket hang up", expected: /connection reset/ },
    { message: "apiRequestContext.get: unable to get local issuer certificate", expected: /TLS certificate verification failed/ },
    { message: "apiRequestContext.get: getaddrinfo ENOTFOUND private-host", expected: /DNS lookup failed/ },
    { message: "apiRequestContext.get: connect ECONNREFUSED private-host", expected: /connection refused/ },
    { message: "apiRequestContext.get: Invalid character in header content [cookie]", expected: /headers were rejected locally/ },
    { message: "apiRequestContext.get: unrecognized private failure", expected: /unclassified transport error/ },
  ]) it(`classifies browser transport failure as ${failure.expected.source} without exposing its call log`, () => temporary(async (dir) => {
    const fake = fakeBrowser();
    fake.context.request.get = async () => { throw new Error(`${failure.message}\nCall log:\nCookie: dummy-cookie\nAuthorization: Bearer secret-token`); };
    const opts = options(dir, { launch: fake.launch });
    await assert.rejects(performLogin(opts), (error: Error) => {
      assert.match(error.message, /account verification/);
      assert.match(error.message, failure.expected);
      assert.doesNotMatch(error.message, /dummy-cookie|secret-token|private-host|Call log|unrecognized private failure/);
      return true;
    });
    assert.equal(await loadSession(opts.config.sessionPath), null);
    assert.equal(fake.closes, 1);
  }));

  it("waits for manual login after a document timeout and cleans a closed browser promptly", () => temporary(async (dir) => {
    const fake = fakeBrowser("dummy@example.com", false);
    fake.page.goto = async () => { throw new errors.TimeoutError("dummy private URL"); };
    const opts = options(dir, { launch: fake.launch, timeoutMs: 1000, log: message => {
      if (message.startsWith("After completing login")) fake.page.emit("close");
    } });
    await assert.rejects(performLogin(opts), /Login browser closed/);
    assert.equal(fake.closes, 1);
    assert.equal(fake.page.listenerCount("close"), 0);
    assert.equal(await loadSession(opts.config.sessionPath), null);
  }));

  it("verifies identity without touching a password, persists only after verification and clears timers", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    const outstanding = new Set<ReturnType<typeof setTimeout>>();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const schedule = mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const handle = realSetTimeout(callback, ms, ...args);
      if (ms === 12345) outstanding.add(handle);
      return handle;
    });
    const cancel = mock.method(globalThis, "clearTimeout", (handle: ReturnType<typeof setTimeout>) => {
      outstanding.delete(handle);
      return realClearTimeout(handle);
    });
    const opts = options(dir, { launch: fake.launch, timeoutMs: 12345 });
    Object.defineProperty(opts.config, "password", { get() { throw new Error("password must not be read"); } });
    const logs: string[] = [];
    const session = await performLogin({ ...opts, log: (value) => logs.push(value) });
    assert.equal(session.accountEmail, "dummy@example.com");
    assert.equal((await loadSession(opts.config.sessionPath))?.accountEmail, "dummy@example.com");
    assert.equal(fake.closes, 1);
    assert.equal(fake.page.listenerCount("request"), 0);
    assert.equal(fake.page.listenerCount("close"), 0);
    assert.equal(outstanding.size, 0, "successful login must cancel its deadline");
    schedule.mock.restore();
    cancel.mock.restore();
    assert.ok(logs.every((line) => !line.includes(session.bearerToken) && !line.includes(session.wcauthtoken)));
  }));

  it("leaves login/MFA navigation to the person and captures their later trolley request", () => temporary(async (dir) => {
    const fake = fakeBrowser("dummy@example.com", false);
    const visits: string[] = [];
    fake.page.goto = async (url?: string) => {
      visits.push(url ?? "");
    };
    const logs: string[] = [];
    await performLogin(options(dir, { launch: fake.launch, timeoutMs: 1000, log: message => {
      logs.push(message);
      if (message.startsWith("After completing login")) fake.page.emit("request", {
        url: () => "https://www.sainsburys.co.uk/groceries-api/gol-services/basket/v2/basket",
        headers: () => ({ wcauthtoken: fakeSession().wcauthtoken, authorization: `Bearer ${fakeSession().bearerToken}` }),
      });
    } }));
    assert.deepEqual(visits, ["https://www.sainsburys.co.uk/gol-ui/my-account/orders"]);
    assert.ok(logs.some(message => message.includes("open Trolley")));
  }));

  it("rejects wrong accounts and missing identity without persisting credentials", () => temporary(async (dir) => {
    const fake = fakeBrowser("different@example.com");
    const opts = options(dir, { launch: fake.launch });
    await assert.rejects(performLogin(opts), /does not match/);
    assert.equal(await loadSession(opts.config.sessionPath), null);
    assert.equal(fake.closes, 1);
  }));

  it("rejects missing identity and redacts raw browser failures", () => temporary(async (dir) => {
    const fake = fakeBrowser("");
    const opts = options(dir, { launch: fake.launch });
    await assert.rejects(performLogin(opts), /did not provide a verifiable/);
    assert.equal(await loadSession(opts.config.sessionPath), null);
    fake.page.goto = async () => { throw new Error("raw secret bearer-token and cookie-value"); };
    await assert.rejects(performLogin(opts), (err: Error) => {
      assert.match(err.message, /Local browser login failed/);
      assert.doesNotMatch(err.message, /bearer-token|cookie-value/);
      return true;
    });
  }));

  it("coalesces simultaneous login and releases its profile lock", () => temporary(async (dir) => {
    const fake = fakeBrowser("dummy@example.com", true, 20);
    const opts = options(dir, { launch: fake.launch });
    const [a, b] = await Promise.all([performLogin(opts), performLogin(opts)]);
    assert.equal(a, b);
    assert.equal(fake.launches, 1);
    await assert.rejects(stat(`${opts.config.sessionPath}.profile.lock`), { code: "ENOENT" });
  }));

  it("times out with sanitized errors and removes listeners and locks", () => temporary(async (dir) => {
    const fake = fakeBrowser("dummy@example.com", false);
    const opts = options(dir, { launch: fake.launch, timeoutMs: 10 });
    await assert.rejects(performLogin(opts), /timed out/);
    assert.equal(fake.closes, 1);
    assert.equal(fake.page.listenerCount("request"), 0);
    await assert.rejects(stat(`${opts.config.sessionPath}.profile.lock`), { code: "ENOENT" });
  }));

  it("ignores external lookalike API requests", () => temporary(async (dir) => {
    const fake = fakeBrowser("dummy@example.com", false);
    fake.page.goto = async () => { fake.page.emit("request", {
      url: () => "https://www.sainsburys.co.uk.evil.example/groceries-api/steal",
      headers: () => ({ wcauthtoken: fakeSession().wcauthtoken, authorization: "Bearer external" }),
    }); };
    await assert.rejects(performLogin(options(dir, { launch: fake.launch, timeoutMs: 10 })), /timed out/);
  }));

  it("no-persist leaves existing state untouched and launches an isolated temporary profile", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    const opts = options(dir, { persist: false, launch: async (launchOpts) => {
      assert.equal(launchOpts.persist, false);
      assert.equal(launchOpts.headless, false);
      return fake.context;
    } });
    await saveSession(opts.config.sessionPath, fakeSession());
    const before = await readFile(opts.config.sessionPath, "utf8");
    await performLogin(opts);
    assert.equal(await readFile(opts.config.sessionPath, "utf8"), before);
    await assert.rejects(stat(profileRoot(opts.config.sessionPath)), { code: "ENOENT" });
  }));

  it("browser no-persist creates and deletes a real private temporary directory with no unsafe flags", () => temporary(async (dir) => {
    let profile = "";
    const launch = mock.method(chromium, "launchPersistentContext", async (directory: string, opts: Record<string, unknown>) => {
      profile = directory;
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal(opts.channel, undefined);
      assert.equal(opts.args, undefined);
      return { close: async () => {} } as unknown as BrowserContext;
    });
    try {
      const context = await launchContext({ sessionPath: join(dir, "session.json"), accountEmail: "dummy@example.com", headless: false, persist: false });
      assert.ok(profile && !profile.startsWith(dir));
      await context.close();
      await assert.rejects(stat(profile), { code: "ENOENT" });
    } finally { launch.mock.restore(); }
  }));

  it("does not report success or save credentials when browser cleanup fails", () => temporary(async (dir) => {
    const fake = fakeBrowser();
    fake.context.close = async () => { throw new Error("secret browser URL or cookie"); };
    const opts = options(dir, { persist: false, launch: fake.launch });
    await assert.rejects(performLogin(opts), (err: Error) => {
      assert.match(err.message, /Could not close the login browser or clean/);
      assert.doesNotMatch(err.message, /cookie/);
      return true;
    });
    assert.equal(await loadSession(opts.config.sessionPath), null);
  }));

  it("cleans a temporary profile if Chromium launch fails", () => temporary(async (dir) => {
    let profile = "";
    const launch = mock.method(chromium, "launchPersistentContext", async (directory: string) => {
      profile = directory;
      throw new Error("raw browser details");
    });
    try {
      await assert.rejects(launchContext({ sessionPath: join(dir, "session.json"), headless: false, persist: false }), /Could not launch/);
      await assert.rejects(stat(profile), { code: "ENOENT" });
    } finally { launch.mock.restore(); }
  }));

  it("assigns a distinct login generation even when the browser reuses the same credentials", () => temporary(async dir => {
    const fake = fakeBrowser();
    const first = await performLogin(options(dir, { launch: fake.launch }));
    const second = await performLogin(options(dir, { launch: fake.launch }));
    assert.match(first.authGeneration!, /^[a-f0-9-]{36}$/);
    assert.notEqual(first.authGeneration, second.authGeneration);
    assert.equal((await loadSession(options(dir).config.sessionPath))?.authGeneration, second.authGeneration);
  }));

  it("cached-session clients need no password and never launch login", async () => {
    const previous = process.env.SAINSBURYS_EMAIL;
    delete process.env.SAINSBURYS_EMAIL;
    try {
      const client = await createClient({ session: fakeSession(), autoReauth: true });
      assert.equal(client.getSession().userId, "123456789");
    } finally {
      if (previous === undefined) delete process.env.SAINSBURYS_EMAIL;
      else process.env.SAINSBURYS_EMAIL = previous;
    }
  });
});
