/**
 * Shared helpers for the fx driver tests. The real `fx` is never run: tests use
 * an injected `spawn` or a fake shell script.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FxCliDriverConfig } from "../../../src/agents/driver/fx-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import type { ExternalAgentRunRequest } from "../../../src/agents/external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../../../src/agents/permissions/schema.js";

export const FX_MODEL_ID = "anthropic/claude-haiku-5.5";

/** The real success object printed by `fx ask --json --no-save` (fx 0.0.16). */
export const FX_SUCCESS = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "success.json"), "utf8"),
) as Record<string, unknown>;

/** What a run needs to start: fx cannot block the network, so it is allowed. */
export const FX_ASK_NETWORK_ON: ExternalAgentPermissionPolicy = {
  mode: "ask",
  allowNetwork: true,
};

/** Driver options that satisfy every default refusal (model, host config). */
export function baseConfig(extra: FxCliDriverConfig = {}): FxCliDriverConfig {
  return {
    model: FX_MODEL_ID,
    inheritHostConfig: true,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/test" },
    ...extra,
  };
}

/** A run request for the fx provider (passed in to keep this file import-free of fx). */
export function makeRequest(
  provider: ExternalAgentRunRequest["provider"],
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider,
    context: { input: "hi" } as never,
    instruction: "say hello",
    permissions: FX_ASK_NETWORK_ON,
    ...overrides,
  };
}

export async function collect(
  run: AsyncIterable<ExternalAgentEvent>,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

export type ErrorEvent = Extract<ExternalAgentEvent, { type: "error" }>;

export function errorsOf(events: ExternalAgentEvent[]): ErrorEvent[] {
  return events.filter((event): event is ErrorEvent => event.type === "error");
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: { cwd?: string; env?: Record<string, string>; input?: string };
}

/** A spawn that records calls and prints `stdout` lines, then exits with `exit`. */
export function recordingSpawn(
  stdout: readonly string[] = [`${JSON.stringify(FX_SUCCESS)}\n`],
  exit = 0,
  stderr: readonly string[] = [],
) {
  const calls: SpawnCall[] = [];
  const spawn = (
    command: string,
    args: readonly string[],
    options: SpawnCall["options"],
  ) => {
    calls.push({ command, args, options });
    return {
      stdout: [...stdout],
      stderr: [...stderr],
      exited: Promise.resolve(exit),
    };
  };
  return { spawn, calls };
}

/** A spawn that must not run. */
export function forbiddenSpawn() {
  const state = { called: 0 };
  const spawn = () => {
    state.called++;
    throw new Error("spawn must not run");
  };
  return { spawn, state };
}

const dirs: string[] = [];
export function cleanupFakeDirs(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake `fx` shell script that records argv (one per line) and stdin. */
export function fakeFx(output: string = JSON.stringify(FX_SUCCESS)): {
  command: string;
  argv(): string[];
  stdin(): string;
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-fx-")));
  dirs.push(dir);
  const command = join(dir, "fx");
  const argvFile = join(dir, "argv");
  const stdinFile = join(dir, "stdin");
  const outFile = join(dir, "out.json");
  writeFileSync(outFile, `${output}\n`);
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      `: > '${argvFile}'`,
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvFile}'; done`,
      `cat > '${stdinFile}'`,
      `cat '${outFile}'`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  return {
    command,
    argv: () => readFileSync(argvFile, "utf8").split("\n").slice(0, -1),
    stdin: () => readFileSync(stdinFile, "utf8"),
  };
}

/** Builds or runs a driver and returns the policy code it refuses with. */
export async function refusalCode(
  make: () => {
    run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent>;
  },
  request: ExternalAgentRunRequest,
): Promise<{ code?: string; message: string }> {
  let driver: ReturnType<typeof make>;
  try {
    driver = make();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  const events = await collect(driver.run(request));
  const [error] = errorsOf(events);
  if (!error) throw new Error("expected a refusal");
  return { code: error.code, message: error.message };
}

/** Reads a verbatim probe fixture (one JSON object or stderr text, as fx printed it). */
export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

/** A spawn that prints `stdout` (as one chunk), `stderr` and exits with `exit`. */
export function printingSpawn(stdout: string, exit: number, stderr = "") {
  return recordingSpawn(stdout ? [stdout] : [], exit, stderr ? [stderr] : []);
}

/** A controllable fake process for abort tests: it ends only when killed or finished. */
export function hangingProcess() {
  const encoder = new TextEncoder();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      err = controller;
    },
  });
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const state = { kills: 0, spawned: 0, done: false, signals: [] as unknown[] };
  const end = (code: number) => {
    if (state.done) return;
    state.done = true;
    for (const controller of [out, err]) {
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    }
    resolveExit(code);
  };
  return {
    state,
    spawn: () => {
      state.spawned++;
      return {
        stdout,
        stderr,
        exited,
        kill: (signal?: unknown) => {
          state.kills++;
          state.signals.push(signal);
          end(143);
        },
      };
    },
    push(text: string) {
      out.enqueue(encoder.encode(text));
    },
  };
}
