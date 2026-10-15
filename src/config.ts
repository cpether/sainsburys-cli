import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const globalEnvPath = join(homedir(), ".config", "sainsburys", ".env");
if (existsSync(globalEnvPath)) loadEnv({ path: globalEnvPath });
loadEnv();

export interface Config {
  email: string;
  /** Legacy compatibility only. Login never reads or fills a retained password. */
  password?: string;
  sessionPath: string;
  storeNumber?: string;
  headed: boolean;
  baseUrl: string;
  loginBaseUrl: string;
}

const defaultSessionPath = join(homedir(), ".config", "sainsburys", "session.json");

export function loadConfig(): Config {
  return {
    ...loadConfigPartial(),
    email: process.env.SAINSBURYS_EMAIL?.trim().toLowerCase() ?? "",
  };
}

export function loadConfigPartial(): Omit<Config, "email" | "password"> {
  return {
    sessionPath: resolve(process.env.SAINSBURYS_SESSION_PATH ?? defaultSessionPath),
    storeNumber: process.env.SAINSBURYS_STORE_NUMBER,
    headed: true,
    baseUrl: "https://www.sainsburys.co.uk",
    loginBaseUrl: "https://account.sainsburys.co.uk",
  };
}
