import { chromium, type BrowserContext } from "playwright";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { privateDirectory, profileRoot } from "./session.js";

export interface LaunchOptions {
  sessionPath: string;
  accountEmail?: string;
  headless: boolean;
  /** false uses a fresh private profile removed when the context closes. */
  persist?: boolean;
}

export function browserDataDir(sessionPath: string, accountEmail = "unidentified"): string {
  const account = createHash("sha256").update(accountEmail.trim().toLowerCase()).digest("hex");
  return join(profileRoot(sessionPath), account);
}

/** Dedicated Playwright Chromium profile. Never uses the user's ordinary browser profile. */
export async function launchContext(opts: LaunchOptions): Promise<BrowserContext> {
  let temporary: string | undefined;
  const userDataDir = opts.persist === false
    ? (temporary = await mkdtemp(join(tmpdir(), "sainsburys-login-")))
    : browserDataDir(opts.sessionPath, opts.accountEmail);
  try {
    if (opts.persist !== false) await privateDirectory(profileRoot(opts.sessionPath));
    await privateDirectory(userDataDir);
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: opts.headless,
      viewport: { width: 1366, height: 900 },
      locale: "en-GB",
      timezoneId: "Europe/London",
    });
    const originalClose = context.close.bind(context);
    context.close = async (...args) => {
      try { await originalClose(...args); }
      finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
    };
    return context;
  } catch {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw new Error("Could not launch login browser. Install its Chromium with npm run browser:install; close other login processes and check private storage permissions.");
  }
}
