import { chromium, type BrowserContext } from "playwright";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { privateDirectory, profileRoot, temporaryProfileRoot } from "./session.js";
import { registerCleanup, throwIfInterrupted } from "./lifecycle.js";

export interface LaunchOptions {
  sessionPath: string;
  accountEmail?: string;
  headless: boolean;
  /** Start headed Chromium minimized for the resident session owner. */
  minimized?: boolean;
  /** false uses a fresh private profile removed when the context closes. */
  persist?: boolean;
}

export function browserDataDir(sessionPath: string, accountEmail = "unidentified"): string {
  const account = createHash("sha256").update(accountEmail.trim().toLowerCase()).digest("hex");
  return join(profileRoot(sessionPath), account);
}

/**
 * Chromium throttles timers in minimized windows, which can stop the retailer's
 * own session renewal while the resident browser waits between commands.
 */
export const RESIDENT_ARGS = [
  "--start-minimized",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

/** Dedicated Playwright Chromium profile. Never uses the user's ordinary browser profile. */
export async function launchContext(opts: LaunchOptions): Promise<BrowserContext> {
  let temporary: string | undefined;
  const root = temporaryProfileRoot(opts.sessionPath);
  if (opts.persist === false) {
    await privateDirectory(root);
    temporary = join(root, `${process.pid}-${randomUUID()}`);
    await mkdir(temporary, { mode: 0o700 });
  }
  const userDataDir = temporary ?? browserDataDir(opts.sessionPath, opts.accountEmail);
  let opening: Promise<BrowserContext> | undefined;
  let originalClose: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const cleanup = () => closing ??= (async () => {
    try {
      const context = await opening?.catch(() => undefined);
      if (context) await (originalClose ?? context.close.bind(context))();
    } finally {
      if (temporary) {
        await rm(temporary, { recursive: true, force: true });
        await rmdir(root).catch((err: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code ?? "")) throw err;
        });
      }
    }
  })();
  const unregister = registerCleanup(cleanup);
  try {
    opening = (async () => {
      throwIfInterrupted();
      if (opts.persist !== false) await privateDirectory(profileRoot(opts.sessionPath));
      await privateDirectory(userDataDir);
      throwIfInterrupted();
      return chromium.launchPersistentContext(userDataDir, {
        headless: opts.headless,
        timeout: 15_000,
        ...(opts.minimized ? {args:RESIDENT_ARGS} : {}),
        // Our lifecycle handler closes the browser before releasing its profile lock.
        handleSIGINT: false,
        handleSIGTERM: false,
        viewport: { width: 1366, height: 900 },
        locale: "en-GB",
        timezoneId: "Europe/London",
      });
    })();
    const context = await opening;
    originalClose = context.close.bind(context);
    throwIfInterrupted();
    context.close = async () => {
      try { await cleanup(); }
      finally { unregister(); }
    };
    return context;
  } catch {
    try { await cleanup(); } finally { unregister(); }
    throw new Error("Could not launch login browser. Install its Chromium with npm run browser:install; close other login processes and check private storage permissions.");
  }
}
