import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cookieHeader,
  loadSession,
  parseWcauthtoken,
  saveSession,
  sessionExists,
  clearSession,
} from "../src/auth/session.js";
import { fakeSession } from "./_helpers.js";

describe("session storage", () => {
  it("saves and loads a session round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sainsburys-test-"));
    const path = join(dir, "session.json");
    try {
      const s = fakeSession();
      await saveSession(path, s);
      assert.equal(await sessionExists(path), true);
      const loaded = await loadSession(path);
      assert.deepEqual(loaded, s);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when session file missing", async () => {
    const path = join(tmpdir(), "definitely-not-a-real-file-" + Math.random());
    assert.equal(await loadSession(path), null);
    assert.equal(await sessionExists(path), false);
  });

  it("clearSession is idempotent on missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sainsburys-logout-test-"));
    try {
      const path = join(dir, "missing.json");
      await clearSession(path);
      await clearSession(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cookieHeader", () => {
  it("formats cookies as name=value pairs separated by '; '", () => {
    const s = fakeSession();
    const h = cookieHeader(s.cookies);
    assert.equal(h, "WC_AUTHENTICATION_123456789=abc%2B; JSESSIONID=0000XYZ; _abck=abck-token");
  });

  it("handles empty cookie list", () => {
    assert.equal(cookieHeader([]), "");
  });
});

describe("parseWcauthtoken", () => {
  it("decodes URL-encoded form and splits on first comma", () => {
    const { userId, hmac } = parseWcauthtoken(
      "123456789%2CAbCdEfGhIjKlMnOpQrStUvWxYz0%3D",
    );
    assert.equal(userId, "123456789");
    assert.equal(hmac, "AbCdEfGhIjKlMnOpQrStUvWxYz0=");
  });

  it("throws on malformed token", () => {
    assert.throws(() => parseWcauthtoken("bogus"));
  });
});
