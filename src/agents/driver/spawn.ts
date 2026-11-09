/**
 * Runtime-neutral subprocess spawning for the CLI drivers. Internal: not part
 * of the public API, do not re-export from any barrel.
 *
 * `Bun.spawn` is used when the Bun global exists; otherwise the subprocess is
 * started with `node:child_process.spawn` and adapted to the same shape
 * (web `ReadableStream` stdout/stderr, an `exited` promise and `kill()`).
 *
 * On POSIX the CLI starts in its own process group, so a kill reaches what it
 * started too (shells, MCP servers, sandbox helpers). Windows has no process
 * groups: there only the CLI process itself is signaled.
 */

import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";

/** Options for {@link spawnSubprocess}. */
export interface DriverSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * The complete environment of the process. The caller passes an
   * allowlisted copy; nothing is inherited implicitly when it is set.
   */
  env?: Record<string, string>;
}

/** A spawned CLI process, identical on Bun and Node. */
export interface DriverSubprocess {
  /** Standard output, or `null` when unavailable. */
  stdout: ReadableStream<Uint8Array> | null;
  /** Standard error, or `null` when unavailable. */
  stderr: ReadableStream<Uint8Array> | null;
  /** Resolves with the exit code (128 + signal number when killed). */
  exited: Promise<number>;
  /** OS process id, when the runtime reports one. */
  pid?: number;
  /**
   * Terminates the process and ends `stdout`/`stderr` for the reader, even if
   * a grandchild still holds the pipes open. Safe to call more than once and
   * after the process exited.
   */
  kill(signal?: NodeJS.Signals): void;
  /**
   * Signals the process group only, even after the CLI itself exited, to
   * reach children it left running. No-op where there are no process groups.
   */
  killGroup?(signal: NodeJS.Signals): void;
}

interface BunSubprocessLike {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): void;
}

/** The part of the Bun global the drivers use. */
export interface BunSpawnLike {
  /**
   * Starts a process the way `Bun.spawn` does.
   *
   * @param command - The executable followed by its arguments.
   * @param options - Working directory, environment and pipe setup.
   * @returns The running process.
   */
  spawn(
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdin: "ignore";
      stdout: "pipe";
      stderr: "pipe";
      detached?: boolean;
    },
  ): BunSubprocessLike;
}

/** The signature of `node:child_process.spawn` that the Node path uses. */
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
  /** The Bun spawn to use; `null` forces the Node path. */
  bun?: BunSpawnLike | null;
  /** The Node spawn to use. */
  nodeSpawn?: NodeSpawnLike;
}

/** Whether CLIs get their own process group (every platform but Windows). */
const USE_PROCESS_GROUPS = process.platform !== "win32";

/**
 * Process groups of CLIs that are still running.
 *
 * A detached group is outside the terminal's foreground group, so a Ctrl-C
 * (SIGINT) or hangup (SIGHUP) of the host does not reach it, and neither
 * does a SIGTERM sent to the host alone. While a group is live the module
 * listens for those signals and forwards them (see {@link onHostSignal}),
 * and an `exit` hook kills what is left when the host exits normally. Both
 * are removed when the last group is gone, so an idle library leaves the
 * host's signal handling as it was.
 */
const liveGroups = new Set<number>();

/** Host signals that reach a CLI in the host's own process group but not a detached one. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

const signalListeners = new Map<NodeJS.Signals, () => void>();
let exitHook: (() => void) | undefined;

function trackGroup(pid: number | undefined, exited: Promise<number>): void {
  if (!USE_PROCESS_GROUPS || typeof pid !== "number") {
    return;
  }
  liveGroups.add(pid);
  installHostHooks();
  const untrack = () => {
    liveGroups.delete(pid);
    if (liveGroups.size === 0) {
      removeHostHooks();
    }
  };
  exited.then(untrack, untrack);
}

function installHostHooks(): void {
  if (exitHook) {
    return;
  }
  exitHook = () => {
    for (const group of liveGroups) {
      signalGroup(group, "SIGKILL");
    }
  };
  process.on("exit", exitHook);
  for (const signal of FORWARDED_SIGNALS) {
    const listener = () => onHostSignal(signal);
    signalListeners.set(signal, listener);
    process.on(signal, listener);
  }
}

function removeHostHooks(): void {
  if (exitHook) {
    process.off("exit", exitHook);
    exitHook = undefined;
  }
  for (const [signal, listener] of signalListeners) {
    process.off(signal, listener);
  }
  signalListeners.clear();
}

/**
 * Forwards a host signal to every live CLI group, which the terminal would
 * not do for a detached group. When the bridge's listener is the only one,
 * it then removes its hooks and re-raises the signal, so the default action
 * (ending the host) still happens. When the host has its own listener, that
 * listener decides, and the `exit` hook still sweeps the groups.
 */
function onHostSignal(signal: NodeJS.Signals): void {
  for (const group of liveGroups) {
    signalGroup(group, signal);
  }
  const own = signalListeners.get(signal);
  const others = process
    .listeners(signal)
    .filter((listener) => listener !== own).length;
  if (others > 0) {
    return;
  }
  removeHostHooks();
  process.kill(process.pid, signal);
}

/** Live CLI process groups and installed host hooks, for tests. */
export function processGroupHooksForTesting(): {
  liveGroups: number;
  signalListeners: number;
  exitHook: boolean;
} {
  return {
    liveGroups: liveGroups.size,
    signalListeners: signalListeners.size,
    exitHook: exitHook !== undefined,
  };
}

/** Signals process group `pid`; false when it is gone or not ours. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // ESRCH: the group is gone. EPERM: not ours to signal.
    return false;
  }
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
 *
 * @remarks
 * On POSIX the process starts in its own process group so a kill also reaches
 * its children. The module forwards host `SIGINT`, `SIGTERM` and `SIGHUP` to
 * live groups and kills them when the host exits, so no CLI outlives the
 * host. A missing binary surfaces as a rejection of `exited` on Node and as a
 * synchronous throw on Bun.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory and environment.
 * @param runtime - Runtime hooks, for tests.
 * @returns The process, identical on Bun and Node.
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
    ...(USE_PROCESS_GROUPS ? { detached: true } : {}),
  });
  const stdout = stoppable(child.stdout);
  const stderr = stoppable(child.stderr);
  const pid = child.pid;
  trackGroup(pid, child.exited);

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited: child.exited,
    ...(typeof pid === "number" ? { pid } : {}),
    kill(signal = "SIGTERM") {
      if (!(USE_PROCESS_GROUPS && pid && signalGroup(pid, signal))) {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
      stdout.stop();
      stderr.stop();
    },
    killGroup(signal) {
      if (USE_PROCESS_GROUPS && pid) {
        signalGroup(pid, signal);
      }
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
    ...(USE_PROCESS_GROUPS ? { detached: true } : {}),
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
  const pid = child.pid;
  trackGroup(pid, exited);

  return {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    ...(typeof pid === "number" ? { pid } : {}),
    kill(signal = "SIGTERM") {
      const grouped = USE_PROCESS_GROUPS && pid && signalGroup(pid, signal);
      if (!grouped && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // Already exited.
        }
      }
      stdout.stop();
      stderr.stop();
    },
    killGroup(signal) {
      if (USE_PROCESS_GROUPS && pid) {
        signalGroup(pid, signal);
      }
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

/** Default time a cancelled CLI gets to exit after SIGTERM before SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/** The part of a spawned process the supervisor uses. */
export interface SupervisedSubprocess {
  /** Sends a signal to the process (default SIGTERM at the call sites). */
  kill?: (signal?: NodeJS.Signals) => void;
  /** When present, called with SIGKILL after a killed process exited. */
  killGroup?: (signal: NodeJS.Signals) => void;
  /** When present, a process still running `killGraceMs` after SIGTERM gets SIGKILL. */
  exited?: Promise<number>;
}

/** Options of {@link superviseSubprocess}. */
export interface SuperviseOptions {
  /**
   * Milliseconds between SIGTERM and SIGKILL. Defaults to
   * {@link DEFAULT_KILL_GRACE_MS}. `0` sends SIGKILL right after SIGTERM.
   * A negative or non-finite value uses the default.
   *
   * @defaultValue 2000
   */
  killGraceMs?: number;
}

/**
 * Kills `subprocess` when `signal` aborts. Call `release()` once the run ends:
 * it detaches the listener and, unless the process was seen to exit, kills it
 * (covers a consumer abandoning the generator via `iterator.return()`).
 *
 * The kill sends SIGTERM first. A process that ignores it and has not
 * exited after `killGraceMs` gets SIGKILL, so a cancelled CLI never lingers.
 * Signals go to the CLI's process group, and once a killed CLI exited the
 * group gets SIGKILL, so its children do not linger either. Both runtimes
 * reap the child once it exits, so no zombie is left behind.
 *
 * @param subprocess - The process to kill; without `exited` no SIGKILL
 * follows.
 * @param signal - The run's abort signal, if any.
 * @param options - The grace period.
 * @returns `markExited()` once the process exited, `release()` when the run
 * ends.
 */
export function superviseSubprocess(
  subprocess: SupervisedSubprocess,
  signal: AbortSignal | undefined,
  options: SuperviseOptions = {},
): { markExited(): void; release(): void } {
  const graceMs = normalizeGrace(options.killGraceMs);
  let exited = false;
  let killed = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const send = (sig: NodeJS.Signals) => {
    try {
      subprocess.kill?.(sig);
    } catch {
      // A failing kill must not mask how the run ended.
    }
  };
  const clearEscalation = () => {
    if (escalation !== undefined) {
      clearTimeout(escalation);
      escalation = undefined;
    }
  };
  const onExit = () => {
    exited = true;
    clearEscalation();
    if (killed) {
      // The CLI is gone, but a child that ignored SIGTERM may still run in
      // its process group.
      try {
        subprocess.killGroup?.("SIGKILL");
      } catch {
        // Best effort.
      }
    }
  };
  subprocess.exited?.then(onExit, onExit);
  const kill = () => {
    if (killed || exited) {
      return;
    }
    killed = true;
    send("SIGTERM");
    if (!subprocess.exited || !subprocess.kill) {
      return;
    }
    escalation = setTimeout(() => {
      escalation = undefined;
      if (!exited) {
        send("SIGKILL");
      }
    }, graceMs);
  };
  if (signal?.aborted) {
    kill();
  } else {
    signal?.addEventListener("abort", kill, { once: true });
  }

  return {
    markExited() {
      exited = true;
      clearEscalation();
    },
    release() {
      signal?.removeEventListener("abort", kill);
      kill();
    },
  };
}

function normalizeGrace(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_KILL_GRACE_MS;
}
