import { loadSession, type Session } from "../auth/session.js";
import { loadConfig } from "../config.js";
import { AuthError, GroceriesClient } from "./http.js";

export interface CreateClientOptions {
  /** Retained for compatibility. Browser reauthentication is never automatic. */
  autoReauth?: boolean;
  session?: Session;
  log?: (msg: string) => void;
}

/** Agent operations only reuse a cached session. Local login is an explicit human action. */
export async function createClient(opts: CreateClientOptions = {}): Promise<GroceriesClient> {
  const config = loadConfig();
  const session = opts.session ?? await loadSession(config.sessionPath);
  if (!session) throw new AuthError(401, "Local login required. Run sainsburys auth login in a local terminal and complete MFA in its browser.");
  if ((!opts.session && !session.accountEmail) ||
      (config.email && session.accountEmail?.toLowerCase() !== config.email.toLowerCase())) {
    throw new AuthError(401, "Cached session has no matching verified account identity. Run local auth login for SAINSBURYS_EMAIL.");
  }
  return new GroceriesClient({ session, baseUrl: config.baseUrl });
}
