import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export type MfaCodeProvider = (submittedAt: number) => Promise<string>;

const CODE_REGEX = /\b(\d{6})\b/;

export interface ConChatProviderOptions {
  conBin: string;
  roomId: string;
  /** poll interval in ms (default 2000). */
  intervalMs?: number;
  /** total timeout in ms (default 90_000). */
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Poll the configured Matrix room (Beeper SMS bridge) for a 6-digit MFA code that
 * was delivered after the form was submitted. Returns the code or throws on timeout.
 */
export function conChatMfaProvider(opts: ConChatProviderOptions): MfaCodeProvider {
  const { conBin, roomId, intervalMs = 2_000, timeoutMs = 90_000, log = () => {} } = opts;
  return async (submittedAt: number) => {
    const deadline = Date.now() + timeoutMs;
    log(`watching ${roomId} for an MFA code (timeout ${Math.round(timeoutMs / 1000)}s)`);
    while (Date.now() < deadline) {
      const code = await fetchLatestCode(conBin, roomId, submittedAt).catch((err) => {
        log(`con chat poll failed: ${err.message}`);
        return undefined;
      });
      if (code) {
        log(`extracted MFA code from chat`);
        return code;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `MFA code not received within ${Math.round(timeoutMs / 1000)}s. ` +
        `Check that ${roomId} is the right room and that con can decrypt it.`,
    );
  };
}

async function fetchLatestCode(
  conBin: string,
  roomId: string,
  submittedAt: number,
): Promise<string | undefined> {
  const out = await runCon(conBin, ["chat", "messages", roomId, "--limit", "5", "--json"]);
  const parsed = JSON.parse(out) as {
    success: boolean;
    data?: { messages: { timestamp: number; content?: { body?: string } }[] };
  };
  if (!parsed.success || !parsed.data) return undefined;
  for (const m of parsed.data.messages) {
    if (m.timestamp <= submittedAt) continue;
    const body = m.content?.body ?? "";
    const match = body.match(CODE_REGEX);
    if (match) return match[1];
  }
  return undefined;
}

function runCon(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`con exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const stdinMfaProvider: MfaCodeProvider = async () => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("Enter the 6-digit MFA code from SMS: ");
    return answer.trim();
  } finally {
    rl.close();
  }
};

/** Pick the right provider based on config. con-chat if a room is set, else stdin. */
export function defaultMfaProvider(opts: {
  conBin: string;
  mfaChatRoomId?: string;
  log?: (msg: string) => void;
}): MfaCodeProvider {
  if (opts.mfaChatRoomId) {
    return conChatMfaProvider({
      conBin: opts.conBin,
      roomId: opts.mfaChatRoomId,
      log: opts.log,
    });
  }
  return stdinMfaProvider;
}
