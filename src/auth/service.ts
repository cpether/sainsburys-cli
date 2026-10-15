import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../config.js";
import { loadSession, withAuthLock, type Session } from "./session.js";
import { registerCleanup } from "./lifecycle.js";
import { ApiError, AuthError, RequestCancelledError, RequestTimeoutError, ResponseValidationError } from "../client/http.js";
import { RESIDENT_INPUT_LIMIT, RESIDENT_OUTPUT_LIMIT, prepareResidentDirectory, readResidentOwner, residentAccountHash, residentServicePaths, type ResidentOwner } from "../client/resident-service.js";
import { ResidentBrowser } from "./resident-browser.js";

export interface ResidentEngine {
  start(options: { interactive: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  login(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Session>;
  request(input: { url: string; method: string; headers: Record<string, string>; body?: string }, signal?: AbortSignal): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  getSession(): Session | undefined;
  getSessionBinding?(): { userId: string; authGeneration?: string } | undefined;
  status(): { authenticated: boolean; needsLogin: boolean };
  diagnoseAuthentication?(): Promise<import("./resident-browser.js").AuthenticationDiagnostic>;
  close(): Promise<void>;
}
export type ResidentEngineFactory = (options: { config: Config; session?: Session }) => ResidentEngine;

function errorReply(error: unknown): { ok: false; error: { code: string; status?: number } } {
  if (error instanceof AuthError) return { ok: false, error: { code: "AUTHENTICATION_REQUIRED", status: error.status === 403 ? 403 : 401 } };
  if (error instanceof ResponseValidationError) return { ok: false, error: { code: "RESPONSE_VALIDATION" } };
  if (error instanceof ApiError && error.status >= 400 && error.status <= 599 && !(error instanceof ResponseValidationError)) return { ok: false, error: { code: "RETAILER_REJECTED", status: error.status } };
  if (error instanceof RequestCancelledError) return { ok: false, error: { code: "CANCELLED" } };
  if (error instanceof RequestTimeoutError) return { ok: false, error: { code: "TIMEOUT" } };
  return { ok: false, error: { code: "BROWSER_OPERATION_FAILED" } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resident message.");
  return value as Record<string, unknown>;
}

/** The promise resolves only after browser closure, socket cleanup and profile-lock release. */
export async function runResidentService(config: Config, engineFactory: ResidentEngineFactory = options => new ResidentBrowser(options)): Promise<void> {
  config = { ...config, sessionPath: resolve(config.sessionPath) };
  const paths = residentServicePaths(config.sessionPath);
  await prepareResidentDirectory(paths);
  const instanceId = randomUUID();
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  const stopWaiters: Socket[] = [];
  let stopping = false;
  let engine: ResidentEngine | undefined;
  let initial: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();
  let finishLifetime!: () => void;
  const lifetime = new Promise<void>(done => { finishLifetime = done; });
  let shutdown: Promise<void> | undefined;
  let shutdownFailed = false;
  const server = createServer({ allowHalfOpen: true });
  const stop = () => shutdown ??= (async () => {
    stopping = true;
    if (server.listening) server.close();
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) if (!stopWaiters.includes(socket)) socket.destroy();
    try {
      try { await engine?.close(); } catch { shutdownFailed = true; }
      // Even a close error must not release the profile while accepted work is
      // still alive. A failed stop remains bounded at the caller and fails closed.
      await initial.catch(() => {}); await queue.catch(() => {});
      if (shutdownFailed) throw new Error("Resident browser cleanup failed.");
    } finally { finishLifetime(); }
  })();
  const reply = (socket: Socket, value: unknown) => {
    if (socket.destroyed) return;
    let data = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(data) > RESIDENT_OUTPUT_LIMIT) data = JSON.stringify({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } }) + "\n";
    socket.end(data);
  };
  const clearOwnedEndpoint = async () => {
    const current = await readResidentOwner(paths).catch(() => null);
    if (current?.instanceId === instanceId) { await rm(paths.socket, {force: true}); await rm(paths.owner, {force: true}); }
  };
  let owner: ResidentOwner | undefined;
  try {
    await withAuthLock(`${config.sessionPath}.profile.lock`, async () => {
      const session = await loadSession(config.sessionPath) ?? undefined;
      const email = config.email.trim().toLowerCase() || session?.accountEmail?.toLowerCase() || "";
      if (session?.accountEmail && email !== session.accountEmail.toLowerCase()) throw new Error("Resident account differs; log out before changing accounts.");
      config = { ...config, email };
      engine = engineFactory({ config, session });
      owner = { version: 1, pid: process.pid, instanceId, sessionHash: paths.sessionHash, accountHash: residentAccountHash(email) };
      const ownerTemporary = `${paths.owner}.${instanceId}.tmp`;
      const file = await open(ownerTemporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(owner)); await file.sync(); await file.close();
        // Publish a complete inode atomically without overwriting an existing owner.
        await link(ownerTemporary, paths.owner);
      } finally { await file.close().catch(() => {}); await rm(ownerTemporary, {force: true}); }
      server.on("connection", socket => {
        sockets.add(socket);
        socket.on("error", () => {});
        let length = 0; const chunks: Buffer[] = []; let accepted = false;
        let approveDispatch: (() => void) | undefined;
        let approvalBytes = Buffer.alloc(0);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { controller.abort(); socket.destroy(); }, 5000);
        socket.once("end", () => { controller.abort(); socket.destroy(); });
        socket.once("close", () => { sockets.delete(socket); controller.abort(); if (timer) clearTimeout(timer); });
        socket.on("data", (chunk: Buffer) => {
          if (accepted) {
            if (approveDispatch && approvalBytes.byteLength + chunk.byteLength <= 128) {
              approvalBytes = Buffer.concat([approvalBytes, chunk]);
              const end = approvalBytes.indexOf(10);
              if (end < 0) return;
              try {
                const approval = JSON.parse(approvalBytes.subarray(0, end).toString("utf8"));
                if (approval?.proceed === true && !approvalBytes.subarray(end + 1).toString("utf8").trim()) { const approve = approveDispatch; approveDispatch = undefined; approve(); return; }
              } catch { /* Only the fixed dispatch acknowledgement is accepted. */ }
            }
            controller.abort(); socket.destroy(); return;
          }
          length += chunk.byteLength;
          if (length > RESIDENT_INPUT_LIMIT) { reply(socket, { ok: false, error: { code: "REQUEST_TOO_LARGE" } }); accepted = true; return; }
          chunks.push(chunk);
          const message = Buffer.concat(chunks, length);
          const newline = message.indexOf(10);
          if (newline < 0) return;
          if (message.subarray(newline + 1).toString("utf8").trim()) { reply(socket, {ok: false, error: {code: "INVALID_REQUEST"}}); accepted = true; return; }
          accepted = true;
          if (timer) clearTimeout(timer);
          let input: Record<string, unknown>;
          try { input = record(JSON.parse(message.subarray(0, newline).toString("utf8"))); }
          catch { reply(socket, { ok: false, error: { code: "INVALID_REQUEST" } }); return; }
          if (input.instanceId !== instanceId || stopping) { reply(socket, { ok: false, error: { code: "UNAVAILABLE" } }); return; }
          const operation = input.operation;
          if (operation === "status") { reply(socket, { ok: true, result: { ...engine!.status(), pid: process.pid, instanceId } }); return; }
          if (operation === "stop") { stopWaiters.push(socket); void stop().catch(() => {}); return; }
          const maximum = operation === "login" ? 310_000 : 60_000;
          if (typeof input.timeoutMs !== "number" || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > maximum) { reply(socket, { ok: false, error: { code: "INVALID_REQUEST" } }); return; }
          if (typeof input.deadlineMs !== "number" || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs > Date.now() + maximum + 1000) { reply(socket, {ok: false, error: {code: "INVALID_REQUEST"}}); return; }
          const deadlineMs = input.deadlineMs;
          if (Date.now() >= deadlineMs) { reply(socket, {ok: false, error: {code: "TIMEOUT"}}); return; }
          controllers.add(controller);
          timer = setTimeout(() => { controller.abort(); reply(socket, { ok: false, error: { code: "TIMEOUT" } }); }, Math.min(input.timeoutMs, Math.max(1, deadlineMs - Date.now())));
          const task = queue.then(async () => {
            await initial.catch(() => {});
            if (Date.now() >= deadlineMs) throw new RequestTimeoutError();
            if (controller.signal.aborted || stopping) throw new RequestCancelledError();
            if (operation !== "login" && operation !== "request" && operation !== "diagnose") throw new Error("Invalid resident operation.");
            // A queued client may have timed out before its FIN reaches this event
            // loop. Require a fresh acknowledgement before touching the browser.
            await new Promise<void>((done, reject) => {
              const cancel = () => { approveDispatch = undefined; reject(new RequestCancelledError()); };
              approveDispatch = () => { controller.signal.removeEventListener("abort", cancel); done(); };
              controller.signal.addEventListener("abort", cancel, {once: true});
              if (controller.signal.aborted || socket.destroyed) cancel();
              else socket.write(JSON.stringify({ready: true}) + "\n");
            });
            if (Date.now() >= deadlineMs) throw new RequestTimeoutError();
            if (controller.signal.aborted || stopping) throw new RequestCancelledError();
            if (operation === "diagnose") {
              if (!engine!.diagnoseAuthentication) throw new Error("Authentication diagnostics are unavailable.");
              return {diagnostic:await engine!.diagnoseAuthentication()};
            }
            if (operation === "login") {
              if (input.accountHash !== owner!.accountHash) throw new AuthError(401);
              const loggedIn = await engine!.login({ signal: controller.signal, timeoutMs: 300_000 });
              if (controller.signal.aborted) throw new RequestCancelledError();
              return { user_id: loggedIn.userId };
            }
            if (operation !== "request") throw new Error("Invalid resident operation.");
            // Failed silent refresh retains only the account/epoch binding. The
            // engine still validates each operation and refuses unauthenticated
            // writes, while a later read may recover in its existing context.
            const binding = engine!.getSession() ?? engine!.getSessionBinding?.();
            if (!binding || typeof input.authGeneration !== "string" || input.authGeneration !== binding.authGeneration || input.expectedUserId !== binding.userId) throw new AuthError(401);
            const request = record(input.request);
            if (typeof request.url !== "string" || typeof request.method !== "string" || (request.body !== undefined && typeof request.body !== "string")) throw new Error("Invalid resident request.");
            const sourceHeaders = record(request.headers);
            const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
            for (const name of ["x-http-method-override", "enabled-feature-flags"]) if (typeof sourceHeaders[name] === "string") headers[name] = sourceHeaders[name];
            const result = await engine!.request({ url: request.url, method: request.method, headers, ...(request.body !== undefined ? { body: request.body as string } : {}) }, controller.signal);
            if (controller.signal.aborted) throw new RequestCancelledError();
            if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== "string" || Buffer.byteLength(result.body) > RESIDENT_OUTPUT_LIMIT) throw new ResponseValidationError();
            return { status: result.status, contentType: result.headers["content-type"] ?? "application/json", body: result.body };
          });
          queue = task.catch(() => {});
          void task.then(result => { if (!controller.signal.aborted) reply(socket, { ok: true, result }); }, error => { if (!controller.signal.aborted) reply(socket, errorReply(error)); }).finally(() => { if (timer) clearTimeout(timer); controllers.delete(controller); });
        });
      });
      // The private directory already prevents traversal. The restrictive umask
      // additionally gives the socket mode0600 at bind, without a chmod window.
      const previousMask = process.umask(0o177);
      try { await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(paths.socket, () => { server.off("error", reject); done(); }); }); }
      finally { process.umask(previousMask); }
      const unregister = registerCleanup(async () => { await stop(); await clearOwnedEndpoint(); });
      try {
        if (session?.accountEmail && session.accountEmail.toLowerCase() === email) {
          const controller = new AbortController(); controllers.add(controller);
          initial = engine.start({ interactive: false, signal: controller.signal, timeoutMs: 20_000 }).catch(() => {}).finally(() => { controllers.delete(controller); });
        }
        await lifetime;
        await shutdown;
      } finally { unregister(); }
    });
  } finally {
    if (!stopping) await stop().catch(() => {});
    await clearOwnedEndpoint();
    for (const socket of stopWaiters) reply(socket, shutdownFailed ? { ok: false, error: { code: "BROWSER_CLOSE_FAILED" } } : { ok: true, result: { stopped: true } });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runResidentService(loadConfig()).catch(() => { process.exitCode = 1; });
}
