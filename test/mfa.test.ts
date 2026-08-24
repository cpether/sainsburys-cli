/**
 * Test the MFA chat provider's filtering: only accept messages newer than submittedAt
 * AND containing a 6-digit code.
 *
 * Strategy: replace `con` with a fake script that prints canned JSON, then drive the
 * provider via the real `spawn`. Keeps things end-to-end-ish without any network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conChatMfaProvider } from "../src/auth/mfa-providers.js";

function fakeConBin(jsonResponse: string): { bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-con-"));
  const bin = join(dir, "fake-con");
  // tiny shell script that just prints the canned JSON
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${jsonResponse}\nJSON\n`);
  chmodSync(bin, 0o755);
  return { bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("conChatMfaProvider", () => {
  it("returns the 6-digit code from the most recent post-submit message", async () => {
    const submittedAt = 1_000_000;
    const { bin, cleanup } = fakeConBin(
      JSON.stringify({
        success: true,
        data: {
          messages: [
            {
              timestamp: submittedAt + 5_000,
              content: { body: "Your Sainsbury's Groceries code is 123456. Do not share." },
            },
            {
              timestamp: submittedAt - 10_000,
              content: { body: "old code 999999" },
            },
          ],
        },
      }),
    );
    try {
      const provider = conChatMfaProvider({
        conBin: bin,
        roomId: "!x:beeper.local",
        intervalMs: 10,
        timeoutMs: 1_000,
      });
      const code = await provider(submittedAt);
      assert.equal(code, "123456");
    } finally {
      cleanup();
    }
  });

  it("ignores messages older than submittedAt and times out", async () => {
    const submittedAt = 5_000_000;
    const { bin, cleanup } = fakeConBin(
      JSON.stringify({
        success: true,
        data: {
          messages: [
            {
              timestamp: submittedAt - 1_000,
              content: { body: "stale code 111111 — issued before we submitted" },
            },
          ],
        },
      }),
    );
    try {
      const provider = conChatMfaProvider({
        conBin: bin,
        roomId: "!x:beeper.local",
        intervalMs: 50,
        timeoutMs: 200,
      });
      await assert.rejects(() => provider(submittedAt), /not received/);
    } finally {
      cleanup();
    }
  });

  it("ignores messages without a 6-digit number", async () => {
    const submittedAt = 0;
    const { bin, cleanup } = fakeConBin(
      JSON.stringify({
        success: true,
        data: {
          messages: [
            { timestamp: 100, content: { body: "no digits in here" } },
            { timestamp: 200, content: { body: "only short 12345" } },
          ],
        },
      }),
    );
    try {
      const provider = conChatMfaProvider({
        conBin: bin,
        roomId: "!x:beeper.local",
        intervalMs: 50,
        timeoutMs: 200,
      });
      await assert.rejects(() => provider(submittedAt), /not received/);
    } finally {
      cleanup();
    }
  });
});
