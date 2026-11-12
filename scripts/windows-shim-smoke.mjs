/**
 * Windows check, run by the CI job `windows shims` after `bun run build`.
 *
 * 1. Puts a fake `claude.cmd` and `codex.cmd` on PATH, runs each
 *    CLI driver from the built package under Node, and fails when a shim ran
 *    or the run did not end with a refusal or a missing-binary event
 *    (Windows only).
 * 2. Runs each CLI driver with `interpreter: process.execPath` (the native
 *    node.exe) and `entry` set to a fake JavaScript CLI, and fails when the
 *    entry did not run, did not start in the run's working directory, the
 *    prompt did not reach it intact, or the run did not complete. Portable:
 *    it also runs off Windows.
 *
 * No real CLI is started.
 *
 * Usage: `bun run build && node scripts/windows-shim-smoke.mjs`
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const { ClaudeCliDriver, CodexCliDriver } = await import(
  "../dist/agents/index.js"
);

const PROMPT = "x & echo injected> injected.txt";
const failures = [];

function request(name, work) {
  return {
    provider: { id: name, displayName: name, command: name },
    context: {},
    instruction: PROMPT,
    workingDirectory: work,
    permissions: { mode: "ask", allowNetwork: true },
  };
}

async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

async function shims() {
  const drivers = {
    claude: () => new ClaudeCliDriver({}),
    codex: () => new CodexCliDriver({}),
  };
  const dir = mkdtempSync(join(tmpdir(), "win-shim-"));
  // A sibling, not the shim directory: a PATH entry under the run's working
  // directory is never searched.
  const work = mkdtempSync(join(tmpdir(), "win-work-"));
  const previous = process.env.PATH;
  try {
    for (const name of Object.keys(drivers)) {
      writeFileSync(
        join(dir, `${name}.cmd`),
        `@echo off\r\necho ran> "${join(dir, `${name}.ran`)}"\r\nexit /b 0\r\n`,
      );
    }
    process.env.PATH = `${dir}${delimiter}${previous ?? ""}`;
    for (const [name, make] of Object.entries(drivers)) {
      const events = await collect(make().run(request(name, work)));
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
      console.log(`${name} shim: ${error?.code ?? "no error event"}`);
    }
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

async function interpreterRoute() {
  // Host-owned, outside the temp directory: the drivers refuse an entry in a
  // temp directory a runtime sandbox keeps writable.
  const pkg = mkdtempSync(
    join(fileURLToPath(new URL("..", import.meta.url)), ".host-scratch-"),
  );
  const work = mkdtempSync(join(tmpdir(), "interp-work-"));
  const record = join(pkg, "record.json");
  const entry = join(pkg, "fake-cli.cjs");
  writeFileSync(
    entry,
    [
      'const { readFileSync, writeFileSync } = require("node:fs");',
      "let input = '';",
      "try { input = readFileSync(0, 'utf8'); } catch {}",
      `writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }));`,
    ].join("\n"),
  );
  const config = { interpreter: process.execPath, entry };
  const drivers = {
    claude: () => new ClaudeCliDriver(config),
    codex: () => new CodexCliDriver(config),
  };
  try {
    for (const [name, make] of Object.entries(drivers)) {
      rmSync(record, { force: true });
      const events = await collect(make().run(request(name, work)));
      const error = events.find((event) => event.type === "error");
      const last = events.at(-1);
      if (error || last?.type !== "completed" || last.exitCode !== 0) {
        failures.push(
          `${name} interpreter: expected a clean run, got ${JSON.stringify(error ?? last)}`,
        );
      }
      if (existsSync(join(work, "injected.txt"))) {
        failures.push(`${name} interpreter: the prompt was re-parsed`);
      }
      if (!existsSync(record)) {
        failures.push(`${name} interpreter: the entry did not run`);
      } else {
        const seen = JSON.parse(readFileSync(record, "utf8"));
        if (realpathSync(seen.cwd) !== realpathSync(work)) {
          failures.push(
            `${name} interpreter: the CLI started in ${seen.cwd}, not the workspace`,
          );
        }
        if (![...seen.argv, seen.input].join("\n").includes(PROMPT)) {
          failures.push(
            `${name} interpreter: the prompt did not arrive intact`,
          );
        }
      }
      console.log(`${name} interpreter: ${error?.code ?? "completed"}`);
    }
  } finally {
    rmSync(pkg, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.platform === "win32") {
  await shims();
} else {
  console.log("windows-shim-smoke: not Windows, .cmd shim part skipped");
}
await interpreterRoute();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("windows-shim-smoke: OK on", process.version);
