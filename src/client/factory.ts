import { loadSession, type Session } from "../auth/session.js";
import { loadConfig } from "../config.js";
import { AuthError, GroceriesClient } from "./http.js";
import { ensureResidentService, residentFetch } from "./resident-service.js";

export interface CreateClientOptions {
  /** Retained for compatibility. Browser reauthentication is never automatic. */
  autoReauth?: boolean;
  session?: Session;
  /** Injected transport for isolated tests. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** Browser-managed accounts reuse one resident browser; human login stays explicit. */
export async function createClient(opts: CreateClientOptions = {}): Promise<GroceriesClient> {
  const config = loadConfig();
  const session = opts.session ?? await loadSession(config.sessionPath);
  if (!session) throw new AuthError(401, "Local login required. Run sainsburys auth login in a local terminal and complete MFA in its browser.");
  if ((!opts.session && !session.accountEmail) ||
      (config.email && session.accountEmail?.toLowerCase() !== config.email.toLowerCase())) {
    throw new AuthError(401, "Cached session has no matching verified account identity. Run local auth login for SAINSBURYS_EMAIL.");
  }
  if (!opts.session && !opts.fetchImpl && session.browserManaged) {
    await ensureResidentService({ ...config, email: session.accountEmail! }, { userId: session.userId, authGeneration: session.authGeneration });
    return new GroceriesClient({ session, baseUrl: config.baseUrl,
      fetchImpl: residentFetch(config.sessionPath, session), defaultTimeoutMs: 60_000, trustedTransportErrors: true });
  }
  return new GroceriesClient({ session, baseUrl: config.baseUrl, fetchImpl: opts.fetchImpl, sessionPath: opts.session ? undefined : config.sessionPath });
}
