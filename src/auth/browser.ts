import { chromium, type BrowserContext } from "playwright";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  const fakePlugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  ];
  Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins });
  Object.defineProperty(navigator, 'mimeTypes', { get: () => [{ type: 'application/pdf' }] });
  if (!('chrome' in window)) { window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} }; }
  const origQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (origQuery) {
    window.navigator.permissions.query = (params) =>
      params && params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : origQuery.call(window.navigator.permissions, params);
  }
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return origGetParameter.call(this, parameter);
  };
`;

export interface LaunchOptions {
  /** Path to the session.json file — used to derive the userDataDir alongside it. */
  sessionPath: string;
  headless: boolean;
}

export function browserDataDir(sessionPath: string): string {
  return join(dirname(sessionPath), "browser-data");
}

/**
 * Launch a persistent Chromium context configured the way Sainsbury's expects.
 * The persistent profile keeps Akamai's _abck cookie + ThreatMetrix device trust
 * across runs so headless re-auth and checkout flows don't hit fresh-browser challenges.
 */
export async function launchContext(opts: LaunchOptions): Promise<BrowserContext> {
  const userDataDir = browserDataDir(opts.sessionPath);
  await mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: opts.headless,
    channel: "chrome",
    userAgent: DEFAULT_USER_AGENT,
    viewport: { width: 1366, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/London",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  return context;
}
