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
 *
 * A run does not outlive its process: once the CLI has exited, `stdout` and
 * `stderr` are read until EOF, or until a wait on the pipe stays unanswered
 * for two consecutive idle windows of {@link POST_EXIT_IDLE_MS}. Output not yet
 * read is never dropped, however slow the consumer. After the CLI exits, a
 * grandchild that still holds a pipe no longer blocks the run past the two
 * idle windows, but this rule does not kill it and anything it writes later is
 * not read. The rule is {@link drainAfterExit}, the same on Bun and Node.
 */

import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { win32 } from "node:path";
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
  /**
   * Text written to the process's stdin, which is then closed. Without it
   * stdin is ignored.
   */
  input?: string;
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
      stdin: "ignore" | Uint8Array;
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
  /** The platform to behave as. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether a file exists, for the Windows command lookup. Defaults to `fs.existsSync`. */
  fileExists?: (path: string) => boolean;
}

// Windows command lookup. A runtime or a PATHEXT-aware resolver can turn
// `claude` into `claude.cmd` (the shim npm installs) and run it through
// `cmd.exe`, which parses the arguments again, so a prompt with `&` or `|`
// would run as a command. The drivers find the executable themselves, over
// `.exe` and `.com` only, and refuse a batch file.

// Windows' default PATHEXT order for the two native kinds, then the batch kinds.
const NATIVE_EXTENSIONS = [".com", ".exe"] as const;
const BATCH_EXTENSIONS = [".bat", ".cmd"] as const;

/**
 * `value` without its trailing run of the characters in `chars`.
 *
 * @remarks
 * A loop, not a `/[...]+$/` regular expression: that pattern backtracks
 * quadratically on a long run that does not reach the end of the string.
 *
 * @param value - The text.
 * @param chars - The characters to drop from the end.
 * @returns The trimmed text.
 */
export function trimEndOf(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1] as string)) {
    end--;
  }
  return value.slice(0, end);
}

/**
 * What a Windows file name can be to the CLI lookups: `native` (`.com`,
 * `.exe`: runs directly), `batch` (`.bat`, `.cmd`: never run, only reported),
 * or `other` (no extension, `.ps1`, anything else: not runnable by itself, so
 * never an answer). The drivers' lookup and the spawn lookup share it.
 *
 * @param fileName - A file name or path.
 * @returns The kind.
 */
export function windowsExecutableKind(
  fileName: string,
): "native" | "batch" | "other" {
  const extension = win32.extname(trimEndOf(fileName, ". ")).toLowerCase();
  if ((NATIVE_EXTENSIONS as readonly string[]).includes(extension)) {
    return "native";
  }
  return (BATCH_EXTENSIONS as readonly string[]).includes(extension)
    ? "batch"
    : "other";
}

/** What {@link resolveWindowsCommand} reads from the host. */
export interface WindowsCommandHost {
  /** The environment whose `PATH` (any letter case) is searched. */
  env: Readonly<Record<string, string | undefined>>;
  /** Whether a file exists at an absolute path. */
  exists(path: string): boolean;
  /**
   * Canonical absolute directories the lookup never searches (the run's
   * working directory): a `PATH` entry at or under one, or a candidate that
   * resolves into one through a symlink, is skipped.
   */
  excluded?: readonly string[];
}

/** Symlinks resolved when the path exists, otherwise just made absolute. */
function windowsCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return win32.resolve(path);
  }
}

/** Whether `path` is at or under one of `roots` (Windows paths compare without case). */
function isUnderRoots(path: string, roots: readonly string[]): boolean {
  const lower = win32.resolve(path).toLowerCase();
  return roots.some((root) => {
    const base = trimEndOf(win32.resolve(root).toLowerCase(), "\\/");
    return lower === base || lower.startsWith(`${base}\\`);
  });
}

/** `PATH` entries that are absolute; a relative entry would depend on a working directory. */
function pathDirectories(env: WindowsCommandHost["env"]): string[] {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  const value = key === undefined ? undefined : env[key];
  return (value ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0 && win32.isAbsolute(entry));
}

/**
 * A Windows command that is, or resolves first to, a `.cmd` or `.bat` file.
 * The drivers report it as an `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` policy
 * error. It lives here, with no import from the other driver modules, because
 * this file is loadable on its own.
 */
export class BatchCommandRefusedError extends Error {
  /** Always `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`. */
  readonly code = "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED";

  /** @param message - Which command resolved to which batch file, and why it is refused. */
  constructor(message: string) {
    super(message);
    this.name = "BatchCommandRefusedError";
  }
}

function refusal(command: string, batch: string): BatchCommandRefusedError {
  return new BatchCommandRefusedError(
    `The command "${command}" resolves to the batch file ${batch}, which would run through cmd.exe and re-parse the prompt and arguments, so the driver never runs it.`,
  );
}

function notFound(command: string): Error {
  const error = new Error(`spawn ${command} ENOENT`) as Error & {
    code: string;
  };
  error.code = "ENOENT";
  return error;
}

/** What `base` is in `directory`: the first native file, and the first batch file. */
function withinDirectory(
  directory: string,
  base: string,
  exists: (path: string) => boolean,
): { native?: string; batch?: string } {
  const found: { native?: string; batch?: string } = {};
  for (const extension of NATIVE_EXTENSIONS) {
    const candidate = win32.join(directory, base + extension);
    if (exists(candidate)) {
      found.native = candidate;
      return found;
    }
  }
  for (const extension of BATCH_EXTENSIONS) {
    const candidate = win32.join(directory, base + extension);
    if (exists(candidate)) {
      found.batch = candidate;
      return found;
    }
  }
  return found;
}

/**
 * Finds the native executable for `command`: `PATHEXT` order, batch files
 * skipped, relative `PATH` entries skipped, the working directory skipped.
 *
 * @remarks
 * One rule with the drivers' own lookup (`resolveCliCommand`), which runs
 * first when they use this spawn: a native file anywhere on `PATH` wins over
 * a batch file earlier on it, and a batch file is the answer only when no
 * native file exists, so that it is refused with the remedy instead of
 * reported as missing. `host.excluded` drops `PATH` entries at or under the
 * run's working directory (and candidates that resolve into it), here as a
 * backstop for a bare command that reaches this lookup unresolved.
 *
 * An explicit path (one with a directory) is the caller's choice: the
 * exclusion does not apply to it, with or without an extension.
 *
 * The result is always an absolute path, so the runtime that spawns it does
 * no lookup of its own (libuv would try the child's working directory first
 * for a bare name). A relative `command` that names a directory is resolved
 * against the host process's working directory.
 *
 * @param command - A bare name (`claude`, `codex.exe`), or a path with or
 * without extension.
 * @param host - Environment and file-existence probe.
 * @returns The absolute path to spawn.
 * @throws BatchCommandRefusedError (`EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`) when
 * the command is a `.cmd` or `.bat` file, or only a batch file was found.
 * @throws Error with `code: "ENOENT"` when nothing runnable is found, so the
 * driver reports a missing binary.
 */
export function resolveWindowsCommand(
  command: string,
  host: WindowsCommandHost,
): string {
  const excluded = host.excluded ?? [];
  // A candidate inside an excluded root, directly or through a symlink, does
  // not exist as far as a PATH lookup is concerned.
  const searchExists = (path: string): boolean =>
    host.exists(path) &&
    !isUnderRoots(windowsCanonical(path), excluded) &&
    !isUnderRoots(path, excluded);
  // Windows ignores trailing dots and spaces in a file name.
  const trimmed = trimEndOf(command, ". ");
  const extension = win32.extname(trimmed).toLowerCase();
  if ((BATCH_EXTENSIONS as readonly string[]).includes(extension)) {
    throw refusal(command, command);
  }
  const native = (NATIVE_EXTENSIONS as readonly string[]).includes(extension);
  // `claude.exe` names the file; `claude` and `tool.v2` name a base.
  const base = native
    ? win32.basename(trimmed, extension)
    : win32.basename(trimmed);
  const hasDirectory = /[\\/]/.test(trimmed) || win32.isAbsolute(trimmed);
  if (hasDirectory) {
    const absolute = win32.resolve(trimmed);
    if (native) return absolute;
    const found = withinDirectory(win32.dirname(absolute), base, host.exists);
    if (found.native) return found.native;
    if (found.batch) throw refusal(command, found.batch);
    throw notFound(command);
  }
  let batch: string | undefined;
  for (const directory of pathDirectories(host.env)) {
    if (
      isUnderRoots(directory, excluded) ||
      isUnderRoots(windowsCanonical(directory), excluded)
    ) {
      continue;
    }
    if (native) {
      const candidate = win32.join(directory, base + extension);
      if (searchExists(candidate)) return candidate;
      continue;
    }
    const found = withinDirectory(directory, base, searchExists);
    if (found.native) return found.native;
    batch ??= found.batch;
  }
  if (batch) throw refusal(command, batch);
  throw notFound(command);
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
    // First in line: Node and Bun remove a `once` listener before calling
    // it, so a host `process.once` registered earlier would already be gone
    // when a later listener counts the others, and the bridge would re-raise
    // the signal and end a host that meant to handle it.
    process.prependListener(signal, listener);
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
 * (ending the host) still happens. When the host has its own listener
 * (`process.on` or `process.once`), that listener decides, and the `exit`
 * hook still sweeps the groups.
 *
 * @remarks
 * The listener is prepended, so it runs before the host's and counts a host
 * `once` listener that has not fired yet. A second signal after a host `once`
 * fired finds no host listener and ends the host, as it would without the
 * bridge.
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

/**
 * Live CLI process groups and installed host hooks, for tests.
 *
 * @internal
 */
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
 * Spawns `command` with piped stdout/stderr. Stdin carries `options.input`
 * and is then closed, or is ignored when there is no input (an open stdin
 * makes some CLIs wait for more input).
 *
 * @remarks
 * On POSIX the process starts in its own process group so a kill also reaches
 * its children. The module forwards host `SIGINT`, `SIGTERM` and `SIGHUP` to
 * live groups and kills them when the host exits, so no CLI outlives the
 * host. A missing binary surfaces as a rejection of `exited` on Node and as a
 * synchronous throw on Bun. On Windows the command is looked up over `.exe`
 * and `.com` only: a missing one throws an `ENOENT` error, and a command that
 * is or resolves to a `.cmd` or `.bat` file throws an
 * `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED` policy error, in both runtimes.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory, environment and stdin input.
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
  // On Windows the command is resolved here, over .exe and .com only, so
  // neither runtime can turn it into a batch file run through cmd.exe.
  const executable =
    (runtime.platform ?? process.platform) === "win32"
      ? resolveWindowsCommand(command, {
          env: options.env ?? process.env,
          exists: runtime.fileExists ?? existsSync,
          // Same rule as the drivers' own lookup: nothing the run's agent can
          // write is searched. The drivers apply it first, with the
          // `allowedPaths` roots too, when they use this spawn.
          excluded: [windowsCanonical(options.cwd ?? process.cwd())],
        })
      : command;
  if (bun) {
    return spawnWithBun(bun, executable, args, options);
  }
  return spawnWithNode(
    runtime.nodeSpawn ?? nodeSpawn,
    executable,
    args,
    options,
  );
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
    stdin:
      options.input !== undefined
        ? new TextEncoder().encode(options.input)
        : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(USE_PROCESS_GROUPS ? { detached: true } : {}),
  });
  const stdout = stoppable(child.stdout, child.exited);
  const stderr = stoppable(child.stderr, child.exited);
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
    stdio: [options.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    ...(USE_PROCESS_GROUPS ? { detached: true } : {}),
  });
  if (options.input !== undefined && child.stdin) {
    // A process that exits without reading its input closes the pipe; the
    // exit code reports that, not an EPIPE on the host.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  }

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

  const stdout = stoppable(toWebStream(child.stdout), exited);
  const stderr = stoppable(toWebStream(child.stderr), exited);
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

/** How long a stream may stay idle after its process exited before it is ended. */
export const POST_EXIT_IDLE_MS = 500;

/** The timers of one stream's post-exit drain. */
export interface ExitDrain {
  /** The process exited: start the idle windows. */
  start(): void;
  /** Data arrived: the idle window starts again. */
  activity(): void;
  /** Stops the timers (the stream ended or was stopped). */
  cancel(): void;
}

/**
 * The post-exit drain rule, shared by every reader of a child's output: once
 * the process has exited, its pipe is read until EOF, or until a wait on it
 * stays unanswered for two consecutive idle windows of {@link POST_EXIT_IDLE_MS};
 * then `stop` ends the read.
 *
 * @remarks
 * What the process wrote before it exited is already in the pipe and is read
 * at once, so no wait is seen while data is flowing. A reader that is slow
 * (`isReading()` is `false`: it has not asked the pipe for more) is not
 * waiting, so it is never cut, however long it takes: the output it has not
 * read yet is never dropped. The read stops only when the same wait on the
 * pipe was seen at two consecutive idle ticks with no data in between (500 to
 * 1000 ms after the last chunk), so a wait that has only just started is
 * never cut. A grandchild that holds the pipe silently (a background task, an
 * MCP server) therefore does not hold the turn. The rule never kills a
 * process. Timers are unreferenced, so they never keep the host alive.
 *
 * @param stop - Ends the read for the consumer.
 * @param isReading - Whether the consumer is waiting on the pipe now.
 * @returns The drain's controls.
 */
export function drainAfterExit(
  stop: () => void,
  isReading: () => boolean,
): ExitDrain {
  let started = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  // A wait on the pipe was seen at the previous idle tick and has not been
  // answered since: no chunk (`activity`), EOF or stop (`cancel`) came.
  let waitSeen = false;
  const clearIdle = () => {
    if (idle !== undefined) {
      clearTimeout(idle);
      idle = undefined;
    }
  };
  const cancel = () => {
    waitSeen = false;
    clearIdle();
  };
  const armIdle = () => {
    clearIdle();
    idle = setTimeout(() => {
      idle = undefined;
      if (isReading()) {
        if (waitSeen) {
          cancel();
          stop();
          return;
        }
        waitSeen = true;
      } else {
        waitSeen = false;
      }
      armIdle();
    }, POST_EXIT_IDLE_MS);
    idle.unref?.();
  };
  return {
    start() {
      if (started) {
        return;
      }
      started = true;
      armIdle();
    },
    activity() {
      if (started) {
        waitSeen = false;
        armIdle();
      }
    },
    cancel,
  };
}

/**
 * Wraps a stream so `stop()` ends it for the consumer right away, without
 * waiting for the underlying pipe to reach EOF. A read error also ends it.
 * Once `exited` settles, the stream follows {@link drainAfterExit}.
 */
function stoppable(
  source: ReadableStream<Uint8Array> | null,
  exited: Promise<unknown>,
): {
  stream: ReadableStream<Uint8Array> | null;
  stop(): void;
} {
  if (!source) {
    return { stream: null, stop() {} };
  }

  const reader = source.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopped = false;
  let reading = false;
  const drain = drainAfterExit(
    () => stop(),
    () => reading,
  );
  const stop = () => {
    drain.cancel();
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
  };
  // A rejected `exited` (a failed spawn) also ends the process's run.
  exited.then(drain.start, drain.start);

  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    async pull(value) {
      reading = true;
      try {
        const chunk = await reader.read();
        reading = false;
        if (stopped) {
          return;
        }
        if (chunk.done) {
          stopped = true;
          drain.cancel();
          value.close();
          return;
        }
        drain.activity();
        value.enqueue(chunk.value);
      } catch {
        reading = false;
        // A broken pipe means the process went away (or never started, as
        // with ENOENT, where Node reports "Premature close"). End the stream
        // and let `exited` carry the real outcome.
        if (!stopped) {
          stopped = true;
          drain.cancel();
          value.close();
        }
      }
    },
    cancel(reason) {
      stopped = true;
      drain.cancel();
      return reader.cancel(reason);
    },
  });

  return { stream, stop };
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
