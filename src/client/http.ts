import { cookieHeader, type Session } from "../auth/session.js";
import { ENABLED_FEATURE_FLAGS } from "../lib/feature-flags.js";

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
}

export interface HttpOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** override fetch impl (testing). */
  fetchImpl?: typeof fetch;
}

export interface ClientDeps {
  session: Session;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** invoked once on 401/403 to refresh the session. resolves with the new session or throws. */
  reauth?: () => Promise<Session>;
}

export class GroceriesClient {
  private session: Session;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly reauth?: () => Promise<Session>;

  constructor(deps: ClientDeps) {
    this.session = deps.session;
    this.baseUrl = deps.baseUrl;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.reauth = deps.reauth;
  }

  getSession(): Session {
    return this.session;
  }

  setSession(session: Session): void {
    this.session = session;
  }

  async request<T = unknown>(path: string, opts: HttpOptions = {}): Promise<T> {
    return this.requestInternal<T>(path, opts, false);
  }

  private async requestInternal<T>(
    path: string,
    opts: HttpOptions,
    isRetry: boolean,
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const headers = this.buildHeaders(opts.headers);

    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers,
    };

    if (opts.body !== undefined) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(url, init);

    if ((res.status === 401 || res.status === 403) && !isRetry && this.reauth) {
      this.session = await this.reauth();
      return this.requestInternal<T>(path, opts, true);
    }

    if (res.status === 401 || res.status === 403) {
      throw new AuthError(res.status, `auth failed (${res.status}) on ${opts.method ?? "GET"} ${path}`);
    }

    if (!res.ok) {
      let body: unknown = undefined;
      try {
        body = await res.json();
      } catch {
        try {
          body = await res.text();
        } catch {
          /* swallow */
        }
      }
      throw new ApiError(res.status, `HTTP ${res.status} on ${opts.method ?? "GET"} ${path}`, body);
    }

    if (res.status === 204) return undefined as T;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const text = await res.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    }
    return (await res.text()) as unknown as T;
  }

  buildUrl(path: string, query?: HttpOptions["query"]): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) url.searchParams.append(k, String(item));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  buildHeaders(extra?: Record<string, string>): Headers {
    const h = new Headers({
      accept: "application/json",
      "accept-language": "en-GB,en;q=0.9",
      authorization: `Bearer ${this.session.bearerToken}`,
      "content-type": "application/json",
      "enabled-feature-flags": ENABLED_FEATURE_FLAGS,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/gol-ui/`,
      "sec-ch-ua": '"Chromium";v="146", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Linux"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "user-agent": this.session.userAgent,
      wcauthtoken: this.session.wcauthtoken,
      cookie: cookieHeader(this.session.cookies),
    });
    if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return h;
  }
}
