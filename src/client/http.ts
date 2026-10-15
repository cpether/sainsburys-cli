import { loadSession, saveSession, withAuthLock, type Session } from "../auth/session.js";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { SessionCookies } from "./cookies.js";
import { beginUnverifiedWrite, interruptionSignal } from "../auth/lifecycle.js";
import { ENABLED_FEATURE_FLAGS } from "../lib/feature-flags.js";

export const RETAILER_ORIGIN = "https://www.sainsburys.co.uk";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class AuthError extends Error {
  constructor(public status: number, message = "Authentication required. Log in locally before retrying.") {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  /** Raw responses are deliberately excluded because they can contain credentials or personal data. */
  readonly body: unknown = undefined;
  constructor(public status: number, message: string, _body?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export class ResponseValidationError extends ApiError {
  constructor(message = "The retailer returned an unexpected response.", status = 200) {
    super(status, message);
    this.name = "ResponseValidationError";
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super("The request exceeded its deadline, including any wait for local session access.");
    this.name = "RequestTimeoutError";
  }
}

export class RequestCancelledError extends Error {
  constructor() {
    super("The retailer request was cancelled.");
    this.name = "RequestCancelledError";
  }
}

export class UnknownOutcomeError extends Error {
  readonly outcome = "unknown";
  constructor() {
    super("The basket write outcome is unknown. Inspect the current basket before deciding whether to retry.");
    this.name = "UnknownOutcomeError";
  }
}

export interface HttpOptions<T = unknown> {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Only the known slot-inspection POST with GET override may opt into read semantics. */
  semanticRead?: boolean;
  /** Includes response reading, validation and any read-only reauthentication. Maximum 120 seconds. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Only endpoints with a documented empty response should opt in. */
  allowEmpty?: boolean;
  validate?: (value: unknown) => T;
  /** Override fetch implementation for isolated tests. */
  fetchImpl?: typeof fetch;
}

export interface ClientDeps {
  session: Session;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Managed cached sessions coordinate HTTP, local login and logout at this path. */
  sessionPath?: string;
  /** Read requests only. Concurrent rejected reads share one refresh. */
  reauth?: () => Promise<Session>;
}

export class GroceriesClient {
  private session: Session;
  private readonly fetchImpl: typeof fetch;
  private readonly reauth?: () => Promise<Session>;
  private refreshing?: Promise<void>;
  private readonly sessionPath?: string;
  private readonly authenticationIdentity: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: ClientDeps) {
    const base = trustedUrl(deps.baseUrl);
    if (base.pathname !== "/" || base.search || base.hash) throw new Error("The retailer base URL must be its exact HTTPS origin.");
    this.session = deps.session;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.reauth = deps.reauth;
    if (deps.sessionPath && deps.reauth) throw new Error("Managed cached sessions require explicit local login.");
    this.sessionPath = deps.sessionPath ? resolve(deps.sessionPath) : undefined;
    this.authenticationIdentity = authenticationIdentity(deps.session);
  }

  getSession(): Session { return this.session; }
  setSession(session: Session): void { this.session = session; }

  async request<T = unknown>(path: string, opts: HttpOptions<T> = {}): Promise<T> {
    // Validate everything we can before starting a request or reading credentials.
    const url = this.buildUrl(path, opts.query);
    const timeoutMs = boundedInteger(opts.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, "request deadline");
    const maxBytes = boundedInteger(opts.maxResponseBytes, DEFAULT_RESPONSE_BYTES, MAX_RESPONSE_BYTES, "response size limit");
    const isRead = (opts.method ?? "GET") === "GET" || opts.semanticRead === true;
    if (opts.semanticRead) {
      let override: string | null;
      try { override = new Headers(opts.headers).get("x-http-method-override"); }
      catch { throw new Error("Invalid retailer request headers."); }
      if ((opts.method ?? "GET") !== "POST" ||
        new URL(url).pathname !== "/groceries-api/gol-services/slot/v2/slots" || override?.toUpperCase() !== "GET") {
        throw new Error("Read semantics are only allowed for the known slot inspection endpoint.");
      }
    }
    const signal = opts.signal ? AbortSignal.any([opts.signal, interruptionSignal()]) : interruptionSignal();
    if (signal.aborted) throw new RequestCancelledError();
    const controller = new AbortController();
    let attemptedMutation = false;
    let finishMutation: (() => void) | undefined;
    let timedOut = false;
    let rejectAborted!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const cancel = () => {
      controller.abort();
      rejectAborted(timedOut ? new RequestTimeoutError() : new RequestCancelledError());
    };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
    const onAbort = () => cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([
        this.execute(url, opts, controller.signal, maxBytes, isRead, timeoutMs, () => {
          attemptedMutation = true;
          finishMutation ??= beginUnverifiedWrite();
        }),
        aborted,
      ]);
    } catch (error) {
      if (attemptedMutation && !(error instanceof AuthError) &&
        !(error instanceof ApiError && !(error instanceof ResponseValidationError) && error.status >= 400 && error.status < 500 && error.status !== 408)) {
        throw new UnknownOutcomeError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      finishMutation?.();
    }
  }

  private async execute<T>(
    url: string, opts: HttpOptions<T>, signal: AbortSignal, maxBytes: number,
    isRead: boolean, timeoutMs: number, markMutation: () => void,
  ): Promise<T> {
    let retried = false;
    for (;;) {
      let identityAtRequest: string | undefined;
      const run = async () => {
        if (signal.aborted) throw new RequestCancelledError();
        if (this.sessionPath) {
          const latest = await loadSession(this.sessionPath);
          if (!latest || authenticationIdentity(latest) !== this.authenticationIdentity) {
            throw new AuthError(401, "Local authentication changed or was logged out. Start a new command after local login.");
          }
          this.session = latest;
        }
        if (signal.aborted) throw new RequestCancelledError();
        identityAtRequest = authenticationIdentity(this.session);
        return this.requestInternal(url, opts, signal, maxBytes, isRead, markMutation);
      };
      try {
        if (this.sessionPath) return await withAuthLock(`${this.sessionPath}.profile.lock`, run, timeoutMs, signal);
        const task = this.queue.then(run);
        this.queue = task.catch(() => {});
        return await abortable(task, signal);
      } catch (error) {
        if (signal.aborted) throw new RequestCancelledError();
        if (!(error instanceof AuthError) || !isRead || retried || !this.reauth) throw error;
        // Authentication callbacks run outside the request lock. Concurrent failed
        // reads can join a refresh without blocking the queue or re-entering a lock.
        retried = true;
        if (identityAtRequest === authenticationIdentity(this.session)) await abortable(this.refresh(), signal);
      }
    }
  }

  private async requestInternal<T>(
    url: string, opts: HttpOptions<T>, signal: AbortSignal, maxBytes: number,
    isRead: boolean, markMutation: () => void,
  ): Promise<T> {
    if (signal.aborted) throw new RequestCancelledError();
    const method = opts.method ?? "GET";
    const identityAtRequest = authenticationIdentity(this.session);
    const cookies = new SessionCookies(this.session.cookies);
    const init: RequestInit = { method, headers: this.buildHeaders(opts.headers, url), redirect: "manual", signal };
    if (opts.body !== undefined) init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    if (!isRead) markMutation();
    let response: Response;
    try {
      const pending = (opts.fetchImpl ?? this.fetchImpl)(url, init);
      // An adapter that ignores abort must not deliver a late response to the jar.
      void pending.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      response = await abortable(pending, signal);
    } catch {
      if (signal.aborted) throw new RequestCancelledError();
      throw new ApiError(0, "The retailer request could not be completed.");
    }
    // Native fetch is instructed not to follow redirects. Also reject a fetch adapter that followed one anyway.
    if (response.redirected || (response.url && !sameTrustedUrl(response.url)) || (response.status >= 300 && response.status < 400)) {
      await abortable(response.body?.cancel().catch(() => {}) ?? Promise.resolve(), signal);
      throw new ResponseValidationError("Authenticated retailer redirects are refused.", response.status);
    }
    if (signal.aborted) throw new RequestCancelledError();
    if (identityAtRequest !== authenticationIdentity(this.session)) {
      await abortable(response.body?.cancel().catch(() => {}) ?? Promise.resolve(), signal);
      if (isRead) throw new AuthError(401, "Local authentication changed during the request. Start a new command.");
      throw new ResponseValidationError("Local authentication changed while a write was in flight.");
    }
    if (cookies.accept(response.headers, url)) {
      const updated = { ...this.session, cookies: cookies.snapshot() };
      if (this.sessionPath) {
        try { await saveSession(this.sessionPath, updated, signal); }
        catch {
          void response.body?.cancel().catch(() => {});
          if (signal.aborted) throw new RequestCancelledError();
          throw new ApiError(0, "Updated authentication cookies could not be saved privately. Run local auth login before another operation.");
        }
      }
      if (signal.aborted) throw new RequestCancelledError();
      this.session = updated;
    }
    if (response.status === 401 || response.status === 403) {
      await abortable(response.body?.cancel().catch(() => {}) ?? Promise.resolve(), signal);
      throw new AuthError(response.status);
    }
    if (!response.ok) {
      await abortable(response.body?.cancel().catch(() => {}) ?? Promise.resolve(), signal);
      throw new ApiError(response.status, `The retailer returned HTTP ${response.status}.`);
    }
    const text = await abortable(readBoundedBody(response, maxBytes, signal), signal);
    if (!text.trim()) {
      if (opts.allowEmpty) return this.validateResponse(undefined, opts, response.status);
      throw new ResponseValidationError("The retailer returned an unexpected empty response.", response.status);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (/^\s*</.test(text) || contentType === "text/html") {
      throw new ResponseValidationError("The retailer returned HTML, possibly an authentication or browser challenge.", response.status);
    }
    if (contentType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
      throw new ResponseValidationError("The retailer did not return a JSON response.", response.status);
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ResponseValidationError("The retailer returned malformed JSON.", response.status); }
    if (!opts.validate && (value === null || typeof value !== "object")) throw new ResponseValidationError("The retailer returned an invalid JSON response shape.", response.status);
    return this.validateResponse(value, opts, response.status);
  }

  private validateResponse<T>(value: unknown, opts: HttpOptions<T>, status: number): T {
    if (!opts.validate) return value as T;
    try { return opts.validate(value); }
    catch { throw new ResponseValidationError("The retailer response failed validation.", status); }
  }

  private async refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try { this.session = await this.reauth!(); }
        catch { throw new AuthError(401, "Session refresh failed. Log in locally before retrying."); }
      })();
    }
    const current = this.refreshing;
    try { await current; }
    finally { if (this.refreshing === current) this.refreshing = undefined; }
  }

  buildUrl(path: string, query?: HttpOptions["query"]): string {
    const url = trustedUrl(path, RETAILER_ORIGIN);
    if (query) for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  buildHeaders(extra?: Record<string, string>, url = `${RETAILER_ORIGIN}/`): Headers {
    trustedUrl(url);
    let headers: Headers;
    try {
      headers = new Headers({
      accept: "application/json", "accept-language": "en-GB,en;q=0.9",
      authorization: `Bearer ${this.session.bearerToken}`, "content-type": "application/json",
      "enabled-feature-flags": ENABLED_FEATURE_FLAGS,
      origin: RETAILER_ORIGIN, referer: `${RETAILER_ORIGIN}/gol-ui/`,
      "sec-ch-ua": '"Chromium";v="146", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Linux"',
      "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin",
      "user-agent": this.session.userAgent, wcauthtoken: this.session.wcauthtoken,
      cookie: new SessionCookies(this.session.cookies).header(url),
      });
    } catch {
      throw new AuthError(401, "Cached authentication headers are invalid. Run local auth login again.");
    }
    if (extra) for (const [key, value] of Object.entries(extra)) {
      if (["authorization", "cookie", "wcauthtoken", "origin", "referer", "host"].includes(key.toLowerCase())) {
        throw new Error("Overriding authentication or origin headers is refused.");
      }
      try { headers.set(key, value); }
      catch { throw new Error("Invalid retailer request headers."); }
    }
    return headers;
  }
}

function trustedUrl(value: string, base?: string): URL {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new Error("Invalid retailer URL."); }
  if (url.origin !== RETAILER_ORIGIN || url.username || url.password || url.hash) {
    throw new Error("Authenticated requests require the exact retailer HTTPS origin.");
  }
  return url;
}

function sameTrustedUrl(value: string): boolean {
  try { trustedUrl(value); return true; }
  catch { return false; }
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${label}.`);
  return value;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await abortable(response.body?.cancel().catch(() => {}) ?? Promise.resolve(), signal);
    throw new ResponseValidationError("The retailer response exceeded its size limit.", response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new RequestCancelledError();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ResponseValidationError("The retailer response exceeded its size limit.", response.status);
      }
      chunks.push(chunk.value);
    }
    if (signal.aborted) throw new RequestCancelledError();
    return Buffer.concat(chunks, length).toString("utf8");
  } catch (error) {
    if (error instanceof ResponseValidationError || error instanceof RequestCancelledError) throw error;
    throw new ResponseValidationError("The retailer response could not be read.", response.status);
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/** The digest stays in memory. It is never printed or stored as a credential fingerprint. */
function authenticationIdentity(session: Session): string {
  return createHash("sha256").update(JSON.stringify([
    session.authGeneration ?? "legacy", session.userId, session.accountEmail?.toLowerCase(),
    session.capturedAt, session.bearerToken, session.wcauthtoken,
  ])).digest("hex");
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); throw new RequestCancelledError(); }
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(new RequestCancelledError());
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", cancel); }
}
