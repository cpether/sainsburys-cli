import { mkdir, readFile, unlink, lstat, open, rename, rm, readdir, rmdir } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { registerCleanup, throwIfInterrupted } from "./lifecycle.js";
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

/** ESRCH means definitely dead; permission errors and malformed owners fail closed. */
export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function removeClaim(path: string, claim: string): Promise<void> {
  // Only this unique claim may be unlinked. A newly acquired lock has a different
  // filename and is nonempty, so competing reclaimers cannot delete its owner.
  await unlink(join(path, claim)).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
  await rmdir(path).catch((err: NodeJS.ErrnoException) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code ?? "")) throw err;
  });
}

async function reclaimDeadLock(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) return;
    if (info.isFile()) {
      // Legacy releases wrote a plain PID. unlink cannot remove a newly published
      // directory lock, even if another process recovers this file concurrently.
      const text = await readFile(path, "utf8");
      if (/^[1-9]\d*\s*$/.test(text) && !processIsAlive(Number(text.trim()))) {
        await unlink(path).catch((err: NodeJS.ErrnoException) => {
          if (!["ENOENT", "EISDIR", "EPERM"].includes(err.code ?? "")) throw err;
        });
      }
      return;
    }
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) return;
    const entries = await readdir(path);
    if (entries.length === 0) {
      await rmdir(path).catch((err: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code ?? "")) throw err;
      });
      return;
    }
    if (entries.length !== 1) return;
    const claim = entries[0]!;
    const owner = /^([1-9]\d*)-([a-f0-9-]{36})\.owner$/.exec(claim);
    if (owner && !processIsAlive(Number(owner[1]))) await removeClaim(path, claim);
  } catch (err) {
    if (!["ENOENT", "ENOTDIR", "EISDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/** Candidates have never held the lock and contain only their unique PID claim. */
async function clearDeadCandidates(path: string): Promise<void> {
  const prefix = `${basename(path)}.`;
  for (const entry of await readdir(dirname(path))) {
    if (!entry.startsWith(prefix)) continue;
    const owner = /^([1-9]\d*)-[a-f0-9-]{36}\.owner\.candidate$/.exec(entry.slice(prefix.length));
    if (!owner || processIsAlive(Number(owner[1]))) continue;
    const candidate = join(dirname(path), entry);
    const info = await lstat(candidate).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (info?.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 &&
        (!process.getuid || info.uid === process.getuid())) await rm(candidate, {recursive:true,force:true});
  }
}

/** Atomic, nonempty directory locks work across processes and recover dead owners. */
export async function withAuthLock<T>(path: string, run: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  await privateDirectory(dirname(path));
  await clearDeadCandidates(path);
  const deadline = Date.now() + timeoutMs;
  const claim = `${process.pid}-${randomUUID()}.owner`;
  const candidate = `${path}.${claim}.candidate`;
  await mkdir(candidate, { mode: 0o700 });
  let owned = false;
  let publishing: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  const release = () => releasing ??= (async () => {
    await publishing?.catch(() => {});
    if (owned) await removeClaim(path, claim);
    await rm(candidate, { recursive: true, force: true });
  })();
  const unregister = registerCleanup(release);
  try {
    const file = await open(join(candidate, claim), "wx", 0o600);
    try { await file.writeFile(String(process.pid)); } finally { await file.close(); }
    for (;;) {
      throwIfInterrupted();
      try {
        publishing = rename(candidate, path).then(() => { owned = true; });
        await publishing;
        break;
      }
      catch (err) {
        throwIfInterrupted();
        if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
        await reclaimDeadLock(path);
        if (Date.now() >= deadline) throw new Error(`Local state lock is busy or has an unrecognized owner: ${path}`);
        await new Promise((done) => setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    }
    throwIfInterrupted();
    return await run();
  } finally {
    try { await release(); }
    finally { unregister(); }
  }
}

/** Fresh no-persist profiles live outside the persistent authentication directory. */
export function temporaryProfileRoot(sessionPath: string): string {
  const key = createHash("sha256").update(resolve(sessionPath)).digest("hex");
  return join(tmpdir(), `sainsburys-temporary-${key}`);
}

/** Only recognized dead-process directories under this session's private root are removed. */
async function clearAbandonedTemporaryProfiles(sessionPath: string): Promise<void> {
  const root = temporaryProfileRoot(sessionPath);
  try {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())) throw new Error("Unsafe temporary authentication directory.");
    const remaining: string[] = [];
    for (const entry of await readdir(root)) {
      const owner = /^([1-9]\d*)-[a-f0-9-]{36}$/.exec(entry);
      if (!owner) { remaining.push("unrecognized temporary authentication profile; inspect local storage"); continue; }
      if (processIsAlive(Number(owner[1]))) { remaining.push("a temporary login is still active; close it locally, then run logout again"); continue; }
      try { await rm(join(root, entry), { recursive: true, force: true }); }
      catch { remaining.push("an abandoned temporary profile could not be removed"); }
    }
    await rmdir(root).catch((err: NodeJS.ErrnoException) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code ?? "")) throw err;
    });
    if (remaining.length) throw new Error(remaining.join("; "));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
    let cleaning: Promise<void> | undefined;
    const cleanup = () => cleaning ??= (async () => {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
    })();
    const unregister = registerCleanup(cleanup);
    try {
      await file.writeFile(JSON.stringify(session, null, 2), "utf8");
      await file.sync();
      await file.close();
      throwIfInterrupted();
      await rename(temporary, path);
    } finally {
      try { await cleanup(); }
      finally { unregister(); }
    }
  });
}

/** Remove session JSON and every browser profile associated with this session path. */
export async function clearSession(path: string): Promise<void> {
  await withAuthLock(`${path}.profile.lock`, () => withAuthLock(`${path}.lock`, async () => {
    const legacy = join(dirname(path), "browser-data");
    const legacyInfo = await lstat(legacy).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    const knownLegacyDirectory = resolve(dirname(path)) === resolve(join(homedir(), ".config", "sainsburys"));
    const remaining: string[] = [];
    const attempt = async (action: () => Promise<void>, failure: string) => {
      try { await action(); }
      catch (err) { remaining.push(`${failure}${err instanceof Error ? `: ${err.message}` : ""}`); }
    };
    if (legacyInfo && !knownLegacyDirectory) {
      remaining.push("a legacy browser-data folder beside this custom session path has unverified ownership; inspect it locally before removing or relocating it");
    }
    // Clear owned credentials even if a separate profile cannot safely be removed.
    await attempt(() => rm(path, {force:true}), "session file could not be removed");
    await attempt(() => rm(profileRoot(path), {recursive:true,force:true}), "persistent profiles could not be removed");
    await attempt(async () => {
      const prefix = `${basename(path)}.`;
      for (const entry of await readdir(dirname(path))) {
        if (entry.startsWith(prefix) && /^[a-f0-9-]{36}\.tmp$/.test(entry.slice(prefix.length))) {
          await rm(join(dirname(path), entry), {force:true});
        }
      }
    }, "interrupted session files could not be removed");
    await attempt(() => clearAbandonedTemporaryProfiles(path), "temporary profile cleanup is incomplete");
    if (knownLegacyDirectory) await attempt(() => rm(legacy, {recursive:true,force:true}), "legacy profile could not be removed");
    if (remaining.length) throw new Error(`Logout is incomplete: ${remaining.join("; ")}. Run logout again after resolving the remaining state.`);
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
