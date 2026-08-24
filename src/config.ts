import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Load env from the global config dir first (so a `sainsburys` binary works from any CWD),
// then fall back to a project-local .env (so `npm run dev` still works during development).
// Variables already in process.env are not overwritten by either call.
const globalEnvPath = join(homedir(), ".config", "sainsburys", ".env");
if (existsSync(globalEnvPath)) loadEnv({ path: globalEnvPath });
loadEnv();

export interface Config {
  email: string;
  password: string;
  sessionPath: string;
  storeNumber?: string;
  headed: boolean;
  baseUrl: string;
  loginBaseUrl: string;
  /** Beeper/Matrix room id for the SMS bridge that delivers Sainsbury's MFA codes. */
  mfaChatRoomId?: string;
  /** Path to the `con` CLI binary (Console). Default: `con` on PATH. */
  conBin: string;
}

const defaultSessionPath = join(homedir(), ".config", "sainsburys", "session.json");

export function loadConfig(): Config {
  const email = process.env.SAINSBURYS_EMAIL;
  const password = process.env.SAINSBURYS_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "SAINSBURYS_EMAIL and SAINSBURYS_PASSWORD must be set (in .env or environment).",
    );
  }

  return {
    email,
    password,
    sessionPath: process.env.SAINSBURYS_SESSION_PATH ?? defaultSessionPath,
    storeNumber: process.env.SAINSBURYS_STORE_NUMBER,
    headed: process.env.SAINSBURYS_HEADED === "1",
    baseUrl: "https://www.sainsburys.co.uk",
    loginBaseUrl: "https://account.sainsburys.co.uk",
    mfaChatRoomId: process.env.SAINSBURYS_MFA_CHAT_ROOM_ID,
    conBin: process.env.SAINSBURYS_CON_BIN ?? "con",
  };
}

export function loadConfigPartial(): Pick<Config, "sessionPath" | "baseUrl" | "loginBaseUrl" | "storeNumber" | "headed" | "mfaChatRoomId" | "conBin"> {
  return {
    sessionPath: process.env.SAINSBURYS_SESSION_PATH ?? defaultSessionPath,
    storeNumber: process.env.SAINSBURYS_STORE_NUMBER,
    headed: process.env.SAINSBURYS_HEADED === "1",
    baseUrl: "https://www.sainsburys.co.uk",
    loginBaseUrl: "https://account.sainsburys.co.uk",
    mfaChatRoomId: process.env.SAINSBURYS_MFA_CHAT_ROOM_ID,
    conBin: process.env.SAINSBURYS_CON_BIN ?? "con",
  };
}
