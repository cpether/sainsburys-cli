import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { clearSession, loadSession, privateDirectory, processIsAlive, withAuthLock, type Session } from "../auth/session.js";
import { AuthError, RequestCancelledError, RequestTimeoutError, ResponseValidationError } from "./http.js";
import { interruptionSignal } from "../auth/lifecycle.js";

export const RESIDENT_INPUT_LIMIT = 1024 * 1024;
export const RESIDENT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const ORIGIN = "https://www.sainsburys.co.uk";
export interface ResidentOwner { version: 1; pid: number; instanceId: string; sessionHash: string; accountHash: string }
export interface ResidentPaths { root: string; directory: string; socket: string; owner: string; startupLock: string; sessionHash: string }
export function residentServicePaths(sessionPath: string): ResidentPaths {
  const sessionHash = createHash("sha256").update(resolve(sessionPath)).digest("hex");
  const root = `/tmp/sainsburys-${process.getuid?.() ?? "user"}`;
  const directory = join(root, sessionHash.slice(0, 24));
  return { root, directory, socket: join(directory, "rpc.sock"), owner: join(directory, "owner.json"), startupLock: join(root, `${sessionHash.slice(0, 24)}.startup.lock`), sessionHash };
}
export function residentAccountHash(email: string): string { return createHash("sha256").update(email.trim().toLowerCase()).digest("hex"); }

export async function prepareResidentDirectory(paths: ResidentPaths): Promise<void> {
  try { await privateDirectory(paths.root); await privateDirectory(paths.directory); }
  catch { throw new Error("Resident browser storage must be private, owned by you and free of symbolic links."); }
}
export async function readResidentOwner(paths: ResidentPaths): Promise<ResidentOwner | null> {
  for (const directory of [paths.root, paths.directory]) {
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("Resident browser storage is unsafe.");
  }
  const info = await lstat(paths.owner).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("Resident browser ownership metadata is unsafe.");
  let value: Partial<ResidentOwner>;
  try { value = JSON.parse(await readFile(paths.owner, "utf8")) as Partial<ResidentOwner>; }
  catch { throw new Error("Resident browser ownership metadata is invalid. Inspect local resident state before restarting."); }
  if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid! < 1 ||
      typeof value.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(value.instanceId) ||
      value.sessionHash !== paths.sessionHash || typeof value.accountHash !== "string" || !/^[a-f0-9]{64}$/.test(value.accountHash)) throw new Error("Resident browser ownership metadata is invalid.");
  return value as ResidentOwner;
}
async function checkSocket(paths: ResidentPaths): Promise<void> {
  const info = await lstat(paths.socket);
  if (!info.isSocket() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error("Resident browser socket is unsafe.");
}
export async function cleanDeadResident(paths: ResidentPaths): Promise<void> {
  const owner = await readResidentOwner(paths);
  if (owner && processIsAlive(owner.pid)) throw new Error("A resident browser owner is still running. Use auth stop or inspect the local process; it will not be killed automatically.");
  const socket = await lstat(paths.socket).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (socket) {
    if (!owner) throw new Error("An unrecognized resident socket exists. Inspect local state before restarting.");
    await checkSocket(paths);
    await rm(paths.socket);
  }
  if (owner) await rm(paths.owner);
}

type RpcResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; status?: number } };
export class ResidentRpcError extends Error {
  constructor(public readonly code: string, public readonly status?: number) {
    super(code === "TIMEOUT" ? "The resident browser operation exceeded its deadline." : code === "CANCELLED" ? "The resident browser operation was cancelled." : "The resident browser operation could not be completed. Inspect auth status and run local auth login if needed.");
    this.name = "ResidentRpcError";
  }
}
export async function residentRpc(sessionPath: string, input: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal = signal ? AbortSignal.any([signal, interruptionSignal()]) : interruptionSignal();
  if (signal?.aborted) throw new ResidentRpcError("CANCELLED");
  const paths = residentServicePaths(sessionPath);
  const owner = await readResidentOwner(paths);
  if (!owner || !processIsAlive(owner.pid)) throw new ResidentRpcError("UNAVAILABLE");
  await checkSocket(paths);
  if (signal?.aborted) throw new ResidentRpcError("CANCELLED");
  const deadlineMs = Date.now() + timeoutMs;
  const message = Buffer.from(JSON.stringify({ ...input, instanceId: owner.instanceId, timeoutMs, deadlineMs }) + "\n");
  if (message.byteLength > RESIDENT_INPUT_LIMIT) throw new ResidentRpcError("REQUEST_TOO_LARGE");
  return new Promise((done, reject) => {
    let settled = false;
    let chunks: Buffer[] = []; let length = 0;
    const socket = createConnection(paths.socket);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      socket.destroy();
      if (error) reject(error); else done(value!);
    };
    const cancel = () => finish(new ResidentRpcError("CANCELLED"));
    const timer = setTimeout(() => finish(new ResidentRpcError("TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    socket.once("connect", () => { if (signal?.aborted) cancel(); else socket.write(message); });
    socket.on("data", (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > RESIDENT_OUTPUT_LIMIT) { finish(new ResidentRpcError("RESPONSE_TOO_LARGE")); return; }
      chunks.push(chunk);
      const joined = Buffer.concat(chunks, length);
      const newline = joined.indexOf(10);
      if (newline < 0) return;
      let reply: RpcResult | {ready: true};
      try { reply = JSON.parse(joined.subarray(0, newline).toString("utf8")) as RpcResult | {ready: true}; }
      catch { finish(new ResidentRpcError("PROTOCOL")); return; }
      chunks = []; length = 0;
      if (reply && typeof reply === "object" && "ready" in reply && reply.ready === true) {
        if (Date.now() >= deadlineMs) finish(new ResidentRpcError("TIMEOUT"));
        else if (signal?.aborted) cancel(); else socket.write(JSON.stringify({proceed: true}) + "\n");
        return;
      }
      if (!reply || typeof reply !== "object" || ! ("ok" in reply) || typeof reply.ok !== "boolean") { finish(new ResidentRpcError("PROTOCOL")); return; }
      if (!reply.ok) {
        const code = typeof reply.error?.code === "string" && /^[A-Z_]{1,40}$/.test(reply.error.code) ? reply.error.code : "PROTOCOL";
        const status = Number.isInteger(reply.error?.status) && reply.error.status! >= 400 && reply.error.status! <= 599 ? reply.error.status : undefined;
        finish(new ResidentRpcError(code, status)); return;
      }
      if (!reply.result || typeof reply.result !== "object" || Array.isArray(reply.result)) { finish(new ResidentRpcError("PROTOCOL")); return; }
      finish(undefined, reply.result);
    });
    socket.once("error", () => finish(new ResidentRpcError("UNAVAILABLE")));
    socket.once("close", () => { if (!settled) finish(new ResidentRpcError("DISCONNECTED")); });
    if (signal?.aborted) cancel();
  });
}

export async function residentStatus(sessionPath: string): Promise<{ running: boolean; authenticated: boolean; needsLogin: boolean }> {
  const owner = await readResidentOwner(residentServicePaths(sessionPath));
  if (!owner || !processIsAlive(owner.pid)) return { running: false, authenticated: false, needsLogin: true };
  const result = await residentRpc(sessionPath, { operation: "status" }, 2000);
  if (result.instanceId !== owner.instanceId || result.pid !== owner.pid) throw new Error("Resident browser process identity could not be verified.");
  return { running: true, authenticated: result.authenticated === true, needsLogin: result.needsLogin !== false };
}

export async function residentAuthenticationDiagnostic(sessionPath: string): Promise<Record<string, unknown>> {
  const result = await residentRpc(sessionPath, {operation:"diagnose"}, 30_000);
  const d = result.diagnostic as Record<string, unknown> | undefined;
  if (!d || !["retailer","account_sign_in","account_other","other","absent"].includes(String(d.page)) ||
      [d.authenticated,d.passwordFieldVisible,d.mfaFieldVisible,d.storedCredentialsAvailable].some(v=>typeof v!=="boolean") ||
      !Number.isInteger(d.credentialPairsObserved) || Number(d.credentialPairsObserved)<0 || Number(d.credentialPairsObserved)>16) throw new ResidentRpcError("PROTOCOL");
  // Fields added later are optional so an older resident process still reports its categories.
  const time = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  return {authenticated:d.authenticated,page:d.page,passwordFieldVisible:d.passwordFieldVisible,
    mfaFieldVisible:d.mfaFieldVisible,
    usernameFieldVisible:typeof d.usernameFieldVisible === "boolean" ? d.usernameFieldVisible : null,
    namedPasswordFieldVisible:typeof d.namedPasswordFieldVisible === "boolean" ? d.namedPasswordFieldVisible : null,
    credentialPairsObserved:d.credentialPairsObserved,storedCredentialsAvailable:d.storedCredentialsAvailable,
    autoSignIn:["unavailable","available","blocked"].includes(String(d.autoSignIn)) ? d.autoSignIn : "unavailable",
    lastVerifiedAt:time(d.lastVerifiedAt),lastHeartbeatAt:time(d.lastHeartbeatAt),lastHeartbeatOk:typeof d.lastHeartbeatOk === "boolean" ? d.lastHeartbeatOk : null};
}

export async function ensureResidentService(config: Config, expected?: {userId: string; authGeneration?: string}): Promise<void> {
  const paths = residentServicePaths(config.sessionPath);
  await prepareResidentDirectory(paths);
  await withAuthLock(paths.startupLock, async () => {
    const cached = await loadSession(config.sessionPath);
    if (expected && (!cached || cached.userId !== expected.userId || cached.authGeneration !== expected.authGeneration)) {
      throw new AuthError(401, "Local authentication changed or was logged out. Start a new command after local login.");
    }
    const email = config.email.trim().toLowerCase() || cached?.accountEmail?.toLowerCase() || "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Set SAINSBURYS_EMAIL to the account for local browser login.");
    if (cached?.accountEmail && email !== cached.accountEmail.toLowerCase()) throw new Error("Resident account differs from the requested account. Run auth logout before changing accounts.");
    const owner = await readResidentOwner(paths);
    if (owner && processIsAlive(owner.pid)) {
      if (owner.accountHash !== residentAccountHash(email)) throw new Error("Resident account differs from the requested account. Run auth logout before changing accounts.");
      await residentStatus(config.sessionPath);
      return;
    }
    await cleanDeadResident(paths);
    const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const entry = fileURLToPath(new URL(`../auth/service${extension}`, import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.SAINSBURYS_SESSION_PATH = resolve(config.sessionPath);
    env.SAINSBURYS_EMAIL = email;
    if (process.env.SAINSBURYS_AUTO_SIGN_IN !== undefined) env.SAINSBURYS_AUTO_SIGN_IN = process.env.SAINSBURYS_AUTO_SIGN_IN;
    const child = spawn(process.execPath, [...(extension === ".ts" ? ["--import", "tsx"] : []), entry], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, detached: true, stdio: "ignore" });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.unref();
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && !failed) {
      const current = await readResidentOwner(paths);
      if (current && processIsAlive(current.pid)) {
        try { await residentStatus(config.sessionPath); return; }
        catch { /* The owner can be published just before the socket is listening. */ }
      }
      await new Promise(done => setTimeout(done, 40));
    }
    throw new Error("Resident browser could not start. Check private storage and Chromium installation, then run auth login locally.");
  }, 15_000);
}

export async function residentLogin(config: Config): Promise<{ user_id: string; session_path: string }> {
  await ensureResidentService(config);
  const email = config.email || (await loadSession(config.sessionPath))?.accountEmail || "";
  let result: Record<string, unknown>;
  try { result = await residentRpc(config.sessionPath, { operation: "login", accountHash: residentAccountHash(email) }, 310_000, interruptionSignal()); }
  catch (error) {
    if (error instanceof ResidentRpcError && (error.status === 401 || error.status === 403)) throw new AuthError(error.status, "Local browser login requires your participation. Complete login and MFA in the resident browser, then retry auth login.");
    throw error;
  }
  if (typeof result.user_id !== "string" || !/^\d+$/.test(result.user_id)) throw new ResidentRpcError("PROTOCOL");
  return { user_id: result.user_id, session_path: resolve(config.sessionPath) };
}

export function residentFetch(sessionPath: string, session: Session): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ResponseValidationError("Resident retailer URL is invalid."); }
    if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash) throw new ResponseValidationError("Resident requests require the exact retailer HTTPS origin.");
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    const source = new Headers(init?.headers);
    for (const key of ["x-http-method-override", "enabled-feature-flags"]) if (source.has(key)) headers[key] = source.get(key)!;
    if (init?.body !== undefined && typeof init.body !== "string") throw new Error("Resident request body must be serialized JSON.");
    let result: Record<string, unknown>;
    try {
      result = await residentRpc(sessionPath, { operation: "request", expectedUserId: session.userId, authGeneration: session.authGeneration, request: { url, method, headers, ...(init?.body !== undefined ? { body: init.body } : {}) } }, 60_000, init?.signal ?? undefined);
    } catch (error) {
      if (error instanceof ResidentRpcError && error.status) return Response.json({ error: { code: error.code } }, { status: error.status });
      if (error instanceof ResidentRpcError) {
        if (error.code === "CANCELLED") throw new RequestCancelledError();
        if (error.code === "TIMEOUT") throw new RequestTimeoutError();
        if (["RESPONSE_VALIDATION", "PROTOCOL", "RESPONSE_TOO_LARGE", "REQUEST_TOO_LARGE", "INVALID_REQUEST"].includes(error.code)) throw new ResponseValidationError("The resident browser response failed validation.");
      }
      throw new Error("Resident browser request failed. Inspect auth status and run auth login locally if required.");
    }
    if (typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 ||
        typeof result.body !== "string" || Buffer.byteLength(result.body) > RESIDENT_OUTPUT_LIMIT || typeof result.contentType !== "string") throw new ResponseValidationError("The resident browser response failed validation.");
    try { return new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: { "content-type": result.contentType } }); }
    catch { throw new ResponseValidationError("The resident browser response failed validation."); }
  };
}

async function stopResidentUnlocked(sessionPath: string): Promise<void> {
  const paths = residentServicePaths(sessionPath);
  const owner = await readResidentOwner(paths);
  if (!owner || !processIsAlive(owner.pid)) { await cleanDeadResident(paths); return; }
  const result = await residentRpc(sessionPath, { operation: "stop" }, 30_000);
  if (result.stopped !== true) throw new ResidentRpcError("PROTOCOL");
}

/** Startup and explicit stop use the same lock, so they cannot create crossing daemons. */
export async function stopResidentService(sessionPath: string): Promise<void> {
  const paths = residentServicePaths(sessionPath);
  await prepareResidentDirectory(paths);
  await withAuthLock(paths.startupLock, () => stopResidentUnlocked(sessionPath), 35_000);
}

/** Stop the owner and delete all local authentication state as one startup transaction. */
export async function logoutResidentSession(sessionPath: string): Promise<void> {
  const paths = residentServicePaths(sessionPath);
  await prepareResidentDirectory(paths);
  await withAuthLock(paths.startupLock, async () => {
    await stopResidentUnlocked(sessionPath);
    await clearSession(sessionPath);
  }, 40_000);
}
