import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuthEvent, authEventsPath, clearAuthEvents, readAuthEvents } from "../src/auth/events.js";

async function temporary(run: (sessionPath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sainsburys-events-test-"));
  try { await run(join(dir, "session.json")); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe("authentication timeline", () => {
  it("appends fixed categories privately and ignores foreign lines", () => temporary(async path => {
    await appendAuthEvent(path, "verified", Date.UTC(2026, 9, 16, 9));
    await writeFile(authEventsPath(path), '{"at":"2026-10-16T09:01:00.000Z","event":"secret-token"}\nnot json\n', { flag: "a" });
    await appendAuthEvent(path, "rejected", Date.UTC(2026, 9, 16, 9, 20));
    assert.equal((await stat(authEventsPath(path))).mode & 0o777, 0o600);
    assert.deepEqual(await readAuthEvents(path), [
      { at: "2026-10-16T09:00:00.000Z", event: "verified" },
      { at: "2026-10-16T09:20:00.000Z", event: "rejected" },
    ]);
    await clearAuthEvents(path);
    assert.deepEqual(await readAuthEvents(path), []);
  }));
  it("keeps the newer half once the size cap is exceeded", () => temporary(async path => {
    const line = JSON.stringify({ at: "2026-10-16T09:00:00.000Z", event: "heartbeat_ok" }) + "\n";
    await writeFile(authEventsPath(path), line.repeat(Math.ceil(300 * 1024 / line.length)), { mode: 0o600 });
    await appendAuthEvent(path, "verified");
    const text = await readFile(authEventsPath(path), "utf8");
    assert.ok(text.length < 200 * 1024);
    assert.equal((await readAuthEvents(path, 1))[0]!.event, "verified");
    assert.equal((await stat(authEventsPath(path))).mode & 0o777, 0o600);
  }));
});
