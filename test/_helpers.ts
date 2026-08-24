import type { Session } from "../src/auth/session.js";

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    cookies: [
      { name: "WC_AUTHENTICATION_123456789", value: "abc%2B", domain: "www.sainsburys.co.uk", path: "/" },
      { name: "JSESSIONID", value: "0000XYZ", domain: "www.sainsburys.co.uk", path: "/" },
      { name: "_abck", value: "abck-token", domain: ".sainsburys.co.uk", path: "/" },
    ],
    wcauthtoken: "123456789%2CAbCdEfGhIjKlMnOpQrStUvWxYz0%3D",
    bearerToken: "test-jwt-abc.def.ghi",
    userId: "123456789",
    storeNumber: "2168",
    capturedAt: 1735689600000,
    userAgent: "TestAgent/1.0",
    ...overrides,
  };
}

export interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeResponseSpec {
  status?: number;
  body?: unknown;
  contentType?: string;
}

/** A scriptable fetch mock. Calls are recorded; responses are popped from the queue (or `defaultResponse` if empty). */
export function makeFakeFetch(
  responses: FakeResponseSpec[] = [],
  defaultResponse: FakeResponseSpec = { status: 200, body: {} },
): { fetch: typeof fetch; calls: FakeRequest[] } {
  const calls: FakeRequest[] = [];
  const queue = [...responses];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL | Request).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
    else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, method, headers, body: init?.body as string | undefined });
    const spec = queue.shift() ?? defaultResponse;
    const status = spec.status ?? 200;
    const isJson = spec.contentType ? spec.contentType.includes("json") : true;
    // 204/205/304 cannot have a body per the Fetch spec (Response constructor throws otherwise).
    const nullBody = status === 204 || status === 205 || status === 304;
    const body = nullBody
      ? null
      : spec.body === undefined
        ? ""
        : isJson
          ? JSON.stringify(spec.body)
          : String(spec.body);
    return new Response(body, {
      status,
      headers: { "content-type": spec.contentType ?? "application/json" },
    });
  };
  return { fetch: impl, calls };
}
