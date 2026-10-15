import { Command } from "commander";
import { performLogin } from "../../auth/login.js";
import { clearSession, loadSession } from "../../auth/session.js";
import { loadConfig, loadConfigPartial } from "../../config.js";
import { printData, printError, exitCodeFor } from "../output.js";
import { residentLogin, residentStatus, stopResidentService } from "../../client/resident-service.js";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage Sainsbury's session credentials");

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
        await stopResidentService(config.sessionPath);
        await clearSession(config.sessionPath);
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

  return cmd;
}
