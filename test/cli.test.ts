/**
 * CLI smoke test: spawn `tsx src/cli/index.ts --help` and verify output structure.
 * Non-destructive — exercises commander wiring only, never makes network calls.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(here, "../src/cli/index.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync("npx", ["tsx", cliEntry, ...args], {
    encoding: "utf8",
    env: { ...process.env, SAINSBURYS_EMAIL: "test@example.com", SAINSBURYS_PASSWORD: "x" },
  });
  return { stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe("CLI help", () => {
  it("--help lists top-level commands", () => {
    const { stdout, status } = runCli(["--help"]);
    assert.equal(status, 0);
    for (const cmd of ["auth", "basket", "order", "product", "customer", "checkout", "slot"]) {
      assert.ok(stdout.includes(cmd), `expected '${cmd}' in help output`);
    }
  });

  it("supports nested help on subcommands", () => {
    const { stdout, status } = runCli(["order", "--help"]);
    assert.equal(status, 0);
    for (const sub of ["list", "show", "status", "amend"]) {
      assert.ok(stdout.includes(sub), `expected '${sub}' in order help`);
    }
  });

  it("supports nested help on basket subcommands", () => {
    const { stdout, status } = runCli(["basket", "--help"]);
    assert.equal(status, 0);
    for (const sub of ["show", "add", "set", "remove"]) {
      assert.ok(stdout.includes(sub), `expected '${sub}' in basket help`);
    }
  });

  it("--version prints semver", () => {
    const { stdout, status } = runCli(["--version"]);
    assert.equal(status, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });
});
