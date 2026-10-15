import { mkdir, readFile, unlink, lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
  bearerToken: string;
  userId: string;
  /** Account email checked against the live customer profile during local login. */
  accountEmail?: string;
  storeNumber?: string;
  capturedAt: number;
  userAgent: string;
}

/** Secret storage must be private before any contents are written. */
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())) {
    throw new Error(`Authentication directory must be owned by you and mode 0700: ${path}`);
  }
}

/** Cross-process exclusive lock. Stale locks fail clearly rather than risking concurrent writes. */
export async function withAuthLock<T>(path: string, run: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  await privateDirectory(dirname(path));
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() >= deadline) throw new Error(`Authentication state is busy or a stale lock needs removal: ${path}`);
      await new Promise((done) => setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
  }
  try {
    await handle.writeFile(String(process.pid));
    return await run();
  } finally {
    await handle.close();
    await unlink(path);
  }
}

export function profileRoot(sessionPath: string): string {
  const key = createHash("sha256").update(resolve(sessionPath)).digest("hex").slice(0, 20);
  return join(dirname(sessionPath), `profiles-${key}`);
}

function validSession(value: unknown): value is Session {
  if (!value || typeof value !== "object") return false;
  const s = value as Session;
  return Array.isArray(s.cookies) && s.cookies.every((c) => c &&
    typeof c.name === "string" && !/[\r\n;=]/.test(c.name) &&
    typeof c.value === "string" && !/[\r\n;]/.test(c.value) &&
    typeof c.domain === "string" && typeof c.path === "string") &&
    typeof s.wcauthtoken === "string" && !!s.wcauthtoken && !/[\r\n]/.test(s.wcauthtoken) &&
    typeof s.bearerToken === "string" && !!s.bearerToken && !/[\r\n]/.test(s.bearerToken) &&
    typeof s.userId === "string" && /^\d+$/.test(s.userId) &&
    Number.isFinite(s.capturedAt) && typeof s.userAgent === "string" &&
    (s.accountEmail === undefined || typeof s.accountEmail === "string");
}

export async function loadSession(path: string): Promise<Session | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) {
      throw new Error(`Session file must be owned by you and mode 0600: ${path}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("Session file is malformed; run local auth login again."); }
    if (!validSession(parsed)) throw new Error("Session file has an invalid shape; run local auth login again.");
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveSession(path: string, session: Session): Promise<void> {
  if (!validSession(session)) throw new Error("Refusing to save an invalid session.");
  await withAuthLock(`${path}.lock`, async () => {
    // Refuse symlink destinations. Rename itself never follows the destination.
    const existing = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe session file destination.");
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(session, null, 2), "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, path);
    } finally {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  });
}

/** Remove session JSON and every browser profile associated with this session path. */
export async function clearSession(path: string): Promise<void> {
  await withAuthLock(`${path}.profile.lock`, () => withAuthLock(`${path}.lock`, async () => {
    await rm(path, { force: true });
    await rm(profileRoot(path), { recursive: true, force: true });
    // Also remove the original version's shared profile, so upgrading then logging out clears it.
    await rm(join(dirname(path), "browser-data"), { recursive: true, force: true });
  }));
}

export async function sessionExists(path: string): Promise<boolean> {
  return (await loadSession(path)) !== null;
}

export function cookieHeader(cookies: SessionCookie[], host = "www.sainsburys.co.uk"): string {
  const eligible = cookies.filter((c) => domainMatches(c.domain, host) &&
    (c.expires === undefined || c.expires === -1 || c.expires > Date.now() / 1000));
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
  let decoded;
  try { decoded = decodeURIComponent(token); } catch { throw new Error("Invalid authentication token encoding."); }
  const idx = decoded.indexOf(",");
  const userId = decoded.slice(0, idx);
  const hmac = decoded.slice(idx + 1);
  if (idx < 1 || !/^\d+$/.test(userId) || !hmac) throw new Error("Invalid authentication token format.");
  return { userId, hmac };
}
