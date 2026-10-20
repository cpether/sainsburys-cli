import { appendFile, open, readFile, rename, rm, stat } from "node:fs/promises";

/**
 * Fixed-category authentication timeline. Records only an event name and a
 * timestamp, never URLs, page text, account data or credential values. It exists
 * to measure how long the retailer actually accepts a resident session.
 */
export const AUTH_EVENTS = [
  "verified", "renewed", "rejected", "heartbeat_ok", "heartbeat_failed",
  "sign_in_form", "auto_sign_in_submitted", "auto_sign_in_failed", "mfa_required",
] as const;
export type AuthEventName = typeof AUTH_EVENTS[number];
export interface AuthEvent { at: string; event: AuthEventName }

const MAX_BYTES = 256 * 1024;

export function authEventsPath(sessionPath: string): string { return `${sessionPath}.auth-events.jsonl`; }

export async function appendAuthEvent(sessionPath: string, event: AuthEventName, now = Date.now()): Promise<void> {
  const path = authEventsPath(sessionPath);
  const size = await stat(path).then(info => info.size, () => 0);
  // Keep only the newer half once the cap is reached; the timeline is evidence, not an audit log.
  if (size > MAX_BYTES) {
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const temporary = `${path}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n"); }
    finally { await file.close(); }
    await rename(temporary, path);
  }
  await appendFile(path, JSON.stringify({ at: new Date(now).toISOString(), event }) + "\n", { mode: 0o600 });
}

export async function readAuthEvents(sessionPath: string, limit = 20): Promise<AuthEvent[]> {
  const text = await readFile(authEventsPath(sessionPath), "utf8").catch(() => "");
  const events: AuthEvent[] = [];
  for (const line of text.split("\n")) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) && AUTH_EVENTS.includes(value.event as AuthEventName)) {
        events.push({ at: value.at, event: value.event as AuthEventName });
      }
    } catch { /* Ignore truncated or foreign lines. */ }
  }
  return events.slice(-limit);
}

export async function clearAuthEvents(sessionPath: string): Promise<void> {
  await rm(authEventsPath(sessionPath), { force: true });
  await rm(`${authEventsPath(sessionPath)}.tmp`, { force: true });
}
