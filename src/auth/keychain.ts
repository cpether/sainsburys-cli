import { execFile, spawn } from "node:child_process";

/**
 * Opt-in automatic sign-in reads the account password from the macOS login
 * Keychain only when the resident browser reaches Sainsbury's sign-in form. The
 * password never enters a file, environment variable, argument vector or output.
 * Any process running as this macOS user can request the item; that is the same
 * boundary that already protects the cached session.
 */
export const KEYCHAIN_SERVICE = "sainsburys-cli";
const SECURITY = "/usr/bin/security";
export const AUTO_SIGN_IN_UNSUPPORTED = "Automatic sign-in requires the macOS Keychain and is off when SAINSBURYS_AUTO_SIGN_IN=off.";

/** Returns the stored password for this account, or undefined when automatic sign-in is not enabled. */
export type PasswordSource = (email: string, signal?: AbortSignal) => Promise<string | undefined>;

/** SAINSBURYS_AUTO_SIGN_IN=off removes every Keychain access, including logout cleanup. */
function keychainAvailable(): boolean {
  return process.platform === "darwin" && process.env.SAINSBURYS_AUTO_SIGN_IN?.trim().toLowerCase() !== "off";
}

function account(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Set SAINSBURYS_EMAIL to the account for automatic sign-in.");
  return normalized;
}

export const keychainPassword: PasswordSource = (email, signal) => {
  if (!keychainAvailable()) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(email), "-w"],
      { timeout: 10_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) },
      (error, stdout) => {
        // A missing item (exit 44), locked keychain or denied access all mean "not available".
        if (error) { resolve(undefined); return; }
        const password = String(stdout).replace(/\n$/, "");
        resolve(password ? password : undefined);
      });
  });
};

export async function hasKeychainPassword(email: string): Promise<boolean> {
  if (!keychainAvailable()) return false;
  return new Promise(resolve => {
    // Without -w, security prints only item attributes, so the password is never read here.
    execFile(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(email)], { timeout: 10_000 }, error => resolve(!error));
  });
}

/** security prompts on the terminal; the password is never passed through this process. */
export async function storeKeychainPassword(email: string): Promise<void> {
  if (!keychainAvailable()) throw new Error(AUTO_SIGN_IN_UNSUPPORTED);
  if (!process.stdin.isTTY) throw new Error("Enabling automatic sign-in requires an interactive terminal for the password prompt.");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(SECURITY, ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account(email),
      "-l", "Sainsbury's CLI automatic sign-in", "-w"], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("The Keychain item was not saved.");
}

export async function deleteKeychainPassword(email: string): Promise<boolean> {
  if (!keychainAvailable()) return false;
  return new Promise(resolve => {
    execFile(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(email)], { timeout: 10_000 }, error => resolve(!error));
  });
}
