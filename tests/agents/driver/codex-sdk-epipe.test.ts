/**
 * `@openai/codex-sdk` writes the prompt to the child's stdin with no `error`
 * listener on that stream. When the child is gone before it has read the
 * whole prompt (it exited early, was aborted, or closed stdin), the write
 * fails with EPIPE as an uncaught exception that ends the host process.
 * `CodexSdkDriver` replaces the client's exec with a contained copy; these
 * tests run each fault in a separate host process, under Bun (the full
 * driver) and Node (the SDK client with the containment), and check that
 * the host survives with a typed result.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const HOST = resolve(import.meta.dir, "fixtures/codex-sdk-epipe-host.ts");
const MIB = 1024 * 1024;
// Each case starts a host process; the stub that never reads takes up to
// the host timeout when the containment is missing.
const TIMEOUT_MS = 30_000;

// Literal stub scripts. `exec` replaces the shell, so a kill reaches the
// process that holds the pipes.
const STUBS = {
  exitAtOnce: "#!/bin/sh\nexit 2\n",
  exitZeroUnread: "#!/bin/sh\nexit 0\n",
  exitMidWrite: "#!/bin/sh\nhead -c 1 > /dev/null\nsleep 0.2\nexit 2\n",
  neverReads: "#!/bin/sh\nexec sleep 30\n",
  closesStdin: "#!/bin/sh\nexec 0<&-\nexec sleep 30\n",
  normal:
    '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"t-1"}\' \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'\n',
  // Ignores SIGTERM, so it is still running when the turn's abort fires.
  // Keeps streaming events until it is stopped.
  streams:
    '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"t-1"}\'\nwhile :; do printf \'%s\\n\' \'{"type":"turn.started"}\'; sleep 0.05; done\n',
  keepsRunning:
    '#!/bin/sh\ntrap "" TERM\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"t-1"}\'\nsleep 3\n',
} as const;

// The stubs that never stop on their own sleep 30 s (or stream forever), so
// a turn that ends within this bound was stopped. The bound allows a slow
// host start under load and stays under the host timeout (20 s).
const STOPPED_MS = 15_000;

// A normal turn ends at once after its last event; the input settle window
// (1 s) is for a write that has not settled when the child exits.
const NO_SETTLE_WAIT_MS = 500;

type Stub = keyof typeof STUBS;

interface HostReport {
  codes: string[];
  exitCode?: number;
  thrown?: string;
  message?: string;
  uncaught: string[];
  elapsedMs: number;
  tailMs?: number;
  events: number;
}

let dir = "";
let bundledExec = "";
let bundleDir = "";
const stubPath = (name: Stub) => join(dir, name);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "codex-sdk-epipe-"));
  // Inside the repo, so the bundle resolves `@openai/codex-sdk` as the
  // source file does.
  const cache = resolve(import.meta.dir, "../../../node_modules/.cache");
  mkdirSync(cache, { recursive: true });
  bundleDir = mkdtempSync(join(cache, "codex-exec-bundle-"));
  const built = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../../../src/agents/driver/codex-sdk-exec.ts"),
    ],
    target: "node",
    outdir: bundleDir,
    naming: "codex-sdk-exec.mjs",
  });
  if (!built.success) throw new Error("bundling codex-sdk-exec failed");
  bundledExec = pathToFileURL(join(bundleDir, "codex-sdk-exec.mjs")).href;
  for (const [name, script] of Object.entries(STUBS)) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
});

afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function runHost(
  runtime: "bun" | "node",
  leg: "driver" | "sdk",
  stub: Stub,
  promptBytes: number,
  abortMs = 0,
  mode: "run" | "break" = "run",
): HostReport {
  const command = runtime === "bun" ? process.execPath : "node";
  const host = spawnSync(
    command,
    [HOST, leg, stubPath(stub), String(promptBytes), String(abortMs), mode],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CODEX_EXEC_MODULE: bundledExec },
    },
  );
  const line = host.stdout.trim().split("\n").at(-1) ?? "";
  if (host.status !== 0 || !line.startsWith("{")) {
    throw new Error(
      `host ${runtime}/${leg}/${stub} died (status ${host.status}, signal ${host.signal}): ${host.stderr.slice(-2000)}`,
    );
  }
  return JSON.parse(line) as HostReport;
}

describe.skipIf(process.platform === "win32")(
  "CodexSdkDriver contains a stdin write error (Bun, full driver)",
  () => {
    // A non-zero exit of the child's own is reported as the SDK reports it
    // (its stderr says why), whether or not the prompt write failed.
    test(
      "a codex that exits at once: the exit error, host alive",
      () => {
        const report = runHost("bun", "driver", "exitAtOnce", 1024);
        expect(report.uncaught).toEqual([]);
        expect(report.codes).toEqual(["CODEX_SDK_ERROR"]);
        expect(report.exitCode).toBe(1);
      },
      TIMEOUT_MS,
    );

    test(
      "a codex that exits while a 1 MiB prompt is written: the exit error, host alive",
      () => {
        const report = runHost("bun", "driver", "exitMidWrite", MIB);
        expect(report.uncaught).toEqual([]);
        expect(report.codes).toEqual(["CODEX_SDK_ERROR"]);
        expect(report.exitCode).toBe(1);
      },
      TIMEOUT_MS,
    );

    test(
      "an abort before codex reads a 1 MiB prompt: the abort result, host alive",
      () => {
        const report = runHost("bun", "driver", "neverReads", MIB, 100);
        expect(report.uncaught).toEqual([]);
        expect(report.codes).toEqual(["CODEX_SDK_ERROR"]);
        expect(report.exitCode).toBe(1);
        expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
      },
      TIMEOUT_MS,
    );

    test(
      "an abort while codex streams events: the abort result, host alive",
      () => {
        const report = runHost("bun", "driver", "streams", MIB, 500);
        expect(report.uncaught).toEqual([]);
        expect(report.events).toBeGreaterThan(0);
        expect(report.codes).toEqual(["CODEX_SDK_ERROR"]);
        expect(report.exitCode).toBe(1);
        expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
      },
      TIMEOUT_MS,
    );

    test(
      "a codex that closes stdin and keeps running: typed error, child killed",
      () => {
        const report = runHost("bun", "driver", "closesStdin", MIB);
        expect(report.uncaught).toEqual([]);
        expect(report.codes).toEqual(["CODEX_SDK_INPUT_NOT_DELIVERED"]);
        expect(report.exitCode).toBe(1);
        expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
      },
      TIMEOUT_MS,
    );

    test(
      "a codex that exits 0 without reading a 1 MiB prompt: typed error",
      () => {
        const report = runHost("bun", "driver", "exitZeroUnread", MIB);
        expect(report.uncaught).toEqual([]);
        expect(report.codes).toEqual(["CODEX_SDK_INPUT_NOT_DELIVERED"]);
        expect(report.exitCode).toBe(1);
      },
      TIMEOUT_MS,
    );

    for (const [size, bytes] of [
      ["1 KiB", 1024],
      ["1 MiB", MIB],
    ] as const) {
      test(
        `a codex that reads a ${size} prompt runs normally`,
        () => {
          const report = runHost("bun", "driver", "normal", bytes);
          expect(report.uncaught).toEqual([]);
          expect(report.codes).toEqual([]);
          expect(report.exitCode).toBe(0);
        },
        TIMEOUT_MS,
      );
    }
  },
);

describe.skipIf(process.platform === "win32")(
  "containCodexSdkClient contains a stdin write error (Node and Bun, SDK client)",
  () => {
    for (const runtime of ["node", "bun"] as const) {
      test(
        `${runtime}: a codex that exits at once`,
        () => {
          const report = runHost(runtime, "sdk", "exitAtOnce", 1024);
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBe("CODEX_SDK_ERROR");
        },
        TIMEOUT_MS,
      );

      test(
        `${runtime}: a codex that exits while a 1 MiB prompt is written`,
        () => {
          const report = runHost(runtime, "sdk", "exitMidWrite", MIB);
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBe("CODEX_SDK_ERROR");
        },
        TIMEOUT_MS,
      );

      test(
        `${runtime}: an abort before codex reads a 1 MiB prompt`,
        () => {
          const report = runHost(runtime, "sdk", "neverReads", MIB, 100);
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBe("ABORT_ERR");
          expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
        },
        TIMEOUT_MS,
      );

      test(
        `${runtime}: an abort while codex streams events`,
        () => {
          const report = runHost(runtime, "sdk", "streams", MIB, 500);
          expect(report.uncaught).toEqual([]);
          expect(report.events).toBeGreaterThan(0);
          expect(report.thrown).toBe("ABORT_ERR");
          expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
        },
        TIMEOUT_MS,
      );

      test(
        `${runtime}: a codex that closes stdin and keeps running`,
        () => {
          const report = runHost(runtime, "sdk", "closesStdin", MIB);
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBe("CODEX_SDK_INPUT_NOT_DELIVERED");
          expect(report.elapsedMs).toBeLessThan(STOPPED_MS);
        },
        TIMEOUT_MS,
      );

      test(
        `${runtime}: a codex that exits 0 without reading a 1 MiB prompt`,
        () => {
          const report = runHost(runtime, "sdk", "exitZeroUnread", MIB);
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBe("CODEX_SDK_INPUT_NOT_DELIVERED");
        },
        TIMEOUT_MS,
      );

      for (const [size, bytes] of [
        ["1 KiB", 1024],
        ["1 MiB", MIB],
      ] as const) {
        test(
          `${runtime}: a codex that reads a ${size} prompt runs normally, with no settle wait`,
          () => {
            const report = runHost(runtime, "sdk", "normal", bytes);
            expect(report.uncaught).toEqual([]);
            expect(report.thrown).toBeUndefined();
            expect(report.tailMs).toBeLessThan(NO_SETTLE_WAIT_MS);
          },
          TIMEOUT_MS,
        );
      }

      // The host stops reading the turn while codex still runs; the turn's
      // abort fires after the exec's cleanup removed its listeners.
      test(
        `${runtime}: an abort after the host stopped reading the turn`,
        () => {
          const report = runHost(
            runtime,
            "sdk",
            "keepsRunning",
            1024,
            100,
            "break",
          );
          expect(report.uncaught).toEqual([]);
          expect(report.thrown).toBeUndefined();
        },
        TIMEOUT_MS,
      );
    }
  },
);
