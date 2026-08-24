import { Command } from "commander";
import { performLogin } from "../../auth/login.js";
import { clearSession, loadSession } from "../../auth/session.js";
import { loadConfig, loadConfigPartial } from "../../config.js";
import { printData, printText, printError, exitCodeFor } from "../output.js";

export function authCommand(): Command {
  const cmd = new Command("auth").description("Manage Sainsbury's session credentials");

  cmd
    .command("login")
    .description("Run the Playwright login flow and persist a session to disk")
    .option("--headed", "Show the browser window (overrides SAINSBURYS_HEADED)")
    .option("--no-persist", "Do not write the session to disk; just verify login works")
    .action(async (opts: { headed?: boolean; persist: boolean }, cmdRef) => {
      const root = cmdRef.optsWithGlobals();
      const format = root.json ? "json" : "text";
      try {
        const config = loadConfig();
        const verbose = root.verbose
          ? (msg: string) => process.stderr.write(`# ${msg}\n`)
          : undefined;
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
            cookies: session.cookies.length,
            session_path: opts.persist ? config.sessionPath : null,
          },
          () =>
            `Logged in as user ${session.userId}. Captured ${session.cookies.length} cookies.${
              opts.persist ? `\nSaved to ${config.sessionPath}` : ""
            }`,
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
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
            cookies: session.cookies.length,
            captured_at: new Date(session.capturedAt).toISOString(),
            age_minutes: ageMin,
            session_path: config.sessionPath,
            store_number: session.storeNumber ?? null,
          },
          () =>
            `user_id: ${session.userId}\ncookies: ${session.cookies.length}\ncaptured: ${new Date(session.capturedAt).toISOString()} (${ageMin}m ago)\npath: ${config.sessionPath}`,
        );
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  cmd
    .command("logout")
    .description("Delete the persisted session")
    .action(async (_opts, cmdRef) => {
      const root = cmdRef.optsWithGlobals();
      const format = root.json ? "json" : "text";
      try {
        const config = loadConfigPartial();
        await clearSession(config.sessionPath);
        printData({ format }, { ok: true }, () => `Cleared ${config.sessionPath}`);
      } catch (err) {
        printError(err);
        process.exit(exitCodeFor(err));
      }
    });

  return cmd;
}
