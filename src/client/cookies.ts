import { Cookie, CookieJar } from "tough-cookie";
import type { SessionCookie } from "../auth/session.js";

/** RFC cookie handling. Only the transport's fixed retailer origin can receive credentials. */
export class SessionCookies {
  private readonly jar = new CookieJar(undefined, { prefixSecurity: "strict", allowSecureOnLocal: false });

  constructor(cookies: SessionCookie[]) {
    try {
      for (const source of cookies) {
        const domain = source.domain.replace(/^\./, "");
        if (domain !== "sainsburys.co.uk" && !domain.endsWith(".sainsburys.co.uk")) continue;
        const cookie = new Cookie({
          key: source.name, value: source.value, domain, path: source.path,
          hostOnly: !source.domain.startsWith("."), secure: source.secure ?? false,
          httpOnly: source.httpOnly ?? false,
          sameSite: source.sameSite?.toLowerCase() as "strict" | "lax" | "none" | undefined,
          expires: source.expires === undefined || source.expires === -1 ? "Infinity" : new Date(source.expires * 1000),
        });
        this.jar.setCookieSync(cookie, `https://${domain}${source.path}`, { ignoreError: true });
      }
    } catch { throw new Error("Cached session cookies could not be loaded. Run local auth login again."); }
  }

  header(url: string): string {
    try { return this.jar.getCookieStringSync(url, { sameSiteContext: "strict" }); }
    catch { throw new Error("Cached session cookies could not be read. Run local auth login again."); }
  }

  /** Invalid/domain-changing cookies are ignored as a browser would; raw parser errors never escape. */
  accept(headers: Headers, url: string): boolean {
    const before = JSON.stringify(this.snapshot());
    for (const value of headers.getSetCookie()) {
      try {
        const cookie = Cookie.parse(value);
        if (!cookie) continue;
        // Store an absolute deadline. Repeated reads must not extend Max-Age.
        if (cookie.maxAge !== null) {
          const deadline = cookie.expiryTime(new Date());
          cookie.expires = deadline === Infinity ? "Infinity" : new Date(Math.max(0, Math.min(deadline ?? 0, 8.64e15)));
          cookie.maxAge = null;
        }
        this.jar.setCookieSync(cookie, url, { ignoreError: true });
      }
      catch { /* Never expose a token-bearing Set-Cookie string. */ }
    }
    return before !== JSON.stringify(this.snapshot());
  }

  snapshot(): SessionCookie[] {
    try {
      const cookies = this.jar.serializeSync()?.cookies ?? [];
      return cookies.flatMap(value => {
        const cookie = Cookie.fromJSON(value);
        if (!cookie || (cookie.expiryTime() ?? Infinity) <= Date.now()) return [];
        return [{
          name: cookie.key, value: cookie.value,
          domain: `${cookie.hostOnly ? "" : "."}${cookie.domain}`, path: cookie.path ?? "/",
          ...(cookie.expires instanceof Date ? { expires: cookie.expires.getTime() / 1000 } : {}),
          httpOnly: cookie.httpOnly, secure: cookie.secure,
          ...(cookie.sameSite ? { sameSite: ({ strict: "Strict", lax: "Lax", none: "None" } as const)[cookie.sameSite] } : {}),
        }];
      });
    } catch { throw new Error("Session cookies could not be stored. Run local auth login again."); }
  }
}
