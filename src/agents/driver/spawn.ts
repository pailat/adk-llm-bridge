/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Runtime-neutral subprocess spawning for the CLI drivers. Internal: not part
 * of the public API, do not re-export from any barrel.
 *
 * `Bun.spawn` is used when the Bun global exists; otherwise the subprocess is
 * started with `node:child_process.spawn` and adapted to the same shape
 * (web `ReadableStream` stdout/stderr, an `exited` promise and `kill()`).
 */

import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";

export interface DriverSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/** A spawned CLI process, identical on Bun and Node. */
export interface DriverSubprocess {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with the exit code (128 + signal number when killed). */
  exited: Promise<number>;
  /**
   * Terminates the process and ends `stdout`/`stderr` for the reader, even if
   * a grandchild still holds the pipes open. Safe to call more than once and
   * after the process exited.
   */
  kill(signal?: NodeJS.Signals): void;
}

interface BunSubprocessLike {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** The part of the Bun global the drivers use. */
export interface BunSpawnLike {
  spawn(
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin: "ignore";
      stdout: "pipe";
      stderr: "pipe";
    },
  ): BunSubprocessLike;
}

export type NodeSpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Runtime hooks. Omitted fields are detected: `bun` defaults to the Bun
 * global (`null` forces the Node path), `nodeSpawn` to
 * `node:child_process.spawn`.
 */
export interface SpawnRuntime {
  bun?: BunSpawnLike | null;
  nodeSpawn?: NodeSpawnLike;
}

function detectBun(): BunSpawnLike | undefined {
  const candidate = (globalThis as { Bun?: Partial<BunSpawnLike> }).Bun;
  return typeof candidate?.spawn === "function"
    ? (candidate as BunSpawnLike)
    : undefined;
}

/**
 * Spawns `command` with piped stdout/stderr and an ignored stdin (the CLIs
 * receive the prompt as an argument; an open stdin makes some of them wait
 * for more input).
 */
export function spawnSubprocess(
  command: string,
  args: readonly string[],
  options: DriverSpawnOptions,
  runtime: SpawnRuntime = {},
): DriverSubprocess {
  const bun = runtime.bun === null ? undefined : (runtime.bun ?? detectBun());
  if (bun) {
    return spawnWithBun(bun, command, args, options);
  }
  return spawnWithNode(runtime.nodeSpawn ?? nodeSpawn, command, args, options);
}

function spawnWithBun(
  bun: BunSpawnLike,
  command: string,
  args: readonly string[],
  options: DriverSpawnOptions,
): DriverSubprocess {
  const child = bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = stoppable(child.stdout);
  const stderr = stoppable(child.stderr);

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited: child.exited,
    kill(signal = "SIGTERM") {
      try {
        child.kill(signal);
      } catch {
        // Already exited.
      }
      stdout.stop();
      stderr.stop();
    },
  };
}

function spawnWithNode(
  spawnFn: NodeSpawnLike,
  command: string,
  args: readonly string[],
  options: DriverSpawnOptions,
): DriverSubprocess {
  const child = spawnFn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const exited = new Promise<number>((resolve, reject) => {
    // `exit`, not `close`: `close` waits for every holder of the pipes, and a
    // lingering grandchild would keep it from firing.
    child.once("exit", (code, signal) => {
      resolve(code ?? signalExitCode(signal));
    });
    child.once("error", reject);
  });
  // The caller awaits `exited` only after reading stdout; mark it handled so a
  // spawn failure (for example ENOENT) is not reported as unhandled meanwhile.
  exited.catch(() => undefined);

  const stdout = stoppable(toWebStream(child.stdout));
  const stderr = stoppable(toWebStream(child.stderr));

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    kill(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
      stdout.stop();
      stderr.stop();
    },
  };
}

function toWebStream(
  stream: Readable | null | undefined,
): ReadableStream<Uint8Array> | null {
  if (!stream) {
    return null;
  }
  return Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  const number = signal ? osConstants.signals[signal] : undefined;
  return typeof number === "number" ? 128 + number : 1;
}

/**
 * Wraps a stream so `stop()` ends it for the consumer right away, without
 * waiting for the underlying pipe to reach EOF. A read error also ends it.
 */
function stoppable(source: ReadableStream<Uint8Array> | null): {
  stream: ReadableStream<Uint8Array> | null;
  stop(): void;
} {
  if (!source) {
    return { stream: null, stop() {} };
  }

  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;

  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      try {
        const chunk = await reader.read();
        if (stopped) {
          return;
        }
        if (chunk.done) {
          stopped = true;
          value.close();
          return;
        }
        value.enqueue(chunk.value);
      } catch {
        // A broken pipe means the process went away (or never started, as
        // with ENOENT, where Node reports "Premature close"). End the stream
        // and let `exited` carry the real outcome.
        if (!stopped) {
          stopped = true;
          value.close();
        }
      }
    },
    cancel(reason) {
      stopped = true;
      return reader.cancel(reason);
    },
  });

  return {
    stream,
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        controller?.close();
      } catch {
        // Already closed or errored.
      }
      reader.cancel().catch(() => undefined);
    },
  };
}

/**
 * Kills `subprocess` when `signal` aborts. Call `release()` once the run ends:
 * it detaches the listener and, unless the process was seen to exit, kills it
 * (covers a consumer abandoning the generator via `iterator.return()`).
 */
export function superviseSubprocess(
  subprocess: { kill?: (signal?: NodeJS.Signals) => void },
  signal: AbortSignal | undefined,
): { markExited(): void; release(): void } {
  let exited = false;
  let killed = false;
  const kill = () => {
    if (killed || exited) {
      return;
    }
    killed = true;
    try {
      subprocess.kill?.();
    } catch {
      // A failing kill must not mask how the run ended.
    }
  };
  if (signal?.aborted) {
    kill();
  } else {
    signal?.addEventListener("abort", kill, { once: true });
  }

  return {
    markExited() {
      exited = true;
    },
    release() {
      signal?.removeEventListener("abort", kill);
      kill();
    },
  };
}
