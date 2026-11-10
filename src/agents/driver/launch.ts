/**
 * How a CLI driver starts its runtime: the command alone, or an interpreter
 * with an entry script (`<interpreter> <entry> <flags>`). Internal: not part
 * of the public API, do not re-export from any barrel.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { InputValidationError } from "@google/adk";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import { canonicalPath, isUnderAny } from "../permissions/paths.js";
import {
  EXTERNAL_AGENT_INTERPRETER_UNSAFE,
  EXTERNAL_AGENT_MISSING_BINARY,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { agentWritableRoots, sandboxTempRoots } from "./shared.js";
import { windowsExecutableKind } from "./spawn.js";
import { type CliCommandHost, resolveCliCommand } from "./subprocess-jsonl.js";

/** The launch options the three CLI drivers share. */
export interface CliLaunchConfig {
  /** The CLI executable. */
  command?: unknown;
  /** An interpreter that runs `entry`. */
  interpreter?: unknown;
  /** The script the interpreter runs. */
  entry?: unknown;
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

/**
 * Rejects an `interpreter`/`entry` pair that could only fail later or be
 * read two ways.
 *
 * @remarks
 * Both are set or neither; each is a non-empty string; `interpreter` is a
 * bare name or an absolute path; `entry` is an absolute path (a relative one would resolve against the run's working
 * directory, which the agent can write); and `command` is not set with them,
 * since `interpreter` takes its place.
 *
 * @param driver - The driver name, for the message.
 * @param config - The driver options.
 * @throws InputValidationError (from `@google/adk`) naming the problem.
 */
export function validateLaunchConfig(
  driver: string,
  config: CliLaunchConfig,
): void {
  const { interpreter, entry } = config;
  if (interpreter === undefined && entry === undefined) {
    return;
  }
  if (interpreter === undefined || entry === undefined) {
    throw new InputValidationError(
      `${driver}: interpreter and entry go together: set both (the driver runs <interpreter> <entry> <flags>) or neither.`,
    );
  }
  if (isBlank(interpreter)) {
    throw new InputValidationError(
      `${driver}: interpreter must be a non-empty string.`,
    );
  }
  if (isBlank(entry)) {
    throw new InputValidationError(
      `${driver}: entry must be a non-empty string.`,
    );
  }
  const name = interpreter as string;
  if (
    (name.includes("/") || name.includes("\\")) &&
    !isAbsolute(name) &&
    !win32.isAbsolute(name)
  ) {
    throw new InputValidationError(
      `${driver}: interpreter must be a bare name looked up on PATH or an absolute path; a relative path would depend on a working directory.`,
    );
  }
  if (!isAbsolute(entry as string)) {
    throw new InputValidationError(
      `${driver}: entry must be an absolute path; a relative one would resolve against the run's working directory, which the agent can write.`,
    );
  }
  if (config.command !== undefined) {
    throw new InputValidationError(
      `${driver}: set command, or interpreter with entry, not both: interpreter replaces command.`,
    );
  }
}

/**
 * The environment variable that carries the run's working directory to the
 * interpreter's preload ({@link CHDIR_PRELOAD}), which removes it.
 */
export const AGENT_CWD_ENV = "ADK_LLM_BRIDGE_AGENT_CWD";

/** The preload's source: a constant; the directory arrives in {@link AGENT_CWD_ENV}. */
const CHDIR_PRELOAD_SOURCE = `const k=${JSON.stringify(AGENT_CWD_ENV)};const d=process.env[k];delete process.env[k];if(typeof d!=="string"||d===""){throw new Error("adk-llm-bridge: "+k+" is not set, so the CLI is not started")}process.chdir(d);process.env.PWD=process.cwd();`;

/**
 * The `--import` module Node runs before the entry: it reads the run's
 * working directory from {@link AGENT_CWD_ENV}, removes the variable, and
 * changes into it (setting `PWD`), so the CLI starts in the workspace as
 * before. A missing variable or a failed `chdir` throws, and Node exits
 * non-zero before the entry runs. The URL is a constant: the directory is
 * never part of it.
 */
export const CHDIR_PRELOAD = `data:text/javascript,${encodeURIComponent(CHDIR_PRELOAD_SOURCE)}`;

/** What the driver spawns: the executable and the arguments before its own flags. */
export interface CliLaunch {
  /** The executable: the resolved command, or the resolved interpreter. */
  command: string;
  /**
   * `["--import", CHDIR_PRELOAD, entry]` with an interpreter, otherwise
   * empty.
   */
  prefix: readonly string[];
  /**
   * With an interpreter: the directory the process starts in, the entry's
   * canonical directory (host-owned), instead of the run's working directory.
   */
  cwd?: string;
  /** With an interpreter: variables added to the child's environment ({@link AGENT_CWD_ENV}). */
  env?: Readonly<Record<string, string>>;
}

/** Options of {@link resolveCliLaunch}. */
export interface ResolveCliLaunchOptions {
  /** The driver's command, or its interpreter when `entry` is set. */
  command: string;
  /** The entry script, when the driver runs an interpreter. */
  entry?: string;
  /** The child's environment, for the `PATH` lookup. */
  env: Record<string, string | undefined>;
  /** The run, for its working directory and `allowedPaths`. */
  request: Pick<ExternalAgentRunRequest, "workingDirectory" | "permissions">;
  /** Whether the driver uses the built-in spawn (a custom one looks up the command itself). */
  builtInSpawn: boolean;
  /** The driver's missing-binary error, for a command without interpreter. */
  missing: () => ExternalAgentPolicyError;
  /** Host probes, for tests. */
  host?: CliCommandHost & {
    /** Whether a path is a regular file. Defaults to a file-system check. */
    isFile?: (path: string) => boolean;
    /** The real path of an existing file, or `undefined`. Defaults to `fs.realpathSync.native`. */
    realpath?: (path: string) => string | undefined;
    /**
     * The first bytes (up to 4) of a regular file, read from one open file
     * descriptor, or `undefined` when it is not a regular file. Defaults to
     * {@link readExecutableHeader}.
     */
    readHeader?: (path: string) => Uint8Array | undefined;
  };
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realFile(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether a file name is Node's: `node`, or on Windows `node` or `node.exe`
 * in any letter case.
 */
function isNodeName(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const name = win32.basename(path).toLowerCase();
    return name === "node" || name === "node.exe";
  }
  return posix.basename(path) === "node";
}

/** Why only a native Node binary is accepted, and what to set instead. */
const NODE_ONLY_REASON =
  "Only the native Node binary (node, node.exe) is accepted: other interpreters read configuration from the run's working directory, which the agent can write (Bun reads bunfig.toml, whose preload runs code, and .env), and so do version-manager shims, both the symlinks to another program (mise, volta) and the scripts named node (asdf, nodenv read .tool-versions or .node-version there and can run a node binary the agent chose). Set interpreter to the real Node binary, for example the output of `node -p process.execPath`.";

function notNode(interpreter: string, real: string): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_INTERPRETER_UNSAFE,
    `The interpreter "${interpreter}" is ${real === interpreter ? "not Node" : `${real}, not Node`}. ${NODE_ONLY_REASON}`,
  );
}

function notNative(
  interpreter: string,
  real: string,
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_INTERPRETER_UNSAFE,
    `The interpreter "${interpreter}" (${real}) is not a native executable: it is a script (such as an asdf or nodenv shim) or another kind of file. ${NODE_ONLY_REASON}`,
  );
}

/**
 * Reads the first bytes of a regular file through one file descriptor: the
 * type check (`fstat`) and the read use the same open file, so they see the
 * same file. The final path component is not followed when it is a symlink
 * (`O_NOFOLLOW`, where the platform has it); the caller passes a real path.
 * `O_NONBLOCK` keeps a FIFO from blocking the open.
 *
 * @param path - The file, symlinks already resolved.
 * @returns Up to 4 bytes, or `undefined` when the path is not a regular file
 * or cannot be read.
 */
export function readExecutableHeader(path: string): Uint8Array | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
    if (!fstatSync(fd).isFile()) {
      return undefined;
    }
    const header = new Uint8Array(4);
    const read = readSync(fd, header, 0, header.length, 0);
    return header.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

// Mach-O thin (32/64-bit, both byte orders) and fat/universal (32/64-bit, both byte orders).
const MACH_O_MAGICS = [
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
] as const;

/**
 * Whether a file header is the platform's native executable format: PE
 * (`MZ`) on Windows, Mach-O (thin or fat/universal) on macOS, ELF elsewhere.
 * A script (`#!`), an empty or truncated file and anything else is not.
 *
 * @param header - The file's first bytes.
 * @param platform - The platform the file must run on.
 * @returns Whether the header is a native executable's.
 */
export function isNativeExecutableHeader(
  header: Uint8Array,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") {
    return header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a;
  }
  if (header.length < 4) {
    return false;
  }
  if (platform === "darwin") {
    const magic =
      ((header[0] as number) << 24) |
      ((header[1] as number) << 16) |
      ((header[2] as number) << 8) |
      (header[3] as number);
    return (MACH_O_MAGICS as readonly number[]).includes(magic >>> 0);
  }
  return (
    header[0] === 0x7f &&
    header[1] === 0x45 &&
    header[2] === 0x4c &&
    header[3] === 0x46
  );
}

function hasDirectory(command: string, platform: NodeJS.Platform): boolean {
  return (
    command.includes("/") || (platform === "win32" && command.includes("\\"))
  );
}

/** Whether `path`, or what it resolves to through symlinks, is in a writable root. */
function insideWritableRoot(path: string, roots: readonly string[]): boolean {
  const base = roots[0] ?? process.cwd();
  const canonical = canonicalPath(path, base);
  // A path whose symlinks cannot be resolved (a loop) is treated as inside.
  return canonical === undefined || isUnderAny(canonical, roots);
}

function unsafe(what: string, path: string): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_INTERPRETER_UNSAFE,
    `The ${what} ${path} is inside the run's working directory, an allowedPaths root or a temp directory a runtime sandbox keeps writable (symlinks resolved), which the agent can write, so a file the agent changed would run on the host. Install the CLI outside every directory the agent can write and point ${what} there.`,
  );
}

/**
 * Resolves what the driver spawns for one run.
 *
 * @remarks
 * Security invariants:
 * - Without `entry`, this is the existing command rule: the built-in spawn
 *   gets the command looked up by `resolveCliCommand` (no `PATH` entry
 *   inside an agent-writable root, no relative entry, native `.exe`/`.com`
 *   only on Windows); a custom spawn gets the command as given.
 * - With `entry`, the entry must not be at or under an agent-writable root
 *   (the run's working directory and `allowedPaths`, symlinks resolved), and
 *   neither may an interpreter given as a path; otherwise the run is refused
 *   with `EXTERNAL_AGENT_INTERPRETER_UNSAFE`. This check also applies with a
 *   custom spawn. A bare interpreter goes through the same lookup as a bare
 *   command, and on Windows the spawn runs only a native interpreter, never
 *   a `.cmd` or `.bat` file.
 * - With the built-in spawn the entry must be an existing file, and a bare
 *   interpreter must be found; otherwise `MISSING_BINARY` names it.
 * - Only Node runs an entry. With the built-in spawn the interpreter's real
 *   path (symlinks resolved) must be named `node` (`node.exe` on Windows, any
 *   letter case); with a custom spawn the given name, or the file it names
 *   when that exists here. Anything else is refused with
 *   `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before any spawn: the CLI process
 *   runs on the host with the agent's working directory as its own, and
 *   other interpreters load configuration from there (Bun's `bunfig.toml`
 *   preload and `.env`; a version-manager shim's `mise.toml`). Node reads no
 *   configuration file from its working directory without a flag.
 * - The real file must also be a native executable for the platform (its
 *   header read from one open file descriptor: PE on Windows, Mach-O thin or
 *   fat on macOS, ELF elsewhere), so a script named `node` (an asdf or nodenv
 *   shim, which reads `.tool-versions` or `.node-version` from the working
 *   directory) is refused too. With a custom spawn this applies when the
 *   named file exists here. The built-in spawn then starts the real path it
 *   checked.
 * - The interpreter never starts in the run's working directory: it starts
 *   in the entry's canonical directory, which must not be inside a writable
 *   root or a sandbox temp directory (so no ancestor is either), and Node's
 *   `--import` preload {@link CHDIR_PRELOAD} changes into the workspace
 *   before the entry runs. A shim named `node` that passes the name and
 *   header checks (a native version-manager shim such as proto's, or Volta's
 *   `node.exe`) or any interpreter that reads configuration from its working
 *   directory therefore reads the host's directory, not the agent's. The
 *   workspace path reaches the preload in {@link AGENT_CWD_ENV}, never in the
 *   preload's URL; a failed `chdir` stops Node before the entry runs.
 * - The entry is started by its canonical path (the one checked), and the
 *   interpreter by its checked real path (with a custom spawn, when the
 *   configured path exists here), so no symlink on the way can be
 *   re-pointed between the check and the start.
 * - Residuals: Node cannot spawn from a file descriptor, so the file is
 *   opened again by path at spawn time. It is outside every agent-writable
 *   root, so only the host can replace it in between. And a native non-Node
 *   binary copied to a file named `node` passes, which also only the host
 *   can do.
 *
 * @param options - The command or interpreter, the entry, the run and probes.
 * @returns What to spawn, or the refusal to report.
 */
export function resolveCliLaunch(
  options: ResolveCliLaunchOptions,
): { launch: CliLaunch } | { refusal: ExternalAgentPolicyError } {
  const { command, entry, env, request, builtInSpawn } = options;
  if (entry === undefined) {
    const resolved = builtInSpawn
      ? resolveCliCommand(command, env, request, options.host)
      : command;
    return resolved === undefined
      ? { refusal: options.missing() }
      : { launch: { command: resolved, prefix: [] } };
  }
  const platform = options.host?.platform ?? process.platform;
  // Directories the agent can write: the run's own roots and the temp
  // directories a runtime sandbox keeps writable.
  const roots = [
    ...agentWritableRoots(request),
    ...sandboxTempRoots({ ...process.env, ...env }),
  ];
  if (insideWritableRoot(entry, roots)) {
    return { refusal: unsafe("entry", entry) };
  }
  // The interpreter starts in the entry's directory, not in the workspace,
  // so a shim or interpreter that reads configuration from its working
  // directory (or the ones above it) reads the host's. No ancestor of that
  // directory can be agent-writable unless the directory itself is, which
  // this check refuses.
  // The entry is started by the canonical path checked here, not the path
  // as given: a symlink on the way (through a directory the agent writes)
  // cannot be re-pointed between the check and the start. Every directory of
  // the canonical path is a real directory outside the writable set.
  const checkedEntry = canonicalPath(entry, roots[0] ?? "/") ?? entry;
  const hostCwd = dirname(checkedEntry);
  if (insideWritableRoot(hostCwd, roots)) {
    return { refusal: unsafe("entry directory", hostCwd) };
  }
  const workspace = resolve(request.workingDirectory ?? process.cwd());
  const started = (executable: string): { launch: CliLaunch } => ({
    launch: {
      command: executable,
      prefix: ["--import", CHDIR_PRELOAD, checkedEntry],
      cwd: hostCwd,
      env: { [AGENT_CWD_ENV]: workspace },
    },
  });
  if (hasDirectory(command, platform) && insideWritableRoot(command, roots)) {
    return { refusal: unsafe("interpreter", command) };
  }
  const realpath = options.host?.realpath ?? realFile;
  const readHeader = options.host?.readHeader ?? readExecutableHeader;
  const isNative = (path: string): boolean => {
    const header = readHeader(path);
    return header !== undefined && isNativeExecutableHeader(header, platform);
  };
  if (!builtInSpawn) {
    // The custom spawn does its own lookup; the name it is given, or the
    // file it names when that exists here, must still be Node's.
    const existing = hasDirectory(command, platform)
      ? realpath(command)
      : undefined;
    // (A path inside a writable root, symlinks resolved, was refused above.)
    const named = existing ?? command;
    if (!isNodeName(named, platform)) {
      return { refusal: notNode(command, named) };
    }
    // A file named here must also be a native executable, not a script shim.
    if (existing !== undefined && !isNative(existing)) {
      return { refusal: notNative(command, existing) };
    }
    // A path that exists here is started as the real file checked above.
    return started(existing ?? command);
  }
  const isFile = options.host?.isFile ?? isRegularFile;
  if (!isFile(checkedEntry)) {
    return {
      refusal: new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MISSING_BINARY,
        `The entry script ${entry} does not exist or is not a file. Set entry to the CLI's JavaScript entry (the file its package.json names under bin).`,
      ),
    };
  }
  const interpreter = resolveCliCommand(command, env, request, options.host);
  if (interpreter === undefined) {
    const pathApi = platform === "win32" ? win32 : posix;
    return {
      refusal: new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MISSING_BINARY,
        `The interpreter "${command}" was not found on PATH (absolute entries outside the run's working directory and allowedPaths only). Set interpreter to its absolute path, for example ${pathApi === win32 ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node"}.`,
      ),
    };
  }
  if (platform === "win32" && windowsExecutableKind(interpreter) === "batch") {
    // Handed on: the spawn refuses it with EXTERNAL_AGENT_BATCH_COMMAND_REFUSED.
    return started(interpreter);
  }
  // The file that will run, symlinks resolved: a `node` symlink to Bun or to
  // a version-manager shim (mise, asdf) is not Node.
  const real =
    realpath(interpreter) ??
    (platform === "win32" && win32.extname(interpreter) === ""
      ? realpath(`${interpreter}.exe`)
      : undefined);
  if (real === undefined) {
    return {
      refusal: new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MISSING_BINARY,
        `The interpreter ${interpreter} does not exist. Set interpreter to the absolute path of the Node binary.`,
      ),
    };
  }
  if (insideWritableRoot(real, roots)) {
    return { refusal: unsafe("interpreter", real) };
  }
  if (!isNodeName(real, platform)) {
    return { refusal: notNode(command, real) };
  }
  // A script named node (an asdf or nodenv shim) passes the name check.
  if (!isNative(real)) {
    return { refusal: notNative(command, real) };
  }
  // The checked file itself, not the name that led to it, so a symlink on
  // the way cannot be pointed elsewhere between the check and the spawn.
  return started(real);
}
