import { mkdir, readFile, writeFile, unlink, stat, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface Session {
  cookies: SessionCookie[];
  wcauthtoken: string;
  /** Hydra-issued OAuth2 access token (JWT). Sent as Authorization: Bearer on every API call. ~1h TTL. */
  bearerToken: string;
  userId: string;
  storeNumber?: string;
  capturedAt: number;
  userAgent: string;
}

export async function loadSession(path: string): Promise<Session | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Session;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveSession(path: string, session: Session): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(session, null, 2), "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // chmod can fail on some filesystems; not fatal
  }
}

export async function clearSession(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function sessionExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a Cookie header for requests to www.sainsburys.co.uk.
 *
 * Filters out cookies scoped to other subdomains (e.g. account.sainsburys.co.uk —
 * those belong to the Hydra OAuth flow and confuse the WCS backend if echoed back).
 * Dedupes by cookie name, preferring the most-specific (longest) domain so that an
 * `www.sainsburys.co.uk` cookie wins over an identically-named `.sainsburys.co.uk` one.
 */
export function cookieHeader(cookies: SessionCookie[], host = "www.sainsburys.co.uk"): string {
  const eligible = cookies.filter((c) => domainMatches(c.domain, host));
  // dedupe by name, keeping the entry with the longest (most specific) domain
  const byName = new Map<string, SessionCookie>();
  for (const c of eligible) {
    const existing = byName.get(c.name);
    if (!existing || c.domain.length > existing.domain.length) byName.set(c.name, c);
  }
  return Array.from(byName.values()).map((c) => `${c.name}=${c.value}`).join("; ");
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
  return host === d || host.endsWith("." + d);
}

export function parseWcauthtoken(token: string): { userId: string; hmac: string } {
  const decoded = decodeURIComponent(token);
  const idx = decoded.indexOf(",");
  if (idx === -1) throw new Error("wcauthtoken missing comma separator");
  return { userId: decoded.slice(0, idx), hmac: decoded.slice(idx + 1) };
}
