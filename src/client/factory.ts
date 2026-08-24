import { performLogin } from "../auth/login.js";
import { loadSession, saveSession, type Session } from "../auth/session.js";
import { loadConfig } from "../config.js";
import { GroceriesClient } from "./http.js";

export interface CreateClientOptions {
  /** If true, auto-relogin on 401/403. Default true. */
  autoReauth?: boolean;
  /** Use this session instead of loading from disk. */
  session?: Session;
  log?: (msg: string) => void;
}

export async function createClient(opts: CreateClientOptions = {}): Promise<GroceriesClient> {
  const config = loadConfig();
  const log = opts.log ?? (() => {});

  let session = opts.session ?? (await loadSession(config.sessionPath));
  if (!session) {
    log("no session found; performing login");
    session = await performLogin({ config, log });
  }

  const client = new GroceriesClient({
    session,
    baseUrl: config.baseUrl,
    reauth:
      opts.autoReauth === false
        ? undefined
        : async () => {
            log("session rejected; re-authenticating");
            const fresh = await performLogin({ config, log });
            await saveSession(config.sessionPath, fresh);
            return fresh;
          },
  });

  return client;
}

export function inferStoreNumber(client: GroceriesClient, override?: string): string {
  if (override) return override;
  const fromSession = client.getSession().storeNumber;
  if (fromSession) return fromSession;
  // Fallback: well-known default observed in HARs.
  return "2168";
}
