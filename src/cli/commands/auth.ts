import { Command } from "commander";
import { performLogin } from "../../auth/login.js";
import { loadSession } from "../../auth/session.js";
import { loadConfig, loadConfigPartial } from "../../config.js";
import { printData, printError, exitCodeFor } from "../output.js";
import { logoutResidentSession, residentLogin, residentStatus, residentAuthenticationDiagnostic, stopResidentService } from "../../client/resident-service.js";
import { readAuthEvents } from "../../auth/events.js";
import { deleteKeychainPassword, hasKeychainPassword, storeKeychainPassword } from "../../auth/keychain.js";

async function accountEmail(): Promise<string> {
  const config = loadConfig();
  const email = config.email || (await loadSession(config.sessionPath))?.accountEmail || "";
  if (!email) throw new Error("Set SAINSBURYS_EMAIL to the account for automatic sign-in.");
  return email.toLowerCase();
}

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage Sainsbury's session credentials");

  cmd.command("diagnose").description("Read fixed session and sign-in form categories without login or navigation")
    .action(async (_opts, ref) => {
      try {
        const sessionPath = loadConfigPartial().sessionPath;
        const result = {...await residentAuthenticationDiagnostic(sessionPath), recentEvents: await readAuthEvents(sessionPath)};
        printData({format:ref.optsWithGlobals().json ? "json" : "text"},result,()=>JSON.stringify(result,null,2));
      } catch (err) { printError(err); process.exitCode=exitCodeFor(err); }
    });

  cmd
    .command("login")
    .description("Sign in once and retain a dedicated browser for basket preparation")
    .option("--headed", "Show the browser window (login is always local and headed)")
    .option("--no-persist", "Use a temporary browser profile; remove all captured state when finished")
    .action(async (opts: { headed?: boolean; persist: boolean }, cmdRef) => {
      const root = cmdRef.optsWithGlobals();
      const format = root.json ? "json" : "text";
      try {
        const config = loadConfig();
        if (!config.email) config.email = (await loadSession(config.sessionPath))?.accountEmail ?? "";
        const verbose = (msg: string) => process.stderr.write(`# ${msg}\n`);
        if (opts.persist) {
          verbose("Complete sign-in and MFA in the dedicated browser if requested. It stays running and minimizes after verification.");
          const result = await residentLogin(config);
          printData({ format }, { ok: true, ...result }, () =>
            `Account identity verified. Dedicated browser ready.\nSaved to ${result.session_path}`);
          return;
        }
        const session = await performLogin({
          config,
          headed: opts.headed,
          persist: opts.persist,
          log: verbose,
        });
        printData(
          { format },
          {
            ok: true,
            user_id: session.userId,
            session_path: opts.persist ? config.sessionPath : null,
          },
          () =>
            `Logged in as user ${session.userId}. Account identity verified.${
              opts.persist ? `\nSaved to ${config.sessionPath}` : ""
            }`,
        );
      } catch (err) {
        printError(err);
        process.exitCode = exitCodeFor(err);
      }
    });

  cmd
    .command("status")
    .description("Show current session info (does not perform a login)")
    .action(async (_opts, cmdRef) => {
      const root = cmdRef.optsWithGlobals();
      const format = root.json ? "json" : "text";
      try {
        const config = loadConfigPartial();
        const session = await loadSession(config.sessionPath);
        if (!session) {
          printData(
            { format },
            { ok: false, message: "no session" },
            () => `No session found at ${config.sessionPath}.`,
          );
          process.exit(4);
        }
        const ageMs = Date.now() - session.capturedAt;
        const ageMin = Math.floor(ageMs / 60_000);
        printData(
          { format },
          {
            ok: true,
            user_id: session.userId,
            captured_at: new Date(session.capturedAt).toISOString(),
            age_minutes: ageMin,
            session_path: config.sessionPath,
            store_number: session.storeNumber ?? null,
            ...(session.browserManaged ? { browser: await residentStatus(config.sessionPath) } : {}),
          },
          () =>
            `user_id: ${session.userId}\ncookies: ${session.cookies.length}\ncaptured: ${new Date(session.capturedAt).toISOString()} (${ageMin}m ago)\npath: ${config.sessionPath}`,
        );
      } catch (err) {
        printError(err);
        process.exitCode = exitCodeFor(err);
      }
    });

  cmd
    .command("logout")
    .description("Delete session credentials and persistent browser profiles")
    .action(async (_opts, cmdRef) => {
      const root = cmdRef.optsWithGlobals();
      const format = root.json ? "json" : "text";
      try {
        const config = loadConfigPartial();
        const email = process.env.SAINSBURYS_EMAIL?.trim().toLowerCase() || (await loadSession(config.sessionPath).catch(() => null))?.accountEmail;
        await logoutResidentSession(config.sessionPath);
        if (email) await deleteKeychainPassword(email);
        printData({ format }, { ok: true }, () => `Cleared ${config.sessionPath}`);
      } catch (err) {
        printError(err);
        process.exitCode = exitCodeFor(err);
      }
    });

  cmd.command("stop").description("Stop the dedicated browser; keep the cached session for later reuse")
    .action(async (_opts, cmdRef) => {
      try {
        await stopResidentService(loadConfigPartial().sessionPath);
        printData({ format: cmdRef.optsWithGlobals().json ? "json" : "text" }, { ok: true }, () => "Dedicated browser stopped. Cached authentication retained.");
      } catch (err) { printError(err); process.exitCode = exitCodeFor(err); }
    });

  const auto = cmd.command("auto-sign-in").description("Let the dedicated browser re-enter your password from the macOS Keychain when Sainsbury's asks for it");
  auto.command("enable").description("Store the account password in the login Keychain (prompted by macOS security, never echoed)")
    .action(async (_opts, ref) => {
      try {
        const email = await accountEmail();
        process.stderr.write(`# Enter the Sainsbury's password for ${email} when the macOS security tool prompts.\n`);
        await storeKeychainPassword(email);
        printData({format:ref.optsWithGlobals().json ? "json" : "text"},{ok:true,autoSignIn:"enabled"},()=>
          "Automatic sign-in enabled. SMS codes still need auth login. After a failed automatic attempt, run auth login once to re-arm it.");
      } catch (err) { printError(err); process.exitCode=exitCodeFor(err); }
    });
  auto.command("disable").description("Remove the stored password from the Keychain")
    .action(async (_opts, ref) => {
      try {
        const removed = await deleteKeychainPassword(await accountEmail());
        printData({format:ref.optsWithGlobals().json ? "json" : "text"},{ok:true,autoSignIn:"disabled",removed},()=>
          removed ? "Automatic sign-in disabled; Keychain item removed." : "Automatic sign-in was not enabled.");
      } catch (err) { printError(err); process.exitCode=exitCodeFor(err); }
    });
  auto.command("status").description("Report whether a Keychain password exists, without reading it")
    .action(async (_opts, ref) => {
      try {
        const enabled = await hasKeychainPassword(await accountEmail());
        printData({format:ref.optsWithGlobals().json ? "json" : "text"},{ok:true,autoSignIn:enabled ? "enabled" : "disabled"},()=>
          `Automatic sign-in ${enabled ? "enabled" : "disabled"}.`);
      } catch (err) { printError(err); process.exitCode=exitCodeFor(err); }
    });

  return cmd;
}
