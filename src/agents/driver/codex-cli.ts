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
import {
  classifyRecoverable,
  isKnownSubtype,
} from "../runtime/error-classification.js";
import {
  type CodexMcpLister,
  codexApprovalsReviewerOverrides,
  codexMcpDisableOverrides,
  listCodexMcpServers,
} from "./codex-mcp.js";
import { resolveCliLaunch, validateLaunchConfig } from "./launch.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  batchCommandRefusal,
  dependencyMissing,
  type ExternalAgentPolicyError,
  isCommandNotFound,
  policyErrorEvent,
  unenforceablePathsRefusal,
  unsandboxedShellRefusal,
} from "./policy-errors.js";
import { codexTurnUsage } from "./run-summary.js";
import {
  asRecord,
  bridgeEvent,
  buildChildEnv,
  exitErrorEvent,
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
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
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
  reviewedCliVersion: "0.167.0",
  sdkPackage: "@openai/codex-sdk",
  sdkPeerRange: ">=0.167.0 <0.168",
  reviewedSdkVersion: "0.167.0",
  reviewedBundledCliVersion: "0.167.0",
});

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
   * `--profile`/`-p`, `--enable`, `--disable`, `--search`, `--approve-for-me`,
   * `--dangerously-bypass-hook-trust`, `--worktree` (it moves the working
   * root under `CODEX_HOME`), and any `-c`/`--config` override of
   * `sandbox_mode`, `sandbox_workspace_write`, `sandbox_permissions`,
   * `default_permissions`, `permissions`, `approval_policy`,
   * `approvals_reviewer`, `web_search`, `tools`, `mcp_servers`, `features`,
   * `agents` (agent roles load their own config files), `profile` or
   * `profiles`. A cluster of one-letter flags is split first (`-hs x` is
   * `-h -s x`).
   */
  args?: readonly string[];
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

  /**
   * Creates a driver that runs the `codex` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty,
   * `killGraceMs` is not a finite number of at least 0, or `args` is not an
   * array of strings.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when an `args` entry overrides a
   * policy flag and `allowPolicyOverrideArgs` is not set.
   */
  constructor(config: CodexCliDriverConfig = {}) {
    validateDriverConfig("CodexCliDriver", config);
    validateLaunchConfig("CodexCliDriver", config);
    assertNoPinnedArgOverride(
      "CodexCliDriver",
      config.args,
      CODEX_CLI_PINNED_FLAGS,
      config.allowPolicyOverrideArgs ?? false,
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
   * event with the policy code, and `completed` with `exitCode: 1`. If the
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
    const env = this.buildEnv(request);
    const refuse = (error: ExternalAgentPolicyError) =>
      refusedRun(this.providerId, error);

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
    const args = this.buildArgs(request, mcp.overrides);
    let child: CodexCliSubprocess;
    try {
      child = this.#spawn(launch.command, [...launch.prefix, ...args], {
        cwd: launch.cwd ?? request.workingDirectory,
        env: launch.env ? { ...env, ...launch.env } : env,
      });
    } catch (error) {
      if (error instanceof BatchCommandRefusedError) {
        yield* refuse(batchCommandRefusal(error, "codex"));
        return;
      }
      // Bun.spawn throws when the binary does not exist.
      if (!isCommandNotFound(error)) {
        throw error;
      }
      yield* refuse(codexCliMissing());
      return;
    }
    const supervisor = superviseSubprocess(child, signal, {
      killGraceMs: this.#killGraceMs,
    });

    try {
      yield {
        type: "started",
        providerId: this.providerId,
        timestamp: Date.now(),
      };

      // Drain stderr while stdout is read so a chatty stderr cannot fill its
      // pipe and stall the process; its lines are reported after stdout.
      const stderrLines: string[] = [];
      let errored = false;
      let usage: ExternalAgentUsage | undefined;
      const stderrPromise = child.stderr
        ? collectTail(child.stderr, stderrLines)
        : Promise.resolve();

      if (child.stdout) {
        // `codex exec --json` reports one failure twice: an `error` event and
        // then a `turn.failed` carrying the same message. Surface it once.
        let lastErrorMessage: string | undefined;
        for await (const line of readLines(child.stdout)) {
          if (signal?.aborted) {
            return;
          }
          if (line.trim().length === 0) {
            continue;
          }
          const parsed = this.#parse(line);
          if (!parsed) {
            continue;
          }
          const { event, sourceType } = parsed;
          if (event.type === "completed") {
            // `turn.completed` is not the end of the run: the exit code is
            // checked first. Keep its usage for the final `completed`.
            if (event.usage) {
              usage = event.usage;
            }
            continue;
          }
          if (event.type === "error") {
            if (
              sourceType === "turn.failed" &&
              event.message === lastErrorMessage
            ) {
              continue;
            }
            lastErrorMessage = event.message;
            errored = true;
          }
          yield event;
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
          throw error;
        }
        yield policyErrorEvent(codexCliMissing());
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
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
        yield { type: "error", message: line, recoverable: false };
      }
      if (exitCode !== 0 && !errored) {
        // A failed run must not look like a quiet success.
        yield exitErrorEvent({
          runtime: "Codex CLI",
          exitCode,
          stderr: [],
          code: "CODEX_CLI_EXIT",
        });
      }
      yield {
        type: "completed",
        exitCode,
        ...(usage ? { usage } : {}),
        timestamp: Date.now(),
      };
    } finally {
      supervisor.release();
    }
  }

  /**
   * The `codex` argv for a run.
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
    const prompt = promptFromRequest(request);
    return [
      ...mapPolicyToCodexArgs(request.permissions),
      ...configOverrides.flatMap((override) => ["-c", override]),
      ...(this.#skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
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
    return buildChildEnv(
      this.#env,
      ["PATH", "HOME", "USER", "SHELL", "XDG_CONFIG_HOME"],
      request,
    );
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
    return this.#parse(line)?.event;
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

  #parse(line: string): ParsedCodexLine | undefined {
    const result = parseJson(line);
    if (!result.ok) {
      // A stray non-JSON line (a CLI banner, a debug print) must not end
      // the run. Log it and keep reading.
      warn(
        "CODEX_CLI_NON_JSON_LINE",
        `Ignoring a non-JSON line from codex exec --json: ${truncate(line.trim(), 200)}`,
      );
      return undefined;
    }
    // Codex's own `{"type":"error","message":...}` is also bridge-shaped, so
    // error lines are always normalized and classified below.
    const record = asRecord(result.value);
    if (record.type !== "error") {
      // A bridge-shaped line without its fields has no Codex meaning either.
      const bridged = bridgeEvent(record, "drop");
      if (bridged === "drop") {
        return undefined;
      }
      if (bridged !== undefined) {
        return { event: bridged, sourceType: bridged.type };
      }
    }
    const event = normalizeCodexEvent(result.value);
    if (!event) {
      return undefined;
    }
    return { event, sourceType: codexEventType(record) };
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

interface ParsedCodexLine {
  event: ExternalAgentEvent;
  /** The raw Codex event type, used to drop a duplicated `turn.failed`. */
  sourceType: string;
}

/** Codex event types whose payload is assistant text. */
const TEXT_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "agent_message",
  "agent_message_delta",
]);

function codexEventType(record: Record<string, unknown>): string {
  return stringValue(record.type) ?? stringValue(record.event) ?? "unknown";
}

function codexError(
  message: string,
  source: Record<string, unknown>,
  timestamp: number | undefined,
): ExternalAgentEvent {
  const explicitCode = stringValue(source.code);
  // Same classifier as the Codex SDK driver: a usage cap becomes a
  // non-recoverable QUOTA_EXHAUSTED, a rate limit stays recoverable.
  // An explicit code on the line wins, unless it is a classifier subtype key
  // (for example `quota_exhausted`): then the classified code is used, so it
  // matches what the SDK driver reports for the same condition.
  const classified = classifyRecoverable({
    subtype: explicitCode,
    message,
    fallbackCode: EXTERNAL_AGENT_ERROR,
    defaultRecoverable: false,
  });
  return {
    type: "error",
    message,
    code:
      explicitCode && !isKnownSubtype(explicitCode)
        ? explicitCode
        : classified.code,
    recoverable:
      typeof source.recoverable === "boolean"
        ? source.recoverable
        : classified.recoverable,
    timestamp,
  };
}

/**
 * Maps one Codex JSONL event to a bridge event. Only known text-bearing
 * events produce `output`; lifecycle and unknown events return `undefined`
 * so raw JSONL never reaches the assistant text.
 */
function normalizeCodexEvent(value: unknown): ExternalAgentEvent | undefined {
  const record = asRecord(value);
  const type = codexEventType(record);
  const timestamp = numberValue(record.timestamp);

  // `codex exec --json` ends a failed turn with `turn.failed`
  // ({ error: { message } }), which does not contain the word "error".
  if (type.includes("error") || type.includes("failed")) {
    const message =
      stringValue(record.message) ??
      stringValue(record.error) ??
      stringValue(asRecord(record.error).message) ??
      // An empty `turn.failed` (no message) gets a readable message
      // instead of the raw JSON line.
      `Codex reported ${type} without an error message`;
    return codexError(message, record, timestamp);
  }

  const item = asRecord(record.item);
  const itemType = stringValue(item.type);
  if (itemType === "agent_message") {
    // Like the SDK driver, only the completed message is assistant text;
    // `item.started` / `item.updated` would duplicate it.
    const text = type === "item.completed" ? extractText(item) : undefined;
    return text
      ? { type: "output", content: text, stream: "stdout", timestamp }
      : undefined;
  }

  if (itemType === "error") {
    const message =
      stringValue(item.message) ?? extractErrorMessage(item.error);
    return message ? codexError(message, item, timestamp) : undefined;
  }

  const toolName = extractToolName(record);
  if (toolName) {
    if (type === "item.completed") {
      return {
        type: "tool_result",
        name: toolName,
        result: item.result ?? item.aggregated_output ?? item,
        callId: stringValue(item.id),
        error: extractErrorMessage(item.error),
        metadata: { ...(itemType ? { itemType } : {}), builtin: true },
        timestamp,
      };
    }
    // One tool_call per callId: `item.started` opens it; `item.updated` is
    // progress of the same call and must not emit a second call.
    if (type === "item.updated") {
      return undefined;
    }
    return {
      type: "tool_call",
      name: toolName,
      input:
        itemType === "command_execution" && item.command !== undefined
          ? { command: item.command }
          : (record.input ?? record.arguments ?? item.input ?? item.arguments),
      callId: stringValue(item.id),
      metadata: { ...(itemType ? { itemType } : {}), builtin: true },
      timestamp,
    };
  }

  if (type === "thread.started" || type === "response.created") {
    return {
      type: "started",
      providerId: CODEX_PROVIDER.id,
      runId:
        stringValue(record.thread_id) ??
        stringValue(record.run_id) ??
        stringValue(record.id),
      timestamp,
    };
  }

  if (type === "turn.completed" || type === "response.completed") {
    // `turn.completed` carries the turn's token usage.
    const usage = codexTurnUsage(record.usage);
    return {
      type: "completed",
      exitCode: numberValue(record.exit_code),
      ...(usage ? { usage } : {}),
      timestamp,
    };
  }

  if (TEXT_EVENT_TYPES.has(type)) {
    const text = extractText(record);
    return text
      ? { type: "output", content: text, stream: "stdout", timestamp }
      : undefined;
  }

  return undefined;
}

function extractToolName(record: Record<string, unknown>): string | undefined {
  const directName = stringValue(record.name) ?? stringValue(record.tool_name);
  const type = stringValue(record.type) ?? "";
  if (directName && (type.includes("tool") || type.includes("call"))) {
    return directName;
  }

  const item = asRecord(record.item);
  const itemType = stringValue(item.type) ?? "";
  if (itemType.includes("tool") || itemType.includes("call")) {
    return (
      stringValue(item.name) ??
      stringValue(item.tool_name) ??
      stringValue(item.tool)
    );
  }
  if (itemType === "command_execution") {
    return "command_execution";
  }

  return undefined;
}

function extractErrorMessage(value: unknown): string | undefined {
  return stringValue(value) ?? stringValue(asRecord(value).message);
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  const direct =
    stringValue(record.content) ??
    stringValue(record.text) ??
    stringValue(record.delta) ??
    stringValue(record.message);
  if (direct) {
    return direct;
  }

  if (record.item !== undefined) {
    const itemText = extractText(record.item);
    if (itemText) {
      return itemText;
    }
  }

  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  return undefined;
}

function isIgnorableCodexStderr(line: string): boolean {
  return line.trim() === "Reading additional input from stdin...";
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
