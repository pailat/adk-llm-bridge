import { parseJson } from "../../utils/json.js";
import { warn } from "../../utils/log.js";
import {
  EXTERNAL_AGENT_ERROR,
  type ExternalAgentEvent,
  type ExternalAgentUsage,
} from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import {
  type CodexMcpLister,
  codexApprovalsReviewerOverrides,
  codexMcpDisableOverrides,
  listCodexMcpServers,
} from "./codex-mcp.js";
import {
  codexBridgeEnvelope,
  normalizeCodexJsonlEvent,
  normalizeCodexTransportEvent,
  warnNonJsonLine,
} from "./codex-message-mapper.js";
import { buildCodexEnv } from "./codex-run-env.js";
import {
  type CodexSdkClientLike,
  type CodexSdkInput,
  type CodexSdkThreadLike,
  runCodexTurn,
} from "./codex-sdk.js";
import {
  type CliLaunch,
  resolveCliLaunch,
  validateLaunchConfig,
} from "./launch.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  assertModelOption,
  assertNoModelOverride,
  CODEX_CLI_MODEL_FLAGS,
  CODEX_MODEL_ENV,
  envNameIn,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
} from "./model.js";
import { CODEX_CLI_OPTION_KEYS } from "./option-keys.js";
import {
  batchCommandRefusal,
  dependencyMissing,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
  isCommandNotFound,
  policyErrorEvent,
  sessionRefusal,
  unenforceablePathsRefusal,
  unsandboxedShellRefusal,
} from "./policy-errors.js";
import {
  assertKnownDriverOptions,
  exitErrorEvent,
  promptFromRequest,
  validateDriverConfig,
} from "./shared.js";
import {
  BatchCommandRefusedError,
  spawnSubprocess,
  superviseSubprocess,
} from "./spawn.js";
import {
  assertNoPinnedArgOverride,
  type PinnedFlags,
  SubprocessJsonlDriver,
} from "./subprocess-jsonl.js";

/**
 * Flags and config keys the Codex CLI driver sets from the policy, or that
 * would widen it (a profile, writable directories, a different working
 * root, feature switches, automatic approval, untrusted hooks, agent roles
 * with their own config). `args` may not pass them unless
 * `allowPolicyOverrideArgs` is set. Reviewed against the Codex version in
 * {@link CODEX_CLI_PINNED_FLAGS_REVIEW}.
 */
const CODEX_CLI_PINNED_FLAGS: PinnedFlags = {
  flags: [
    "--sandbox",
    "-s",
    "--ask-for-approval",
    "-a",
    "--full-auto",
    "--approve-for-me",
    // A hidden alias of `--approve-for-me` (not in `--help`).
    "--not-so-yolo",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    // Skips the user and project execpolicy `.rules` (forbidden and prompt
    // decisions, network rules).
    "--ignore-rules",
    "--yolo",
    "--add-dir",
    "--cd",
    "-C",
    "--worktree",
    "--profile",
    "-p",
    "--enable",
    "--disable",
    "--search",
  ],
  configFlags: ["-c", "--config"],
  configKeys: [
    "sandbox_mode",
    "sandbox_workspace_write",
    "sandbox_permissions",
    "default_permissions",
    "permissions",
    "approval_policy",
    "approvals_reviewer",
    "web_search",
    "tools",
    "mcp_servers",
    "features",
    "agents",
    "profile",
    "profiles",
  ],
  // Clap reads `-hs x` as `-h -s x`.
  booleanShortFlags: ["-h", "-V"],
};

/**
 * What the pinned `args` flags and config keys were last reviewed against:
 * the `codex exec --help` of `reviewedCliVersion`, and the SDK release (with
 * the `@openai/codex` version it bundles) installed at the time. A test
 * compares these with the installed SDK and the peer range, so any bump
 * fails until the list is reviewed again.
 *
 * @internal
 */
export const CODEX_CLI_PINNED_FLAGS_REVIEW = Object.freeze({
  reviewedCliVersion: "0.167.2",
  sdkPackage: "@openai/codex-sdk",
  sdkPeerRange: "0.167.2",
  reviewedSdkVersion: "0.167.2",
  reviewedBundledCliVersion: "0.167.2",
});

/**
 * `codex exec` options that take their value as the next argument, as listed
 * by `codex exec --help` of {@link CODEX_CLI_PINNED_FLAGS_REVIEW}. An entry
 * after one of them is its value; any other entry that does not start with
 * `-` is a positional word. A flag missing from this list makes the check
 * stricter, never looser. The list also keeps the flags the pinned and
 * model checks refuse first (`--sandbox`, `--model`, ...), so it matches the
 * help whatever order the checks run in.
 */
const CODEX_EXEC_VALUE_FLAGS: readonly string[] = [
  "-c",
  "--config",
  "--enable",
  "--disable",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "--thread-source",
  "--cyber-access-program",
  "--output-schema",
  "--color",
  "-o",
  "--output-last-message",
];

/** One-letter `codex exec` flags that take no value. */
const CODEX_EXEC_BOOLEAN_SHORT_FLAGS: readonly string[] = ["-h", "-V"];

/** Whether an option entry leaves its value to the next entry. */
function takesNextValue(arg: string): boolean {
  if (arg.startsWith("--")) {
    return CODEX_EXEC_VALUE_FLAGS.includes(arg);
  }
  // A cluster such as `-hi`: boolean letters, then one flag that takes the
  // rest of the entry, or the next entry when nothing is left.
  for (let index = 1; index < arg.length; index++) {
    const flag = `-${arg[index]}`;
    if (CODEX_EXEC_BOOLEAN_SHORT_FLAGS.includes(flag)) {
      continue;
    }
    return index === arg.length - 1 && CODEX_EXEC_VALUE_FLAGS.includes(flag);
  }
  return false;
}

/**
 * Refuses an `args` entry that `codex exec` would read as a positional word.
 *
 * @remarks
 * Security invariant: the driver ends the command line with `-- <prompt>`,
 * so a bare word in `args` comes before `--`, where `codex exec` reads it as
 * a subcommand (`review`, `resume`, `fork`, `help`: another mode than the
 * one the driver runs) or as the prompt. `-` (prompt from stdin) and `--`
 * are refused too. An entry right after an option that takes a value is
 * that value; `--image` takes several values only through repeated `-i`.
 *
 * A value flag as the last entry is not refused: the next argv entry is the
 * driver's `--`, which codex exec never takes as a value, so the run stops
 * at start with a usage error and nothing is swallowed or moved.
 *
 * @param args - The configured extra arguments, already checked to be
 * strings.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` for the first positional entry.
 */
function assertNoCodexPositionalArg(args: readonly string[] | undefined): void {
  const entries = args ?? [];
  for (let index = 0; index < entries.length; index++) {
    const arg = entries[index] ?? "";
    if (arg === "-" || arg === "--" || !arg.startsWith("-")) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_OPTION_UNSUPPORTED,
        `CodexCliDriver: the args entry "${arg}" is a positional word, which codex exec would read as a subcommand (review, resume, fork, help) or as the prompt, so the run would not be the one the driver starts. Pass only options (an option's value goes right after it; repeat -i for several images), or build the driver with allowPolicyOverrideArgs: true to pass it anyway.`,
      );
    }
    if (takesNextValue(arg)) {
      index++;
    }
  }
}

/** Warning code of a stderr line from a Codex CLI run that exited 0. */
const CODEX_CLI_STDERR = "CODEX_CLI_STDERR";
/** Options the driver passes to a {@link CodexCliSpawn}. */
export interface CodexCliSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * The complete environment of the process: an allowlisted copy, never the
   * whole of `process.env`.
   */
  env: Record<string, string>;
}

/** A running `codex` process, as the driver sees it. */
export interface CodexCliSubprocess {
  /** Output lines; the driver parses them as `codex exec --json` events. */
  stdout?: LineSource | null;
  /** Error output; reported as non-recoverable `error` events after stdout ends. */
  stderr?: LineSource | null;
  /** Resolves with the exit code; may reject with `ENOENT` when the binary is missing. */
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. Optional for custom spawns; the default spawn
   * always provides it. The driver sends SIGTERM first and, if the process
   * has not exited after `killGraceMs`, SIGKILL.
   */
  kill?: (signal?: NodeJS.Signals) => void;
}

// Re-exported so tests and custom `CodexCliSpawn` implementations can type their line streams.
export type { LineSource } from "./lines.js";

/**
 * Starts the `codex` process. Replace it in tests or to run Codex elsewhere.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory and environment.
 * @returns The running process.
 */
export type CodexCliSpawn = (
  command: string,
  args: readonly string[],
  options: CodexCliSpawnOptions,
) => CodexCliSubprocess;

/** Every `?: boolean` option of the driver config, checked when the driver is built. */
const CODEX_CLI_BOOLEAN_OPTIONS = [
  "requireExplicitModel",
  "allowPolicyOverrideArgs",
  "skipGitRepoCheck",
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
] as const;

/** Options for {@link CodexCliDriver}. */
export interface CodexCliDriverConfig {
  /**
   * The Codex executable.
   *
   * @defaultValue The command of the Codex provider (`codex`).
   */
  command?: string;
  /**
   * Runs the CLI as `<interpreter> <entry> <flags>` instead of `command`, for
   * a CLI that ships as a JavaScript package (Gemini CLI on Windows, where
   * the npm `.cmd` shim is refused). Set it with `entry`, and leave
   * `command` unset.
   *
   * @remarks
   * Security invariants: with the built-in spawn a bare name is looked up
   * like a bare `command` (no `PATH` entry inside the run's working
   * directory or `allowedPaths`, no relative entry; on Windows a native
   * `.exe`/`.com` only, never a `.cmd` or `.bat`). An absolute path is used
   * as given, unless it is inside the run's working directory or an
   * `allowedPaths` root, which refuses the run with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE`. A relative path is rejected by the
   * constructor. Only Node is accepted: the interpreter's real path
   * (symlinks resolved) must be named `node` (`node.exe` on Windows) and be a
   * native executable (PE, Mach-O or ELF header; a script shim such as
   * asdf's or nodenv's is not), or the run is refused with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before any spawn, because other
   * interpreters (Bun, version-manager shims) load configuration from the
   * run's working directory, which the agent writes. The interpreter starts
   * in the entry's directory, never in the run's working directory, and a
   * fixed `--import` preload changes into it before the entry runs; a
   * custom spawn receives that `cwd`, the preload arguments and the
   * `ADK_LLM_BRIDGE_AGENT_CWD` variable and must keep them.
   *
   * @defaultValue unset: the driver runs `command`
   */
  interpreter?: string;
  /**
   * The script `interpreter` runs, as an absolute path: the file the CLI
   * package's `package.json` names under `bin`. It goes before every flag.
   *
   * @remarks
   * Security invariant: a run whose entry is at or under its working
   * directory, an `allowedPaths` root or a temp directory a runtime sandbox
   * keeps writable (symlinks resolved) is refused with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before anything starts, with the
   * built-in spawn or a custom one: the agent could rewrite it and run code
   * on the host at the next run. With the built-in spawn a missing file is
   * `MISSING_BINARY`.
   *
   * @defaultValue unset
   */
  entry?: string;
  /**
   * Extra arguments placed after the policy flags and before the prompt.
   *
   * @remarks
   * Security invariant: an entry that would override a flag the driver pins
   * from the policy is refused when the driver is built, unless
   * `allowPolicyOverrideArgs` is set. That covers `--sandbox`/`-s`,
   * `--ask-for-approval`/`-a`, `--full-auto`,
   * `--dangerously-bypass-approvals-and-sandbox`, `--add-dir`, `--cd`/`-C`,
   * `--profile`/`-p`, `--enable`, `--disable`, `--search`, `--approve-for-me`
   * (and its hidden alias `--not-so-yolo`), `--dangerously-bypass-hook-trust`,
   * `--ignore-rules` (it drops the user and project execpolicy rules),
   * `--worktree` (it moves the working root under `CODEX_HOME`), and any
   * `-c`/`--config` override of
   * `sandbox_mode`, `sandbox_workspace_write`, `sandbox_permissions`,
   * `default_permissions`, `permissions`, `approval_policy`,
   * `approvals_reviewer`, `web_search`, `tools`, `mcp_servers`, `features`,
   * `agents` (agent roles load their own config files), `profile` or
   * `profiles`. A cluster of one-letter flags is split first (`-hs x` is
   * `-h -s x`).
   *
   * A positional word (an entry that does not start with `-`, and not the
   * value of the option before it), `-` and `--` are refused too
   * (`EXTERNAL_AGENT_OPTION_UNSUPPORTED`) unless `allowPolicyOverrideArgs` is
   * set: `codex exec` would read the word as a subcommand (`review`,
   * `resume`, `fork`, `help`) or as the prompt. `--ignore-user-config` is
   * allowed: it only stops Codex from loading `$CODEX_HOME/config.toml`.
   *
   * Entries that set or route the model are refused even with
   * `allowPolicyOverrideArgs` (`EXTERNAL_AGENT_MODEL_OVERRIDE`): `--model`/`-m`,
   * `--oss`, `--local-provider`, `--profile`/`-p`, and `-c`/`--config` keys
   * `model`, `model_provider`, `model_providers`, `oss_provider`,
   * `openai_base_url`, `chatgpt_base_url`, `model_catalog_json`,
   * `model_catalog_url`, `profile` and `profiles`. Use `model` instead.
   */
  args?: readonly string[];
  /**
   * Model id, sent as `--model=<id>` and reported as `gen_ai.request.model`.
   * A string of 1 to 256 characters without whitespace or control
   * characters, not starting with `-`; anything else is refused with
   * `EXTERNAL_AGENT_MODEL_INVALID` when the driver is built.
   *
   * @defaultValue the model of the host `config.toml`, or Codex's default
   */
  model?: string;
  /**
   * Refuse to build the driver without a `model`:
   * `EXTERNAL_AGENT_MODEL_REQUIRED`.
   *
   * @defaultValue false
   */
  requireExplicitModel?: boolean;
  /**
   * Opt-in: let `args` pass flags that override the policy flags (see
   * `args`). They are placed last, so with it the CLI's own handling of a
   * repeated flag decides, and the run may not keep the policy.
   *
   * @defaultValue false
   */
  allowPolicyOverrideArgs?: boolean;
  /**
   * Starts the process.
   *
   * With the built-in spawn a bare `command` is looked up on the child's
   * `PATH`, skipping every entry inside the run's working directory or
   * `allowedPaths` (see the class remarks). A custom spawn receives `command`
   * (or `interpreter`, with `entry` as the first argument) as given and does
   * its own lookup.
   *
   * @defaultValue The built-in spawn, which works on Bun and Node.
   */
  spawn?: CodexCliSpawn;
  /**
   * Ambient environment to copy `PATH`, `HOME`, `USER`, `SHELL` and
   * `XDG_CONFIG_HOME` from.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Pass `--skip-git-repo-check` to `codex exec`, allowing runs outside a
   * git repository (for example a temp directory). Matches the Codex SDK
   * driver option of the same name.
   *
   * @defaultValue false
   */
  skipGitRepoCheck?: boolean;
  /**
   * Milliseconds a cancelled process gets to exit after SIGTERM before it is
   * killed with SIGKILL.
   *
   * @defaultValue 2000
   */
  killGraceMs?: number;
  /**
   * Opt-in: without `allowNetwork: true`, run even where the driver cannot
   * enforce it. Without it such a run is refused with
   * `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`. It covers two cases:
   * - the `full-access` mode, which has no sandbox, so shell commands can
   *   reach the network;
   * - a failed listing of Codex's host MCP servers (see `listMcpServers`):
   *   the run goes on with a warning, and servers that were not listed stay
   *   enabled.
   *
   * @defaultValue false
   */
  allowUnenforcedNetwork?: boolean;
  /**
   * Opt-in: run a policy with `allowedPaths` (or path bounds inherited from a
   * parent agent) although this driver cannot check tool paths against them.
   * Without it such a run is refused with
   * `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. With it, the runtime's own sandbox
   * alone decides which paths the agent reaches.
   *
   * @defaultValue false
   */
  allowUnenforcedPaths?: boolean;
  /**
   * Lists Codex's host MCP servers. Without `allowNetwork: true` each listed
   * server is turned off with `-c mcp_servers.<name>.enabled=false`, because
   * MCP servers run outside the Codex sandbox and can reach the network.
   *
   * @defaultValue Runs `<command> mcp list --json` through `spawn`, with the
   * run's environment and working directory.
   */
  listMcpServers?: CodexMcpLister;
}

/** How to install the Codex CLI, for the missing-dependency error. */
const CODEX_CLI_INSTALL = "npm install -g @openai/codex";

function codexCliMissing(): ExternalAgentPolicyError {
  return dependencyMissing(
    "binary",
    "The Codex CLI (codex)",
    CODEX_CLI_INSTALL,
    "set command to the path of the codex binary",
  );
}

/**
 * Runs an external agent through the `codex exec --json` CLI.
 *
 * @remarks
 * Security and lifecycle invariants:
 * - The permission policy becomes Codex sandbox and approval flags (see
 *   {@link mapPolicyToCodexArgs}); `network_access` and `web_search` are
 *   pinned from the policy so a host `config.toml` cannot widen them.
 * - Fail closed: without `allowNetwork: true` a run that cannot be kept off the
 *   network is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` unless
 *   `allowUnenforcedNetwork` is set; a missing binary ends the run with
 *   `MISSING_BINARY`. Refusals are events, not exceptions.
 * - Codex runs file tools without asking the bridge, so a policy with
 *   `allowedPaths` (or inherited path bounds) is refused with
 *   `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless `allowUnenforcedPaths` is set.
 * - The process gets an allowlisted environment, never the whole of
 *   `process.env`.
 * - With the built-in spawn a bare `command` never resolves through a `PATH`
 *   entry inside the run's working directory or `allowedPaths`, or a
 *   relative one (see `resolveCliCommand`); when nothing is left the run ends
 *   with `MISSING_BINARY`.
 * - `args` come after the policy flags, so an entry that would override one of
 *   them makes the constructor throw `EXTERNAL_AGENT_OPTION_UNSUPPORTED`,
 *   unless `allowPolicyOverrideArgs` is set.
 * - Aborting the run sends SIGTERM, then SIGKILL after `killGraceMs`; the
 *   process is also killed if the consumer stops reading.
 * - This driver is a transport: the run loop (input, history, errors, the
 *   single `completed` event, temporary files) is the one `CodexSdkDriver`
 *   uses, and `@openai/codex-sdk` is not needed.
 */
export class CodexCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: CodexCliSpawn;
  readonly #builtInSpawn: boolean;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #skipGitRepoCheck: boolean;
  readonly #allowUnenforcedNetwork: boolean;
  readonly #allowUnenforcedPaths: boolean;
  readonly #listMcpServers?: CodexMcpLister;
  readonly #model: string | undefined;

  /**
   * Creates a driver that runs the `codex` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty,
   * `killGraceMs` is not a finite number of at least 0, or `args` is not an
   * array of strings.
   * @throws InputValidationError (from `@google/adk`) when a boolean option
   * (see the config's `?: boolean` fields) is set to a non-boolean value such
   * as the string `"false"`.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when an `args` entry overrides a
   * policy flag and `allowPolicyOverrideArgs` is not set.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_MODEL_OVERRIDE` when an `args` entry sets or routes the
   * model, `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not a model id,
   * and `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` is set
   * and `model` is absent.
   */
  constructor(config: CodexCliDriverConfig = {}) {
    assertKnownDriverOptions("CodexCliDriver", config, CODEX_CLI_OPTION_KEYS);
    validateDriverConfig("CodexCliDriver", config, CODEX_CLI_BOOLEAN_OPTIONS);
    validateLaunchConfig("CodexCliDriver", config);
    assertNoPinnedArgOverride(
      "CodexCliDriver",
      config.args,
      CODEX_CLI_PINNED_FLAGS,
      config.allowPolicyOverrideArgs ?? false,
    );
    assertNoModelOverride("CodexCliDriver", config.args, CODEX_CLI_MODEL_FLAGS);
    if (!(config.allowPolicyOverrideArgs ?? false)) {
      assertNoCodexPositionalArg(config.args);
    }
    const model = assertModelOption(
      "CodexCliDriver",
      config.model,
      config.requireExplicitModel ?? false,
      MODEL_ALIAS_DENYLIST.codex,
    );
    super({
      providerId: CODEX_PROVIDER.id,
      command:
        config.interpreter ??
        config.command ??
        CODEX_PROVIDER.command ??
        "codex",
      entry: config.entry,
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#builtInSpawn = config.spawn === undefined;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#skipGitRepoCheck = config.skipGitRepoCheck ?? false;
    this.#allowUnenforcedNetwork = config.allowUnenforcedNetwork ?? false;
    this.#allowUnenforcedPaths = config.allowUnenforcedPaths ?? false;
    this.#listMcpServers = config.listMcpServers;
    this.#model = model;
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /** `false`: Codex reports no model on any event. */
  get reportsResolvedModel(): boolean {
    return false;
  }

  /** Features this driver supports: it maps the permission policy onto CLI flags. It emits whole items, not token deltas. */
  capabilities(): AgentRuntimeCapabilities {
    return { streaming: false, permissions: true };
  }

  /**
   * Spawns `codex exec --json` for one turn and streams normalized events.
   *
   * @remarks
   * A refused run (see the class remarks) yields `started`, one `error`
   * event with the policy code, and `completed` with `exitCode: 1`. A
   * `request.runtimeSession` is refused first with
   * `EXTERNAL_AGENT_SESSIONS_UNSUPPORTED`, before any process starts. If the
   * abort signal fires, the stream ends without a `completed` event after the
   * process is killed. A duplicated `turn.failed` after an `error` with the
   * same message is reported once. After a non-zero exit, each stderr line
   * becomes a non-recoverable `error` event; after exit 0, stderr lines are
   * only logged as `CODEX_CLI_STDERR` warnings. A non-zero exit that reported
   * no error yields a `CODEX_CLI_EXIT` error before `completed`. Spawn errors other
   * than a missing binary are thrown.
   *
   * @param request - The run: permissions, credential, context and instruction.
   * @returns Events in order.
   */
  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }
    const refuse = (error: ExternalAgentPolicyError) =>
      refusedRun(this.providerId, error);
    const sessionsRefusal = sessionRefusal("CodexCliDriver", request);
    if (sessionsRefusal) {
      yield* refuse(sessionsRefusal);
      return;
    }
    const env = this.buildEnv(request);

    const envRefusal = modelEnvRefusal(
      "CodexCliDriver",
      env,
      envNameIn(CODEX_MODEL_ENV),
    );
    if (envRefusal) {
      yield* refuse(envRefusal);
      return;
    }
    const pathsRefusal = unenforceablePathsRefusal(request.permissions, {
      runtime: "Codex CLI",
      allowUnenforcedPaths: this.#allowUnenforcedPaths,
    });
    if (pathsRefusal) {
      yield* refuse(pathsRefusal);
      return;
    }
    const shellRefusal = unsandboxedShellRefusal(request.permissions, {
      runtime: "Codex CLI",
      allowUnenforcedNetwork: this.#allowUnenforcedNetwork,
    });
    if (shellRefusal) {
      yield* refuse(shellRefusal);
      return;
    }
    const resolved = resolveCliLaunch({
      command: this.command,
      entry: this.entry,
      env,
      request,
      builtInSpawn: this.#builtInSpawn,
      missing: codexCliMissing,
    });
    if ("refusal" in resolved) {
      yield* refuse(resolved.refusal);
      return;
    }
    const { launch } = resolved;
    const mcp = await codexMcpDisableOverrides(request.permissions, {
      command: launch.command,
      ...(launch.prefix.length > 0 ? { prefixArgs: launch.prefix } : {}),
      env: launch.env ? { ...env, ...launch.env } : env,
      cwd: launch.cwd ?? request.workingDirectory,
      lister:
        this.#listMcpServers ??
        ((options) => listCodexMcpServers(options, this.#spawn)),
      allowUnenforcedNetwork: this.#allowUnenforcedNetwork,
      runtime: "Codex CLI",
      commandNotFound: codexCliMissing,
    });
    if (mcp.refusal) {
      yield* refuse(mcp.refusal);
      return;
    }
    if (signal?.aborted) {
      return;
    }
    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };
    // The one run loop lives in `runCodexTurn`: this driver only supplies a
    // client whose threads run `codex exec --json`.
    const client = this.#client(request, launch, env, mcp.overrides);
    yield* runCodexTurn({
      request,
      open: () => ({ client, threadOptions: {} }),
      // The process keeps no thread: every run is a new `codex exec`.
      stateKey: undefined,
      normalize: (event) => {
        const normalized = normalizeCodexTransportEvent(event);
        return normalized ? [normalized] : [];
      },
      describeError: (error) => cliErrorEvent(error),
      endOnAbort: true,
      rethrow: (error) =>
        error instanceof CodexTransportFault
          ? { error: error.cause }
          : undefined,
    });
  }

  /**
   * The client the shared run loop drives: its thread starts one process and
   * streams the JSONL lines it prints.
   */
  #client(
    request: ExternalAgentRunRequest,
    launch: CliLaunch,
    env: Record<string, string>,
    configOverrides: readonly string[],
  ): CodexSdkClientLike {
    const runEnv = launch.env ? { ...env, ...launch.env } : env;
    const thread: CodexSdkThreadLike = {
      id: null,
      runStreamed: async (input, options) => {
        const { prompt, images } = cliTurnInput(input);
        const args = this.#argv(request, configOverrides, prompt, images);
        let child: CodexCliSubprocess;
        try {
          child = this.#spawn(launch.command, [...launch.prefix, ...args], {
            cwd: launch.cwd ?? request.workingDirectory,
            env: runEnv,
          });
        } catch (error) {
          if (error instanceof BatchCommandRefusedError) {
            throw batchCommandRefusal(error, "codex");
          }
          // Bun.spawn throws when the binary does not exist.
          if (!isCommandNotFound(error)) {
            throw new CodexTransportFault(error);
          }
          throw codexCliMissing();
        }
        const supervisor = superviseSubprocess(child, options?.signal, {
          killGraceMs: this.#killGraceMs,
        });
        return {
          events: readCodexCliEvents(child, supervisor, options?.signal),
        };
      },
    };
    return {
      startThread: () => thread,
      resumeThread: () => {
        throw new CodexTransportFault(
          new Error("CodexCliDriver keeps no thread to resume"),
        );
      },
    };
  }

  /**
   * Previews the policy flags and plain-text prompt for a run.
   *
   * @remarks
   * This synchronous preview omits the cold-start history transcript and
   * `--image` entries. {@link run} prepares the complete turn, including
   * history and private image files, before passing the actual argv to
   * the configured `spawn`. Observe that callback to audit the real argv.
   *
   * @param request - The run.
   * @param configOverrides - Extra `-c` values (for example the MCP server
   * disables), placed before the user's own args.
   * @returns The arguments, ending with `--` and the prompt, so a prompt that
   * starts with `-` is never read as a flag.
   */
  buildArgs(
    request: ExternalAgentRunRequest,
    configOverrides: readonly string[] = [],
  ): readonly string[] {
    return this.#argv(request, configOverrides, promptFromRequest(request), []);
  }

  #argv(
    request: ExternalAgentRunRequest,
    configOverrides: readonly string[],
    prompt: string,
    images: readonly string[],
  ): readonly string[] {
    return [
      ...mapPolicyToCodexArgs(request.permissions),
      ...configOverrides.flatMap((override) => ["-c", override]),
      // Joined, so the id can never be read as a flag.
      ...(this.#model === undefined ? [] : [`--model=${this.#model}`]),
      ...(this.#skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...images.map((path) => `--image=${path}`),
      ...this.args,
      "--",
      prompt,
    ];
  }

  /**
   * Environment for the Codex process.
   *
   * @remarks
   * Security invariant: this is an allowlist. Only `PATH`, `HOME`, `USER`,
   * `SHELL` and `XDG_CONFIG_HOME` are carried over from the ambient
   * environment, plus the keys in the provider `envAllowlist` that an `env`
   * credential supplies. Other secrets in the host environment never reach the
   * agent.
   *
   * @param request - The run, for its credential.
   * @returns The environment to spawn with.
   */
  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    return buildCodexEnv(this.#env, request, { ambientPassthrough: false });
  }

  /**
   * Parses one `codex exec --json` line.
   *
   * @param line - One line of stdout.
   * @returns The event, or `undefined` for lifecycle and unknown events
   * (`turn.started`, `item.started` without text, and so on) and for lines
   * that are not JSON, which carry nothing the bridge reports.
   */
  parseEvent(line: string): ExternalAgentEvent | undefined {
    const result = parseJson(line);
    if (!result.ok) {
      warnNonJsonLine(line);
      return undefined;
    }
    return normalizeCodexJsonlEvent(result.value);
  }

  /**
   * Like {@link CodexCliDriver.parseEvent}, but throws for a line that carries
   * no bridge event, matching the base {@link SubprocessJsonlDriver.parseLine}
   * contract.
   *
   * @param line - One line of stdout.
   * @returns The event.
   * @throws Error when the line carries no bridge event.
   */
  override parseLine(line: string): ExternalAgentEvent {
    const event = this.parseEvent(line);
    if (!event) {
      throw new Error("Codex JSONL line carries no external agent event");
    }
    return event;
  }
}

/** The events of a run refused before the process starts. */
async function* refusedRun(
  providerId: string,
  error: ExternalAgentPolicyError,
): AsyncIterable<ExternalAgentEvent> {
  yield { type: "started", providerId, timestamp: Date.now() };
  yield policyErrorEvent(error);
  yield { type: "completed", exitCode: 1, timestamp: Date.now() };
}

/**
 * Maps a permission policy to `codex` CLI arguments.
 *
 * @remarks
 * `read-only` uses the read-only sandbox and never asks, `ask` uses the
 * workspace-write sandbox and asks on request, `workspace-write` uses the
 * workspace-write sandbox without asking, and `full-access` bypasses
 * approvals and the sandbox. Outside `full-access` the arguments pin
 * `sandbox_workspace_write.network_access` (on only for `allowNetwork: true`,
 * and `web_search` disabled otherwise) so a host `config.toml` cannot widen
 * it. The arguments include
 * `exec --json`.
 *
 * @param policy - The policy; when omitted the `read-only` mode applies.
 * @returns The leading arguments for the `codex` command.
 */
export function mapPolicyToCodexArgs(
  policy: ExternalAgentPermissionPolicy = { mode: "read-only" },
): readonly string[] {
  return [
    ...codexModeArgs(policy),
    ...codexApprovalsReviewerOverrides(policy).flatMap((override) => [
      "-c",
      override,
    ]),
    ...codexNetworkArgs(policy),
  ];
}

/**
 * Pin the sandbox's network switch and web search to the policy, the way
 * the Codex SDK does (`sandbox_workspace_write.network_access`, `web_search`),
 * so a host config.toml cannot widen them. Network is off unless the policy
 * sets `allowNetwork: true`.
 */
function codexNetworkArgs(policy: ExternalAgentPermissionPolicy): string[] {
  if (policy.mode === "full-access") {
    return [];
  }
  return networkAllowed(policy)
    ? ["-c", "sandbox_workspace_write.network_access=true"]
    : [
        "-c",
        "sandbox_workspace_write.network_access=false",
        "-c",
        'web_search="disabled"',
      ];
}

function codexModeArgs(
  policy: ExternalAgentPermissionPolicy,
): readonly string[] {
  switch (policy.mode) {
    case "read-only":
      return [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--sandbox",
        "read-only",
      ];
    case "ask":
      return [
        "--ask-for-approval",
        "on-request",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
      ];
    case "workspace-write":
      return [
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
      ];
    case "full-access":
      return ["--dangerously-bypass-approvals-and-sandbox", "exec", "--json"];
  }
}

/** Marks an error of the process itself, which the caller of `run` receives as thrown. */
class CodexTransportFault extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CodexTransportFault";
  }
}

/** The one `error` event for a failure that is not a refusal. */
function cliErrorEvent(error: unknown): ExternalAgentEvent {
  if (error instanceof ExternalAgentPolicyError) {
    return policyErrorEvent(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  const { code, recoverable } = classifyRecoverable({
    message,
    fallbackCode: EXTERNAL_AGENT_ERROR,
    defaultRecoverable: false,
  });
  return { type: "error", message, code, recoverable, timestamp: Date.now() };
}

/**
 * The command-line form of a turn's input: the text parts joined the way the
 * SDK joins them, and the image files as `--image` values.
 */
function cliTurnInput(input: CodexSdkInput): {
  prompt: string;
  images: string[];
} {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }
  const text: string[] = [];
  const images: string[] = [];
  for (const part of input) {
    if (part.type === "text") {
      text.push(part.text);
    } else {
      images.push(part.path);
    }
  }
  return { prompt: text.join("\n\n"), images };
}

/**
 * Streams one `codex exec --json` process as thread events: every JSONL line
 * as parsed, then, once the process exited, its stderr and exit status as
 * bridge events ending with the one `completed` event.
 *
 * @remarks
 * `turn.completed` is not the end of the run: the exit code is checked
 * first, so its usage is kept for the final `completed`. After a non-zero
 * exit each stderr line becomes a non-recoverable `error`; after exit 0 they
 * are only logged. A non-zero exit that reported no error yields a
 * `CODEX_CLI_EXIT` error. The process is killed when the consumer stops
 * reading.
 */
async function* readCodexCliEvents(
  child: CodexCliSubprocess,
  supervisor: { markExited(): void; release(): void },
  signal: AbortSignal | undefined,
): AsyncGenerator<Record<string, unknown>> {
  const bridge = (event: ExternalAgentEvent) => codexBridgeEnvelope(event);
  try {
    // Drain stderr while stdout is read so a chatty stderr cannot fill its
    // pipe and stall the process; its lines are reported after stdout.
    const stderrLines: string[] = [];
    let errored = false;
    let usage: ExternalAgentUsage | undefined;
    const stderrPromise = child.stderr
      ? collectTail(child.stderr, stderrLines)
      : Promise.resolve();

    if (child.stdout) {
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        if (line.trim().length === 0) {
          continue;
        }
        const parsed = parseJson(line);
        if (!parsed.ok) {
          warnNonJsonLine(line);
          continue;
        }
        const event = normalizeCodexJsonlEvent(parsed.value);
        if (!event) {
          continue;
        }
        if (event.type === "completed") {
          // Keep its usage for the final `completed`.
          if (event.usage) {
            usage = event.usage;
          }
          continue;
        }
        if (event.type === "error") {
          errored = true;
        }
        yield parsed.value as Record<string, unknown>;
      }
    }
    await stderrPromise;
    if (signal?.aborted) {
      return;
    }

    let exitCode: number;
    try {
      exitCode = await child.exited;
    } catch (error) {
      // Node reports a missing binary through `exited`.
      supervisor.markExited();
      if (!isCommandNotFound(error)) {
        throw new CodexTransportFault(error);
      }
      yield bridge(policyErrorEvent(codexCliMissing()));
      yield bridge({ type: "completed", exitCode: 1, timestamp: Date.now() });
      return;
    }
    supervisor.markExited();
    if (signal?.aborted) {
      return;
    }
    // Codex prints warnings and progress on stderr even when the turn
    // succeeds, so stderr only describes a failure when the exit says so.
    for (const line of stderrLines) {
      if (isIgnorableCodexStderr(line)) {
        continue;
      }
      if (exitCode === 0) {
        warn(CODEX_CLI_STDERR, `Codex CLI stderr: ${truncate(line, 500)}`);
        continue;
      }
      errored = true;
      yield bridge({ type: "error", message: line, recoverable: false });
    }
    if (exitCode !== 0 && !errored) {
      // A failed run must not look like a quiet success.
      yield bridge(
        exitErrorEvent({
          runtime: "Codex CLI",
          exitCode,
          stderr: [],
          code: "CODEX_CLI_EXIT",
        }),
      );
    }
    yield bridge({
      type: "completed",
      exitCode,
      ...(usage ? { usage } : {}),
      timestamp: Date.now(),
    });
  } catch (error) {
    if (
      error instanceof ExternalAgentPolicyError ||
      error instanceof CodexTransportFault
    ) {
      throw error;
    }
    throw new CodexTransportFault(error);
  } finally {
    supervisor.release();
  }
}

function isIgnorableCodexStderr(line: string): boolean {
  return line.trim() === "Reading additional input from stdin...";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
