import { execFile } from "node:child_process";

/** Tells the person at the Mac that unattended sign-in needs them. Fixed text only. */
export type LoginNotifier = () => void;

const OSASCRIPT = "/usr/bin/osascript";
const SCRIPT = 'display notification "Sign-in needed. Run: sainsburys auth login" with title "Sainsbury\'s CLI"';

/** SAINSBURYS_NOTIFY=off disables it. No account data, URL or page text is included. */
export const macLoginNotifier: LoginNotifier = () => {
  if (process.platform !== "darwin" || process.env.SAINSBURYS_NOTIFY?.trim().toLowerCase() === "off") return;
  execFile(OSASCRIPT, ["-e", SCRIPT], { timeout: 10_000 }, () => { /* Best effort. */ });
};
