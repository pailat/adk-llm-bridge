import { isAbsolute } from "node:path";
import { parseJson } from "../../utils/json.js";
import type {
  ExternalAgentCompletedEvent,
  ExternalAgentEvent,
  ExternalAgentUsage,
} from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { FX_PROVIDER } from "../provider/fx.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import { resolveCliLaunch, validateLaunchConfig } from "./launch.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  assertModelOption,
  assertNoModelOverride,
  envNameIn,
  FX_CLI_MODEL_FLAGS,
  FX_MODEL_ENV,
  isModelId,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
} from "./model.js";
import { FX_CLI_OPTION_KEYS } from "./option-keys.js";
import {
  batchCommandRefusal,
  dependencyMissing,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
  isCommandNotFound,
  networkUnenforceable,
  policyErrorEvent,
  sessionRefusal,
  unenforceablePathsRefusal,
} from "./policy-errors.js";
import {
  assertKnownDriverOptions,
  buildChildEnv,
  exitErrorEvent,
  isJsonObject,
  isRecoverableMessage,
  promptFromRequest,
  stringValue,
  validateDriverConfig,
} from "./shared.js";
import {
  BatchCommandRefusedError,
  spawnSubprocess,
  superviseSubprocess,
} from "./spawn.js";
import {
  assertNoPinnedArgOverride,
  findPinnedArgOverride,
  type PinnedFlags,
  SubprocessJsonlDriver,
} from "./subprocess-jsonl.js";

/**
 * Flags the fx driver sets from the permission policy, its isolation or its
 * options, or that choose the permission mode, configuration or timeout.
 * `args` may not pass them unless `allowPolicyOverrideArgs` is set.
 * `--model`, `--provider` and the flags in {@link FX_CLI_FIXED_FLAGS} (which
 * this list also names where they are policy flags) are refused even then.
 * Reviewed against {@link FX_CLI_PINNED_FLAGS_REVIEW}.
 *
 * @internal
 */
export const FX_CLI_PINNED_FLAGS: PinnedFlags = Object.freeze({
  flags: Object.freeze([
    "--auto",
    "--full-access",
    "--yolo",
    "--prompt-permissions",
    "--provider-order",
    "--provider-strict",
    "--no-provider-strict",
    "--quiet",
    "--json",
    "--no-save",
    "--no-color",
    "--system",
    "--add-dir",
    "--no-additional-dirs",
    "--context-limit",
    "--permission-mode",
    "--ask",
    "--timeout",
    "--profile",
  ]),
});

/**
 * The fx flags that take a value in the space form (`--system <text>`). The
 * entry after one of them in `args` is its value, not prompt text.
 */
const FX_CLI_VALUE_FLAGS: readonly string[] = Object.freeze([
  "--model",
  "--effort",
  "--provider-order",
  "--system",
  "--resume",
  "--resume-id",
  "--permission-mode",
  "--config",
  "--timeout",
  "--provider",
  "--add-dir",
  "--context-limit",
  "--profile",
]);

/**
 * Longest stdout line the driver parses, in characters: 8 MiB, fx's own ACP
 * message limit. fx prints its result as one line, so a longer line is not a
 * result.
 *
 * @internal
 */
export const FX_CLI_MAX_LINE_CHARS = 8 * 1024 * 1024;

/**
 * Flags the driver owns: the ones it needs for its own parsing and
 * statelessness, the ones that resume or continue a session, `--config` and
 * `--`. `args` may never pass them, even with `allowPolicyOverrideArgs`: a run
 * without `--json` or `--no-save` could not be read, a resumed session is not
 * stateless, `--effort` has the driver's `effort` option, a `--config` key such
 * as `provider` or `model` would change which model answers, and fx reads
 * what follows `--` as the prompt. Any `--resume-<id>` entry is refused too
 * (see `assertNoFixedArg`).
 *
 * @internal
 */
export const FX_CLI_FIXED_FLAGS: PinnedFlags = Object.freeze({
  flags: Object.freeze([
    "--json",
    "--no-save",
    "--no-color",
    "--effort",
    "--config",
    "--",
    "--resume",
    "--resume-id",
    "--resume-last",
    "--continue",
    "-c",
    "-r",
  ]),
  // A cluster such as `-vc` is split into `-v -c` before the match.
  booleanShortFlags: Object.freeze(["-h", "-v", "-c", "-r"]),
});

/**
 * fx flags the driver does not support: image input, and the faster, higher
 * priced service tiers, whose cost `usage` does not show. `args` may never pass
 * them, even with `allowPolicyOverrideArgs`.
 *
 * @internal
 */
export const FX_CLI_UNSUPPORTED_FLAGS: PinnedFlags = Object.freeze({
  flags: Object.freeze(["--image", "--fast", "--ultrafast"]),
});

/** Every `?: boolean` option of the driver config, checked when the driver is built. */
const FX_CLI_BOOLEAN_OPTIONS = [
  "requireExplicitModel",
  "allowPolicyOverrideArgs",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "allowUnsandboxedShell",
  "inheritHostConfig",
] as const;

/**
 * What the pinned `args` flags were last reviewed against.
 *
 * @internal
 */
export const FX_CLI_PINNED_FLAGS_REVIEW =
  "fx 0.0.16 `fx --help` and `fx ask --help`; fx 0.0.16 rejects shortened flags (`--full`, `--yol`, `--resum`) and other letter cases (`--Full-Access`), checked 2026-11-11: repeat that check on every fx version review";

/** Options the driver passes to a {@link FxCliSpawn}. */
export interface FxCliSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * The complete environment of the process: an allowlisted copy (`PATH`,
   * `HOME`, the credential keys the provider allows and the variables the
   * driver sets), never the whole of `process.env`.
   */
  env?: Record<string, string>;
  /**
   * The prompt. A custom spawn must write it to the process's stdin and close
   * it: the driver passes no prompt argument, so `fx ask` reads it there.
   */
  input?: string;
}

/** A running `fx` process, as the driver sees it. */
export interface FxCliSubprocess {
  /** Output lines; the driver reads the one JSON object `fx ask --json` prints. */
  stdout?: LineSource | null;
  /**
   * Diagnostics; drained so the process cannot block. The last lines explain
   * a failed run.
   */
  stderr?: LineSource | null;
  /** Resolves with the exit code; may reject with `ENOENT` when the binary is missing. */
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. The driver sends SIGTERM first and, if the
   * process has not exited after `killGraceMs`, SIGKILL.
   */
  kill?: (signal?: NodeJS.Signals) => void;
}

/**
 * Starts the `fx` process. Replace it in tests or to run fx elsewhere.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory, environment and stdin input.
 * @returns The running process.
 */
export type FxCliSpawn = (
  command: string,
  args: readonly string[],
  options: FxCliSpawnOptions,
) => FxCliSubprocess;

/** Options for {@link FxCliDriver}. */
export interface FxCliDriverConfig {
  /**
   * The fx executable.
   *
   * @defaultValue The command of the fx provider (`fx`).
   */
  command?: string;
  /**
   * Runs fx as `<interpreter> <entry> <flags>` instead of `command`. See
   * `GeminiCliDriverConfig.interpreter` for the security invariants, which
   * apply unchanged.
   *
   * @defaultValue unset: the driver runs `command`
   */
  interpreter?: string;
  /**
   * The script `interpreter` runs, as an absolute path.
   *
   * @defaultValue unset
   */
  entry?: string;
  /**
   * Starts the process.
   *
   * @defaultValue The built-in spawn, which works on Bun and Node.
   */
  spawn?: FxCliSpawn;
  /**
   * Ambient environment to copy `PATH` and `HOME` from.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Milliseconds a cancelled process gets to exit after SIGTERM before it is
   * killed with SIGKILL.
   *
   * @defaultValue 2000
   */
  killGraceMs?: number;
  /**
   * Model id (`provider/model`), sent as `--model <id>` and reported as
   * `gen_ai.request.model`. A string of 1 to 256 characters without
   * whitespace or control characters, not starting with `-`; anything else is
   * refused with `EXTERNAL_AGENT_MODEL_INVALID` when the driver is built.
   *
   * @defaultValue unset: fx runs the model saved in the user's fx settings
   */
  model?: string;
  /**
   * Refuse to build the driver without a `model`:
   * `EXTERNAL_AGENT_MODEL_REQUIRED`. Without `--model` fx silently runs the
   * model saved in the user's settings.
   *
   * @defaultValue true
   */
  requireExplicitModel?: boolean;
  /**
   * Reasoning effort, sent as `--effort <level>`. Only the syntax is checked
   * (the same rules as a model id): fx accepts any level and runs an unknown
   * one at the model default.
   *
   * @defaultValue unset
   */
  effort?: string;
  /**
   * Extra `fx ask` arguments, placed after the flags the driver builds.
   * Pinned flags are refused (see {@link FX_CLI_PINNED_FLAGS}), and so is an
   * entry that is not a flag and not the value of the flag before it: fx
   * would read it as the prompt and ignore stdin.
   *
   * @defaultValue []
   */
  args?: readonly string[];
  /**
   * Opt-in: let `args` carry the pinned policy flags. It never lifts the
   * model flags (`--model`, `--provider`), {@link FX_CLI_FIXED_FLAGS}
   * (the output and session flags, `--config` and `--`) or
   * {@link FX_CLI_UNSUPPORTED_FLAGS} (`--image`, `--fast`, `--ultrafast`).
   * Must be `true` or `false`.
   *
   * @defaultValue false
   */
  allowPolicyOverrideArgs?: boolean;
  /**
   * Opt-in: run without `allowNetwork: true` although the driver cannot
   * enforce it. Without it every such run is refused with
   * `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, in every mode.
   *
   * @remarks
   * fx has no network block: its shell is not sandboxed, it has web tools,
   * and every run loads the MCP servers of the user's profile.
   *
   * @defaultValue false
   */
  allowUnenforcedNetwork?: boolean;
  /**
   * Opt-in: run a policy with `allowedPaths` (or path bounds) although fx has
   * no path confinement. Each `allowedPaths` entry is then passed as a global
   * `--add-dir`, which widens what fx may reach and confines nothing. An
   * entry that is not an absolute path is refused with
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.
   *
   * @defaultValue false
   */
  allowUnenforcedPaths?: boolean;
  /**
   * Opt-in: run the `workspace-write` mode as fx `auto` mode. fx has no
   * sandbox: `auto` runs routine shell work and file writes anywhere the
   * user can, and a model review holds only clearly harmful actions.
   *
   * @defaultValue false
   */
  allowUnsandboxedShell?: boolean;
  /**
   * Acknowledge that fx always reads the user's `~/.fx` settings, rules,
   * skills and MCP servers, and the project's `AGENTS.md`, and that the driver
   * cannot turn that off. Without it every run is refused with
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED`.
   *
   * @defaultValue false
   */
  inheritHostConfig?: boolean;
}

function fxCliMissing(): ExternalAgentPolicyError {
  return dependencyMissing(
    "binary",
    "The fx CLI (fx)",
    "see https://fx.sh/docs",
    "set command to the path of the fx binary",
  );
}

function unsupported(message: string): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_OPTION_UNSUPPORTED,
    message,
  );
}

/**
 * Refuses an `args` entry that names a flag the driver owns (see
 * {@link FX_CLI_FIXED_FLAGS}) or starts with `--resume`: fx reads the
 * `--resume-<id>` form as a session to resume, which the table cannot name
 * flag by flag. Nothing lifts this refusal.
 */
function assertNoFixedArg(args: readonly string[] | undefined): void {
  if (args === undefined) {
    return;
  }
  const entry =
    findPinnedArgOverride(args, FX_CLI_FIXED_FLAGS) ??
    args.find((arg) => arg.startsWith("--resume"));
  if (entry === "--") {
    throw unsupported(
      'FxCliDriver: the args entry "--" ends the flags, and fx would read what follows as the prompt and ignore stdin. Remove it; allowPolicyOverrideArgs does not lift this.',
    );
  }
  if (entry !== undefined && /^--config(=|$)/.test(entry)) {
    throw unsupported(
      `FxCliDriver: the args entry "${cut(entry, 40)}" sets a --config key, and a key such as provider or model would change which model answers. Remove it; allowPolicyOverrideArgs does not lift this.`,
    );
  }
  if (entry !== undefined) {
    throw unsupported(
      `FxCliDriver: the args entry "${cut(entry, 40)}" sets a flag the driver owns: the output format, statelessness (--no-save), the effort or a session to resume. The run could not be read or would not be stateless. Remove it; allowPolicyOverrideArgs does not lift this.`,
    );
  }
}

/**
 * Refuses an `args` entry that names a flag the driver does not support (see
 * {@link FX_CLI_UNSUPPORTED_FLAGS}). Nothing lifts this refusal.
 */
function assertNoUnsupportedArg(args: readonly string[] | undefined): void {
  if (args === undefined) {
    return;
  }
  const entry = findPinnedArgOverride(args, FX_CLI_UNSUPPORTED_FLAGS);
  if (entry !== undefined) {
    throw unsupported(
      `FxCliDriver: the args entry "${cut(entry, 40)}" is not supported: the driver sends no images and does not use the faster fx service tiers. Remove it; allowPolicyOverrideArgs does not lift this.`,
    );
  }
}

/**
 * Refuses an `args` entry that is not a flag and is not the value of the flag
 * before it: `fx ask` takes its prompt from a bare argument and then ignores
 * stdin, so the prompt would not be the one the run was given.
 */
function assertNoPromptArgs(args: readonly string[] | undefined): void {
  if (args === undefined) {
    return;
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "-") {
      throw unsupported(
        `FxCliDriver: args entry ${index} ("-") is the prompt marker of fx: fx would read it as the prompt and ignore stdin. Pass only flags in args; the prompt comes from the run.`,
      );
    }
    if (arg.startsWith("-")) {
      if (FX_CLI_VALUE_FLAGS.includes(arg)) {
        // The next entry is this flag's value.
        index++;
      }
      continue;
    }
    throw unsupported(
      `FxCliDriver: args entry ${index} ("${cut(arg, 40)}") is not a flag, and fx would read it as the prompt and ignore stdin. Pass only flags in args; the prompt comes from the run.`,
    );
  }
}

/** The fx flags and environment a permission policy maps to. */
export interface FxPermissionMapping {
  /** Flags that go after `--no-color`/`--model`, before the user's `args`. */
  args: string[];
  /** Variables for the child environment. */
  env: { FX_PERMISSION_MODE: "ask" | "auto" | "full-access" };
}

/**
 * Maps a permission policy to the fx permission mode.
 *
 * @remarks
 * `ask` (and an unset or unknown mode, which fails closed) runs with
 * `FX_PERMISSION_MODE=ask` and no flag: without a TTY the first sensitive
 * action ends the run. `workspace-write` runs as fx `auto` mode and
 * `full-access` as `--full-access`; the driver gates both behind opt-ins.
 * `--full-access` is never produced for another mode. fx has no read-only
 * mode, so `read-only` is refused. The mode always goes in the environment
 * too, because fx turns an invalid value into `auto` silently.
 *
 * @param policy - The policy; when omitted the `ask` mode applies.
 * @returns The flags and the environment variable.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for `read-only`.
 * @internal
 */
export function mapFxPermission(
  policy: ExternalAgentPermissionPolicy | undefined,
): FxPermissionMapping {
  switch (policy?.mode) {
    case "read-only":
      throw unsupported(
        "FxCliDriver: fx has no read-only mode (fx 0.0.16 cannot limit a run to reads), so the read-only permission mode is refused. Use the ask mode (the first write ends the run) or another runtime.",
      );
    case "workspace-write":
      return { args: ["--auto"], env: { FX_PERMISSION_MODE: "auto" } };
    case "full-access":
      return {
        args: ["--full-access"],
        env: { FX_PERMISSION_MODE: "full-access" },
      };
    default:
      return { args: [], env: { FX_PERMISSION_MODE: "ask" } };
  }
}

/** What fx prints at the end of `fx ask --json`, as far as the driver reads it. */
type FxResult = Record<string, unknown>;

/** Longest text of an error message built from fx output, in characters. */
const MESSAGE_CHARS = 4096;

/**
 * Runs an external agent through the `fx` CLI (`fx ask --json --no-save`).
 *
 * @remarks
 * Security and lifecycle invariants:
 * - fx has no sandbox, no read-only mode, no path confinement and no network
 *   block, so the driver fails closed with typed refusals (events, not
 *   exceptions): `read-only`, `workspace-write` without
 *   `allowUnsandboxedShell`, a run without `inheritHostConfig`, paths without
 *   `allowUnenforcedPaths` and a run without `allowNetwork` or
 *   `allowUnenforcedNetwork` are all refused before anything starts.
 * - `--full-access` is added only for the `full-access` mode. `--yolo` never.
 * - The prompt goes on stdin, never in argv.
 * - The process gets an allowlisted environment (`PATH`, `HOME`, the
 *   credential keys the provider allows, plus `FX_PERMISSION_MODE`,
 *   `FX_AUTO_UPGRADE=0` and `NO_COLOR=1`), never the whole of `process.env`.
 *   `FX_MODEL` and `FX_PROVIDER` in it are refused.
 * - fx prints one JSON object when the run ends, so tool events arrive after
 *   the run, and there is no streaming. fx retries provider failures forever:
 *   pass an `abortSignal` with a deadline.
 * - Aborting the run sends SIGTERM, then SIGKILL after `killGraceMs`.
 */
export class FxCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: FxCliSpawn;
  readonly #builtInSpawn: boolean;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #allowUnenforcedNetwork: boolean;
  readonly #allowUnenforcedPaths: boolean;
  readonly #allowUnsandboxedShell: boolean;
  readonly #inheritHostConfig: boolean;
  readonly #model: string | undefined;
  readonly #requireExplicitModel: boolean;
  readonly #effort: string | undefined;

  /**
   * Creates a driver that runs the `fx` CLI.
   *
   * @param config - Driver options; all optional, but see
   * `requireExplicitModel` and `inheritHostConfig`.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty,
   * `killGraceMs` is not a finite number of at least 0, or `args` is not an
   * array of strings.
   * @throws InputValidationError (from `@google/adk`) when a boolean option
   * (see the config's `?: boolean` fields) is set to a non-boolean value such
   * as the string `"false"`.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when a session option
   * (`resumeSessionId`, `sessionStore*`) is given, `effort` is not a plain
   * token, an `args` entry overrides a pinned flag or names a flag the driver
   * owns (`--json`, `--no-save`, `--config`, `--`, `--resume*`, `--continue`,
   * `-c`, `-r`), names a flag the driver does not support (`--image`, `--fast`,
   * `--ultrafast`), or an `args` entry is a lone `-` or is not a flag and not
   * the value of the flag before it (fx would read it as the prompt).
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_MODEL_OVERRIDE` when `args` sets the model or provider,
   * `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not a model id, and
   * `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` (default
   * `true`) is set and `model` is absent.
   */
  constructor(config: FxCliDriverConfig = {}) {
    assertKnownDriverOptions("FxCliDriver", config, FX_CLI_OPTION_KEYS);
    validateDriverConfig("FxCliDriver", config, FX_CLI_BOOLEAN_OPTIONS);
    validateLaunchConfig("FxCliDriver", config);
    assertNoModelOverride("FxCliDriver", config.args, FX_CLI_MODEL_FLAGS);
    assertNoFixedArg(config.args);
    assertNoUnsupportedArg(config.args);
    assertNoPinnedArgOverride(
      "FxCliDriver",
      config.args,
      FX_CLI_PINNED_FLAGS,
      config.allowPolicyOverrideArgs ?? false,
    );
    assertNoPromptArgs(config.args);
    if (config.effort !== undefined && !isModelId(config.effort)) {
      throw unsupported(
        'FxCliDriver: effort must be a plain token: a string of 1 to 256 characters, without whitespace or control characters, that does not start with "-".',
      );
    }
    const model = assertModelOption(
      "FxCliDriver",
      config.model,
      config.requireExplicitModel ?? true,
      MODEL_ALIAS_DENYLIST.fx,
    );
    super({
      providerId: FX_PROVIDER.id,
      command:
        config.interpreter ?? config.command ?? FX_PROVIDER.command ?? "fx",
      entry: config.entry,
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#builtInSpawn = config.spawn === undefined;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#allowUnenforcedNetwork = config.allowUnenforcedNetwork ?? false;
    this.#allowUnenforcedPaths = config.allowUnenforcedPaths ?? false;
    this.#allowUnsandboxedShell = config.allowUnsandboxedShell ?? false;
    this.#inheritHostConfig = config.inheritHostConfig ?? false;
    this.#model = model;
    this.#requireExplicitModel = config.requireExplicitModel ?? true;
    this.#effort = config.effort;
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /** Whether the driver was built with `requireExplicitModel` (default `true`). */
  get requireExplicitModel(): boolean {
    return this.#requireExplicitModel;
  }

  /** `true`: the JSON object of a successful run names the model fx ran. */
  get reportsResolvedModel(): boolean {
    return true;
  }

  /** Features this driver supports: the permission policy mapped onto fx's mode. fx prints one result at the end, so there is no streaming. */
  capabilities(): AgentRuntimeCapabilities {
    return { streaming: false, permissions: true };
  }

  /**
   * Builds the `fx` arguments for a run.
   *
   * @remarks
   * Order: global `--add-dir` pairs (fx 0.0.16 accepts them only before the
   * subcommand, and only with `allowUnenforcedPaths`), then
   * `ask --json --no-save --no-color`, `--model`, `--effort`, the permission
   * flags and the configured `args`. The prompt is never an argument.
   *
   * @param request - The run.
   * @returns The arguments.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for the `read-only` mode.
   */
  buildArgs(request: ExternalAgentRunRequest): string[] {
    const mapping = mapFxPermission(request.permissions);
    const addDirs = this.#allowUnenforcedPaths
      ? (request.permissions?.allowedPaths ?? []).flatMap((path) => [
          "--add-dir",
          path,
        ])
      : [];
    return [
      ...addDirs,
      "ask",
      "--json",
      "--no-save",
      "--no-color",
      ...(this.#model === undefined ? [] : ["--model", this.#model]),
      ...(this.#effort === undefined ? [] : ["--effort", this.#effort]),
      ...mapping.args,
      ...this.args,
    ];
  }

  /**
   * Builds the child environment for a run.
   *
   * @remarks
   * An allowlisted copy of `PATH` and `HOME` and the credential keys the
   * provider allows, plus `FX_PERMISSION_MODE`, `FX_AUTO_UPGRADE=0` (a run
   * never upgrades fx midway) and `NO_COLOR=1`. `FX_PERMISSION_MODE` is the
   * last key written, so no other source can set it.
   *
   * @param request - The run.
   * @returns The environment.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for the `read-only` mode.
   */
  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    const env: Record<string, string> = {
      ...this.#baseEnv(request),
      FX_AUTO_UPGRADE: "0",
      NO_COLOR: "1",
    };
    // Written last, after any key a source could have set: delete first so
    // the key also moves to the end of the object.
    delete env.FX_PERMISSION_MODE;
    env.FX_PERMISSION_MODE = mapFxPermission(
      request.permissions,
    ).env.FX_PERMISSION_MODE;
    return env;
  }

  #baseEnv(request: ExternalAgentRunRequest): Record<string, string> {
    return buildChildEnv(this.#env, ["PATH", "HOME"], request);
  }

  /** The first reason a run cannot start, in the order the checks run. */
  #refusal(
    request: ExternalAgentRunRequest,
    baseEnv: Record<string, string>,
  ): ExternalAgentPolicyError | undefined {
    const permissions = request.permissions;
    const sessionRefused = sessionRefusal("FxCliDriver", request);
    if (sessionRefused) {
      return sessionRefused;
    }
    const envRefusal = modelEnvRefusal(
      "FxCliDriver",
      baseEnv,
      envNameIn(FX_MODEL_ENV),
    );
    if (envRefusal) {
      return envRefusal;
    }
    if (!this.#inheritHostConfig) {
      return unsupported(
        "FxCliDriver: fx always reads the user's ~/.fx settings, rules, skills and MCP servers and the project's AGENTS.md, and the driver cannot turn that off. Build the driver with inheritHostConfig: true to accept it.",
      );
    }
    try {
      mapFxPermission(permissions);
    } catch (error) {
      if (error instanceof ExternalAgentPolicyError) {
        return error;
      }
      throw error;
    }
    if (
      permissions?.mode === "workspace-write" &&
      !this.#allowUnsandboxedShell
    ) {
      return unsupported(
        "FxCliDriver: the workspace-write mode runs as fx auto mode, whose shell and file writes are not sandboxed and reach beyond the workspace. Build the driver with allowUnsandboxedShell: true to run anyway, or use the ask mode.",
      );
    }
    const pathsRefusal = unenforceablePathsRefusal(permissions, {
      runtime: "fx",
      allowUnenforcedPaths: this.#allowUnenforcedPaths,
    });
    if (pathsRefusal) {
      return pathsRefusal;
    }
    const badPath = (permissions?.allowedPaths ?? []).find(
      (path) => !isAbsolute(path),
    );
    if (badPath !== undefined) {
      return unsupported(
        `FxCliDriver: allowedPaths entry "${cut(badPath, 40)}" is not an absolute path. Each entry becomes a global --add-dir, and a relative entry (or one starting with "-") would be read as a flag or resolved against fx's own directory. Pass absolute paths.`,
      );
    }
    if (!networkAllowed(permissions) && !this.#allowUnenforcedNetwork) {
      return networkUnenforceable(
        "fx cannot keep the network off, and network is off unless the policy sets allowNetwork: true: its shell is not sandboxed, it has web tools, and every run loads the MCP servers of the user's profile. Set allowNetwork: true in the agent's permissions, use another runtime, or build the driver with allowUnenforcedNetwork: true to run anyway.",
      );
    }
    return undefined;
  }

  /**
   * Spawns `fx ask --json` for one turn and reports normalized events.
   *
   * @remarks
   * The stream starts with `started`. A refused run yields one `error` event
   * with the policy code and `completed` with `exitCode: 1`. A
   * `request.runtimeSession` is refused with
   * `EXTERNAL_AGENT_SESSIONS_UNSUPPORTED` before any process starts. A
   * successful run yields `output`, one `tool_call` and `tool_result` pair per tool call fx
   * reports (replayed after the run: fx gives no arguments, ids or times),
   * and `completed` with the model, turns and usage. A run failed when the
   * process exit is not 0, the JSON `exit_code` is not the number 0 or the
   * JSON has an `error` name. A failed run yields the tool events, no
   * `output` (fx's text goes into the error message) and one `error` event
   * with `FX_CLI_PERMISSION_REQUIRED` (the run needed an approval that a
   * noninteractive `ask` run cannot give), `FX_CLI_ERROR`, `FX_CLI_EXIT` (no
   * result, non-zero exit), `FX_CLI_NO_RESULT` (no result, exit 0) or
   * `FX_CLI_RESULT_TOO_LARGE` (a stdout line over
   * {@link FX_CLI_MAX_LINE_CHARS}) before `completed`. A line that is not
   * JSON is skipped with a recoverable `FX_CLI_NON_JSON_LINE` error event. If the abort signal fires, the stream ends without `completed`
   * after the process is killed. Spawn errors other than a missing binary
   * are thrown.
   *
   * @param request - The run; the prompt is its `instruction` followed by
   *   the user turn's text.
   * @returns Events in order.
   */
  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const started: ExternalAgentEvent = {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };
    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      yield started;
      return;
    }
    const refusal = this.#refusal(request, this.#baseEnv(request));
    if (refusal) {
      yield started;
      yield policyErrorEvent(refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const args = this.buildArgs(request);
    const env = this.buildEnv(request);

    const resolved = resolveCliLaunch({
      command: this.command,
      entry: this.entry,
      env,
      request,
      builtInSpawn: this.#builtInSpawn,
      missing: fxCliMissing,
    });
    if ("refusal" in resolved) {
      yield started;
      yield policyErrorEvent(resolved.refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const { launch } = resolved;
    let child: FxCliSubprocess;
    try {
      child = this.#spawn(launch.command, [...launch.prefix, ...args], {
        cwd: launch.cwd ?? request.workingDirectory,
        env: launch.env ? { ...env, ...launch.env } : env,
        input: promptFromRequest(request),
      });
    } catch (error) {
      if (error instanceof BatchCommandRefusedError) {
        yield started;
        yield policyErrorEvent(batchCommandRefusal(error, "fx"));
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      // Bun.spawn throws when the binary does not exist.
      if (!isCommandNotFound(error)) {
        throw error;
      }
      yield started;
      yield policyErrorEvent(fxCliMissing());
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const supervisor = superviseSubprocess(child, signal, {
      killGraceMs: this.#killGraceMs,
    });

    try {
      // `started` follows the spawn, so a consumer that aborts right after it
      // still finds a process to stop.
      yield started;
      // Drain stderr while stdout is read so the process cannot block; its
      // lines explain a failed run.
      const stderrLines: string[] = [];
      const stderrPromise = collectTail(child.stderr, stderrLines).catch(
        () => undefined,
      );

      let result: FxResult | undefined;
      let tooLarge = false;
      for await (const line of readLines(child.stdout, {
        maxLineChars: FX_CLI_MAX_LINE_CHARS,
      })) {
        if (signal?.aborted) {
          return;
        }
        // `readLines` cuts a longer line to the bound plus `...`. Keep
        // reading (the process must not block on a full pipe) but parse
        // nothing from a run that printed one.
        if (line.length > FX_CLI_MAX_LINE_CHARS) {
          tooLarge = true;
          continue;
        }
        const trimmed = line.trim();
        if (!trimmed || tooLarge) {
          continue;
        }
        // fx prints its result as one JSON object on one line.
        const parsed = parseJson(trimmed);
        if (
          parsed.ok &&
          isJsonObject(parsed.value) &&
          "exit_code" in parsed.value
        ) {
          result = parsed.value;
        } else {
          yield nonJsonLineEvent(trimmed);
        }
      }
      if (signal?.aborted) {
        return;
      }

      let processExit: number;
      try {
        processExit = await child.exited;
      } catch (error) {
        // Node reports a missing binary through `exited`.
        supervisor.markExited();
        if (!isCommandNotFound(error)) {
          throw error;
        }
        yield policyErrorEvent(fxCliMissing());
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      supervisor.markExited();
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }

      if (tooLarge) {
        yield {
          type: "error",
          message: `fx printed a stdout line longer than ${FX_CLI_MAX_LINE_CHARS} characters (8 MiB). It was not parsed, so the run has no usable result and is reported as failed.`,
          code: "FX_CLI_RESULT_TOO_LARGE",
          recoverable: false,
          timestamp: Date.now(),
        };
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }

      if (result === undefined) {
        if (processExit !== 0) {
          yield exitErrorEvent({
            runtime: "fx",
            exitCode: processExit,
            stderr: stderrLines,
            code: "FX_CLI_EXIT",
          });
          yield {
            type: "completed",
            exitCode: processExit,
            timestamp: Date.now(),
          };
          return;
        }
        yield {
          type: "error",
          message:
            "fx exited with code 0 but printed no JSON result object, so the run has no answer. Check that the fx version prints one with --json (fx 0.0.16).",
          code: "FX_CLI_NO_RESULT",
          recoverable: false,
          timestamp: Date.now(),
        };
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }

      yield* resultEvents(result, processExit, stderrLines);
    } finally {
      supervisor.release();
    }
  }
}

function nonJsonLineEvent(line: string): ExternalAgentEvent {
  return {
    type: "error",
    message: `Ignoring a non-JSON line from fx ask --json: ${line.slice(0, 200)}`,
    code: "FX_CLI_NON_JSON_LINE",
    recoverable: true,
    timestamp: Date.now(),
  };
}

/**
 * The error text of a failed tool call. fx may add an `error` string or object
 * (`{ category, code }`) to the entry; it becomes text, never `[object Object]`.
 */
function toolErrorText(name: string, status: string, error: unknown): string {
  const base = `fx tool call ${name} ended with status ${status}`;
  if (typeof error === "string" && error.length > 0) {
    return `${base}: ${error}`;
  }
  if (isJsonObject(error)) {
    const category = stringValue(error.category);
    const code = stringValue(error.code);
    const detail =
      category !== undefined || code !== undefined
        ? [category, code === undefined ? undefined : `(${code})`]
            .filter((part) => part !== undefined)
            .join(" ")
        : JSON.stringify(error);
    return `${base}: ${detail}`;
  }
  return base;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** The usage of an fx result; counters that are `null` or absent are left out. */
function fxUsage(value: unknown): ExternalAgentUsage | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const usage: ExternalAgentUsage = {};
  const input = numberValue(value.input_tokens);
  const output = numberValue(value.output_tokens);
  const cacheRead = numberValue(value.cache_read_tokens);
  const cacheWrite = numberValue(value.cache_write_tokens);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cacheRead !== undefined) usage.cacheReadInputTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheCreationInputTokens = cacheWrite;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function cut(text: string, max = MESSAGE_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * The classifier code of a failure, with `FX_CLI_ERROR` as the fallback.
 * `recovery.need` `quota` is `QUOTA_EXHAUSTED`; `content_filter`, `rejected`
 * and `too_long`, and `model_not_found` in the text, are `INVALID_REQUEST`.
 * All of these are not recoverable. Otherwise the shared classifier decides
 * the code and {@link fxRecoverable} the recoverability.
 */
function fxClassification(
  text: string,
  need?: string,
): { code: string; recoverable: boolean } {
  if (need === "quota") {
    return { code: "QUOTA_EXHAUSTED", recoverable: false };
  }
  if (
    need === "content_filter" ||
    need === "rejected" ||
    need === "too_long" ||
    /model[_ ]not[_ ]found/i.test(text)
  ) {
    return { code: "INVALID_REQUEST", recoverable: false };
  }
  const { code } = classifyRecoverable({
    message: text,
    fallbackCode: "FX_CLI_ERROR",
  });
  return { code, recoverable: fxRecoverable(text) };
}

/**
 * Whether a failure text is a condition a retry may fix. `model_not_found`
 * arrives with an HTTP 502 that the shared classifier reads as a transport
 * error, so it is decided here and not in the shared classifier.
 */
function fxRecoverable(text: string): boolean {
  if (/model[_ ]not[_ ]found/i.test(text)) {
    return false;
  }
  return isRecoverableMessage(text);
}

function* resultEvents(
  result: FxResult,
  processExit: number,
  stderr: readonly string[],
): Generator<ExternalAgentEvent> {
  const resultExit = numberValue(result.exit_code);
  const errorName = stringValue(result.error);
  // The run failed on a non-zero process exit, an `exit_code` that is not the
  // number 0 (a string, `null`, any other number) or an `error` name.
  const failed =
    processExit !== 0 || resultExit !== 0 || errorName !== undefined;
  let exitCode = 0;
  if (processExit !== 0) {
    exitCode = processExit;
  } else if (failed) {
    exitCode = resultExit !== undefined && resultExit !== 0 ? resultExit : 1;
  }
  const finalOutput = stringValue(result.final_output) ?? "";
  // On a failed run this text is the reason, never an answer.
  const output = stringValue(result.output)?.trim() || finalOutput.trim();

  const toolEvents: ExternalAgentEvent[] = [];
  const toolCalls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  toolCalls.forEach((call, index) => {
    const record = isJsonObject(call) ? call : {};
    const name = stringValue(record.name) ?? "unknown";
    const status = stringValue(record.status) ?? "unknown";
    // fx gives no arguments, ids or times: the ids pair the replayed events.
    const callId = `fx-tool-${index}`;
    const metadata = { fx: { replayed: true, status } };
    toolEvents.push(
      { type: "tool_call", name, callId, metadata, timestamp: Date.now() },
      {
        type: "tool_result",
        name,
        result: undefined,
        callId,
        ...(status === "success"
          ? {}
          : { error: toolErrorText(name, status, record.error) }),
        metadata,
        timestamp: Date.now(),
      },
    );
  });
  yield* toolEvents;

  // A failed run has no answer: its text rides in the error event instead.
  if (failed) {
    yield failureEvent(result, errorName, output, stderr, {
      exitCodeOnly:
        processExit === 0 &&
        resultExit === undefined &&
        errorName === undefined,
    });
  } else {
    const answer = finalOutput.length > 0 ? finalOutput : output;
    if (answer.length > 0) {
      yield { type: "output", content: answer, timestamp: Date.now() };
    }
  }

  const model = stringValue(result.model);
  const turns = numberValue(result.steps);
  const usage = fxUsage(result.usage);
  const completed: ExternalAgentCompletedEvent = {
    type: "completed",
    exitCode,
    ...(model ? { model } : {}),
    ...(turns === undefined ? {} : { numTurns: turns }),
    ...(usage ? { usage } : {}),
    timestamp: Date.now(),
  };
  yield completed;
}

function failureEvent(
  result: FxResult,
  errorName: string | undefined,
  output: string,
  stderr: readonly string[],
  flags: { exitCodeOnly: boolean },
): ExternalAgentEvent {
  const timestamp = Date.now();
  if (errorName === "NonInteractivePermissionRequired") {
    const blocked = stderr
      .map((line) => line.trim())
      .filter((line) => /blocked action|reason=/i.test(line))
      .slice(0, 3)
      .map((line) => cut(line, 300));
    return {
      type: "error",
      message: `fx needed an approval that a noninteractive ask run cannot give, so the run ended at its first sensitive action. That action did not run; actions before it may have run. Use the workspace-write mode with allowUnsandboxedShell: true, or the full-access mode, to allow it.${blocked.length > 0 ? ` fx said: ${blocked.join("; ")}` : ""}${output ? ` fx output: ${cut(output)}` : ""}`,
      code: "FX_CLI_PERMISSION_REQUIRED",
      recoverable: false,
      timestamp,
    };
  }
  const authFailure = isJsonObject(result.auth_failure)
    ? result.auth_failure
    : undefined;
  if (authFailure) {
    const source = stringValue(authFailure.source);
    const reason = stringValue(authFailure.reason);
    return {
      type: "error",
      message: cut(
        `fx authentication failed${source ? ` (${source})` : ""}${reason ? `: ${reason}` : ""}${output ? `. ${output}` : ""}`,
      ),
      code: "AUTH_ERROR",
      recoverable: false,
      timestamp,
    };
  }
  const recovery = isJsonObject(result.recovery) ? result.recovery : undefined;
  if (recovery) {
    const need = stringValue(recovery.need);
    const recoveryMessage = stringValue(recovery.message);
    const text = recoveryMessage ?? (output || "fx needs the user");
    // The fx text is the detail when the recovery message replaced it.
    const detail =
      recoveryMessage !== undefined && output ? ` fx output: ${output}` : "";
    return {
      type: "error",
      message: cut(
        `fx stopped and needs the user${need ? ` (${need})` : ""}: ${text}${detail}`,
      ),
      ...fxClassification(text, need),
      timestamp,
    };
  }
  if (flags.exitCodeOnly) {
    return {
      type: "error",
      message: cut(
        `fx printed a result whose exit_code is not a number (${cut(JSON.stringify(result.exit_code) ?? "missing", 40)}), so the run is reported as failed.${output ? ` fx output: ${output}` : ""}`,
      ),
      code: "FX_CLI_ERROR",
      recoverable: false,
      timestamp,
    };
  }
  const detail =
    output ||
    stderr
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3)
      .join("\n");
  const message = errorName
    ? cut(`fx ended with ${errorName}${detail ? `: ${detail}` : ""}`)
    : cut(detail || "fx ended with a failure and gave no reason");
  return {
    type: "error",
    message,
    ...fxClassification(message),
    timestamp,
  };
}
