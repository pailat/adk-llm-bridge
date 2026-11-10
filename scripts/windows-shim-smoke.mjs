/**
 * Windows check, run by the CI job `windows shims` after `bun run build`.
 *
 * Puts a fake `gemini.cmd`, `claude.cmd` and `codex.cmd` on PATH, runs each CLI
 * driver from the built package under Node, and fails when a shim ran or the
 * run did not end with a refusal or a missing-binary event. No real CLI is
 * started. Exits 0 immediately on other platforms.
 *
 * Usage: `bun run build && node scripts/windows-shim-smoke.mjs`
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

if (process.platform !== "win32") {
  console.log("windows-shim-smoke: not Windows, skipped");
  process.exit(0);
}
const { ClaudeCliDriver, CodexCliDriver, GeminiCliDriver } = await import(
  "../dist/agents/index.js"
);

const drivers = {
  gemini: () => new GeminiCliDriver({}),
  claude: () => new ClaudeCliDriver({}),
  codex: () => new CodexCliDriver({}),
};
const dir = mkdtempSync(join(tmpdir(), "win-shim-"));
// A sibling, not the shim directory: a PATH entry under the run's working
// directory is never searched.
const work = mkdtempSync(join(tmpdir(), "win-work-"));
const failures = [];
try {
  for (const name of Object.keys(drivers)) {
    writeFileSync(
      join(dir, `${name}.cmd`),
      `@echo off\r\necho ran> "${join(dir, `${name}.ran`)}"\r\nexit /b 0\r\n`,
    );
  }
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  for (const [name, make] of Object.entries(drivers)) {
    const events = [];
    for await (const event of make().run({
      provider: { id: name, displayName: name, command: name },
      context: {},
      instruction: "x & echo injected> injected.txt",
      workingDirectory: work,
      permissions: { mode: "ask", allowNetwork: true },
    })) {
      events.push(event);
    }
    const error = events.find((event) => event.type === "error");
    if (existsSync(join(dir, `${name}.ran`))) {
      failures.push(`${name}.cmd was executed`);
    }
    if (existsSync(join(work, "injected.txt"))) {
      failures.push(`${name}: the prompt was re-parsed by cmd.exe`);
    }
    if (
      !["EXTERNAL_AGENT_BATCH_COMMAND_REFUSED", "MISSING_BINARY"].includes(
        error?.code,
      )
    ) {
      failures.push(
        `${name}: expected a refusal, got ${JSON.stringify(error)}`,
      );
    }
    console.log(`${name}: ${error?.code ?? "no error event"}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("windows-shim-smoke: OK on", process.version);
