import { InputValidationError } from "@google/adk";
import { parseJson } from "../../utils/json.js";
import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CLAUDE_PROVIDER } from "../provider/claude.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import {
  claudeAssistantErrorEvent,
  toolResultEvents,
  toolUseEvents,
} from "./claude-agent-sdk.js";
import {
  assertClaudeMessageIsolated,
  type ClaudeIsolationPlan,
  claudeCliIsolationArgs,
  claudeInitTools,
  planClaudeIsolation,
} from "./claude-isolation.js";
import {
  applyBackgroundTaskSetting,
  backgroundTaskPendingEvent,
  ClaudeBackgroundTaskTracker,
  createClaudeRunTempDir,
} from "./claude-run-env.js";
import { resolveCliLaunch, validateLaunchConfig } from "./launch.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  batchCommandRefusal,
  dependencyMissing,
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
  isCommandNotFound,
  networkUnenforceable,
  policyErrorEvent,
  unenforceablePathsRefusal,
  webToolsRefusal,
} from "./policy-errors.js";
import {
  claudeResultSummary,
  type ExternalAgentRunSummary,
} from "./run-summary.js";
import {
  asRecord,
  bridgeEvent,
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
  type PinnedFlags,
  SubprocessJsonlDriver,
} from "./subprocess-jsonl.js";

/**
 * Flags the Claude CLI driver sets from the policy and its isolation, or that
 * would widen them (extra MCP servers, tools, directories, host integrations,
 * subagent definitions with their own tools and permission mode, plugins, a
 * different working root, or a session that runs outside this process).
 * `args` may not pass them unless `allowPolicyOverrideArgs` is set. Reviewed
 * against the Claude Code version in {@link CLAUDE_CLI_PINNED_FLAGS_REVIEW}.
 */
const CLAUDE_CLI_PINNED_FLAGS: PinnedFlags = {
  flags: [
    "--permission-mode",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-prompt-tool",
    "--permission-prompts",
    "--add-dir",
    "--tools",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--mcp-config",
    "--settings",
    "--setting-sources",
    "--agents",
    "--agent",
    "--plugin-dir",
    "--plugin-url",
    "--worktree",
    "-w",
    "--remote-control",
    "--cloud",
    "--teleport",
    "--environment",
    "--ide",
    "--chrome",
  ],
  // Commander reads `-pw` as `-p -w`.
  booleanShortFlags: ["-c", "-h", "-p", "-v"],
};

/**
 * What the pinned `args` flags were last reviewed against: the `claude --help`
 * of `reviewedCliVersion`, and the SDK release (with the Claude Code version
 * it bundles) installed at the time. A test compares these with the
 * installed SDK and the peer range, so any bump fails until the list is
 * reviewed again.
 *
 * @internal
 */
export const CLAUDE_CLI_PINNED_FLAGS_REVIEW = Object.freeze({
  reviewedCliVersion: "2.1.322",
  sdkPackage: "@anthropic-ai/claude-agent-sdk",
  sdkPeerRange: ">=0.3.319 <0.4",
  reviewedSdkVersion: "0.3.319",
  reviewedBundledCliVersion: "2.1.319",
});

/** The running `claude` process as the driver sees it. */
export interface ClaudeCliSubprocess {
  /** Standard output, read line by line as `stream-json`. */
  stdout?: LineSource | null;
  /** Standard error, collected to report a non-zero exit. */
  stderr?: LineSource | null;
  /**
   * Resolves with the exit code. May reject with a missing-binary error, which
   * the driver reports as a dependency error.
   */
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. Optional for custom spawns; the default spawn
   * always provides it. The driver sends SIGTERM first and, if the process
   * has not exited after `killGraceMs`, SIGKILL.
   */
  kill?: (signal?: NodeJS.Signals) => void;
}

/** Options the driver passes to a {@link ClaudeCliSpawn}. */
export interface ClaudeCliSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * Environment of the process. The driver builds it from an allowlist, so it
   * never carries the whole parent environment.
   */
  env?: Record<string, string>;
  /**
   * The prompt. A custom spawn must write it to the process's stdin and close
   * it: the driver passes no prompt argument, so `claude -p` reads it there.
   */
  input?: string;
}

/** Source of output lines accepted by the driver, re-exported from `lines.ts`. */
export type { LineSource } from "./lines.js";

/** Function that starts the `claude` process; replaceable for tests. */
export type ClaudeCliSpawn = (
  command: string,
  args: readonly string[],
  options: ClaudeCliSpawnOptions,
) => ClaudeCliSubprocess;

/** Configuration of {@link ClaudeCliDriver}. */
export interface ClaudeCliDriverConfig {
  /**
   * Binary to run.
   *
   * @defaultValue `"claude"`
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
   * Extra arguments appended after the ones the driver builds.
   *
   * @remarks
   * Security invariant: an entry that would override a flag the driver sets
   * from the policy or its isolation (`--permission-mode`,
   * `--dangerously-skip-permissions`, `--settings`, `--setting-sources`,
   * `--tools`, `--allowedTools`, `--disallowedTools`, `--mcp-config`,
   * `--add-dir`, `--plugin-dir`, `--ide`, `--chrome` and their spellings), or
   * that would widen the run another way (`--agents` and `--agent`, whose
   * subagent definitions carry their own tools, permission mode, MCP servers
   * and hooks; `--plugin-url`; `--permission-prompts`; `--worktree`/`-w`,
   * which moves the session root to the repository's worktree directory;
   * `--remote-control`, `--cloud`, `--teleport` and `--environment`, which
   * hand the session to another process), is refused when the driver is
   * built, unless `allowPolicyOverrideArgs` is set. A cluster of one-letter
   * flags is split first (`-pw` is `-p -w`). Use `model`, `maxTurns`,
   * `systemPrompt`, `tools` and the permission policy instead.
   */
  args?: readonly string[];
  /**
   * Opt-in: let `args` pass flags that override the policy and isolation
   * flags (see `args`). They are placed last, so with it the CLI's own
   * handling of a repeated flag decides, and the run may not keep the policy.
   *
   * @defaultValue false
   */
  allowPolicyOverrideArgs?: boolean;
  /**
   * Model id (`--model`); also reported as `gen_ai.request.model`.
   *
   * @defaultValue the CLI's own default
   */
  model?: string;
  /**
   * Maximum agent turns per run (`--max-turns`), a positive integer. A run
   * that reaches it ends with a `MAX_TURNS_EXCEEDED` error.
   *
   * @defaultValue no limit
   */
  maxTurns?: number;
  /**
   * System prompt that replaces Claude Code's default one
   * (`--system-prompt`). The run's `instruction` still goes in the prompt.
   *
   * @defaultValue Claude Code's default system prompt
   */
  systemPrompt?: string;
  /**
   * Custom process starter.
   *
   * With the built-in spawn a bare `command` is looked up on the child's
   * `PATH`, skipping every entry inside the run's working directory or
   * `allowedPaths` (see the class remarks). A custom spawn receives `command`
   * (or `interpreter`, with `entry` as the first argument) as given and does
   * its own lookup.
   *
   * @defaultValue a subprocess spawn that supports abort and kill
   */
  spawn?: ClaudeCliSpawn;
  /**
   * Environment the allowlisted variables (`PATH`, `HOME`, `USER`, `SHELL`,
   * Claude config dirs) are copied from.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Milliseconds a cancelled process gets to exit after SIGTERM before it is
   * killed with SIGKILL.
   *
   * @defaultValue 2000 (applied by the process supervisor)
   */
  killGraceMs?: number;
  /**
   * Built-in Claude Code tools the agent gets (`--tools`). Defaults to
   * `DEFAULT_CLAUDE_TOOLS`, minus what the policy removes (write and shell
   * tools under `read-only`, web tools without network). Pass `[]` for none.
   *
   * @defaultValue `DEFAULT_CLAUDE_TOOLS`
   */
  tools?: readonly string[];
  /**
   * Opt-in: inherit the host's Claude Code configuration. When `true` the
   * driver does not pin the tool set (unless `tools` is set) and does not pass
   * `--strict-mcp-config`, `--setting-sources=`, `--disable-slash-commands` or
   * `disableClaudeAiConnectors`, and the isolation checks (the `init`
   * listing and each `tool_use`) are off.
   * Isolated by default, like `ClaudeAgentSdkDriver`.
   *
   * @defaultValue false
   */
  inheritHostConfig?: boolean;
  /**
   * Opt-in: without `allowNetwork: true`, run Bash without the no-network
   * sandbox. Without it the sandbox is on and the run fails at start where the
   * sandbox cannot run. With it, shell commands can reach the network.
   *
   * @defaultValue false
   */
  allowUnsandboxedShell?: boolean;
  /**
   * Opt-in: in the no-network sandbox, let shell commands bind local
   * (loopback) ports, for tools that talk to their own workers over a local
   * port (Turbopack's PostCSS worker, test servers). macOS only: Claude Code
   * ignores it on Linux. Remote hosts stay denied, but treat it as network
   * access: binding a local port may let shell commands reach or
   * impersonate services that listen on loopback ports, and other local
   * processes can connect to the ports they open. Enable it only where
   * every local service is trusted. No effect when the sandbox is off
   * (`allowNetwork: true`, `allowUnsandboxedShell`).
   *
   * @defaultValue false
   */
  allowLocalBinding?: boolean;

  /**
   * Opt-out: let Claude Code run tasks in the background. Off by default,
   * as in `ClaudeAgentSdkDriver`: the driver sets
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for the process unless this is
   * true, and a run whose result arrives while a background task is still
   * running ends with an `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING` error and
   * exit code 1 either way.
   *
   * @defaultValue false
   */
  allowBackgroundTasks?: boolean;

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
   * Not supported: the CLI cannot mirror transcripts to a session store. Use
   * `ClaudeAgentSdkDriver` (the `ClaudeAgent` default) for `sessionStore`.
   * Typed `never` so the compiler rejects it; given anyway (for example from
   * JavaScript), the constructor throws.
   */
  sessionStore?: never;
  /** Not supported, like {@link sessionStore}; the constructor throws. */
  sessionStoreFlush?: never;
  /** Not supported, like {@link sessionStore}; the constructor throws. */
  sessionStoreLoadTimeoutMs?: never;
}

function claudeCliMissing(): ExternalAgentPolicyError {
  return dependencyMissing(
    "binary",
    "Claude Code (claude)",
    "npm install -g @anthropic-ai/claude-code",
    "set command to the path of the claude binary",
  );
}

/**
 * Runs Claude Code through its `claude -p --output-format stream-json` CLI and
 * maps the stream to {@link ExternalAgentEvent}s.
 *
 * @remarks
 * Security and lifecycle rules:
 * - The prompt goes on stdin, never in argv, so it cannot be read as a flag
 *   or a subcommand name.
 * - Isolated by default: an explicit tool list, no MCP servers, settings files,
 *   skills or claude.ai connectors. Every stdout line is checked, and the run
 *   stops with an `EXTERNAL_AGENT_ISOLATION_VIOLATED` error event when the CLI
 *   reports, or the model is about to use, a tool outside the configured set.
 * - Without `allowNetwork: true` Bash runs in a no-network sandbox that fails
 *   the run at start where it cannot run, unless `allowUnsandboxedShell` is set.
 * - The child environment is an allowlist, never the whole parent environment.
 * - `args` come after the policy and isolation flags, so an entry that would
 *   override one of them makes the constructor throw
 *   `EXTERNAL_AGENT_OPTION_UNSUPPORTED`, unless `allowPolicyOverrideArgs` is
 *   set.
 * - A policy with `allowedPaths` (or inherited path bounds) is refused with
 *   `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`, since the CLI runs file tools without
 *   asking the bridge, unless `allowUnenforcedPaths` is set.
 * - Abort stops the run: the process gets SIGTERM and, after `killGraceMs`,
 *   SIGKILL; the supervisor is always released.
 * - A missing binary becomes a policy error event with exit code 1.
 * - With the built-in spawn a bare `command` never resolves through a `PATH`
 *   entry inside the run's working directory or `allowedPaths`, or a
 *   relative one (see `resolveCliCommand`); when nothing is left the run ends
 *   with `MISSING_BINARY`.
 * - A failed `result` line (for example `error_max_turns`) or an assistant
 *   message with an `error` becomes one `error` event classified from its
 *   subtype, as in `ClaudeAgentSdkDriver`. Any other non-zero exit becomes an
 *   `error` event with code `CLAUDE_CLI_EXIT`, carrying the stderr tail; auth,
 *   billing and quota failures are not recoverable.
 * - `tool_use` and `tool_result` blocks become `tool_call` and `tool_result`
 *   events, so each tool use gets an `execute_tool` span.
 */
export class ClaudeCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: ClaudeCliSpawn;
  readonly #builtInSpawn: boolean;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #tools: readonly string[] | undefined;
  readonly #inheritHostConfig: boolean;
  readonly #allowUnsandboxedShell: boolean;
  readonly #allowLocalBinding: boolean;
  readonly #allowBackgroundTasks: boolean;
  readonly #allowUnenforcedPaths: boolean;
  readonly #model: string | undefined;
  readonly #maxTurns: number | undefined;
  readonly #systemPrompt: string | undefined;

  /**
   * Creates a driver that runs the `claude` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` or `model`
   * is empty, `killGraceMs` is not a finite number of at least 0, or
   * `maxTurns` is not a positive integer.
   * @throws InputValidationError when `args` is not an array of strings.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when `sessionStore`,
   * `sessionStoreFlush` or `sessionStoreLoadTimeoutMs` is given, or when
   * an `args` entry overrides a policy or isolation flag and
   * `allowPolicyOverrideArgs` is not set.
   */
  constructor(config: ClaudeCliDriverConfig = {}) {
    for (const option of [
      "sessionStore",
      "sessionStoreFlush",
      "sessionStoreLoadTimeoutMs",
    ] as const) {
      if ((config as Record<string, unknown>)[option] !== undefined) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_OPTION_UNSUPPORTED,
          `ClaudeCliDriver does not support ${option}: the Claude CLI cannot mirror session transcripts to a store. Use ClaudeAgentSdkDriver (the ClaudeAgent default) or remove ${option}.`,
        );
      }
    }
    validateDriverConfig("ClaudeCliDriver", config);
    validateLaunchConfig("ClaudeCliDriver", config);
    assertNoPinnedArgOverride(
      "ClaudeCliDriver",
      config.args,
      CLAUDE_CLI_PINNED_FLAGS,
      config.allowPolicyOverrideArgs ?? false,
    );
    if (
      config.model !== undefined &&
      (typeof config.model !== "string" || config.model.trim() === "")
    ) {
      throw new InputValidationError(
        "ClaudeCliDriver: model must be a non-empty string.",
      );
    }
    super({
      providerId: CLAUDE_PROVIDER.id,
      command:
        config.interpreter ??
        config.command ??
        CLAUDE_PROVIDER.command ??
        "claude",
      entry: config.entry,
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#builtInSpawn = config.spawn === undefined;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#tools = config.tools ? [...config.tools] : undefined;
    this.#inheritHostConfig = config.inheritHostConfig ?? false;
    this.#allowUnsandboxedShell = config.allowUnsandboxedShell ?? false;
    this.#allowLocalBinding = config.allowLocalBinding ?? false;
    this.#allowBackgroundTasks = config.allowBackgroundTasks ?? false;
    this.#allowUnenforcedPaths = config.allowUnenforcedPaths ?? false;
    this.#model = config.model;
    this.#maxTurns = config.maxTurns;
    this.#systemPrompt = config.systemPrompt;
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /** Features this driver supports: it maps the permission policy onto CLI flags. It emits whole messages, not token deltas. */
  capabilities(): AgentRuntimeCapabilities {
    return { streaming: false, permissions: true };
  }

  /**
   * Starts `claude` for one request and streams its events.
   *
   * @param request - The run request (instruction, context, permissions,
   * credential, working directory and abort signal).
   * @returns Events starting with `started` and, unless aborted, ending with
   * `completed`. An aborted run ends without a `completed` event.
   */
  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const isolation = this.isolationPlan(request);
    const args = this.buildArgs(request);
    const env = this.buildEnv(request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    if (isolation.unenforceableWebTools) {
      yield policyErrorEvent(
        networkUnenforceable(
          webToolsRefusal("Claude CLI", isolation.unenforceableWebTools),
        ),
      );
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }

    const pathsRefusal = unenforceablePathsRefusal(request.permissions, {
      runtime: "Claude CLI",
      allowUnenforcedPaths: this.#allowUnenforcedPaths,
    });
    if (pathsRefusal) {
      yield policyErrorEvent(pathsRefusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }

    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }

    const resolved = resolveCliLaunch({
      command: this.command,
      entry: this.entry,
      env,
      request,
      builtInSpawn: this.#builtInSpawn,
      missing: claudeCliMissing,
    });
    if ("refusal" in resolved) {
      yield policyErrorEvent(resolved.refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const { launch } = resolved;
    // A private temp directory for this run, removed when it ends.
    const runTemp = createClaudeRunTempDir();
    let child: ClaudeCliSubprocess;
    try {
      child = this.#spawn(launch.command, [...launch.prefix, ...args], {
        cwd: launch.cwd ?? request.workingDirectory,
        env: { ...env, ...runTemp?.env, ...launch.env },
        input: promptFromRequest(request),
      });
    } catch (error) {
      runTemp?.dispose();
      if (error instanceof BatchCommandRefusedError) {
        yield policyErrorEvent(batchCommandRefusal(error, "claude"));
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      // Bun.spawn throws when the binary does not exist.
      if (!isCommandNotFound(error)) {
        throw error;
      }
      yield policyErrorEvent(claudeCliMissing());
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const supervisor = superviseSubprocess(child, signal, {
      killGraceMs: this.#killGraceMs,
    });

    try {
      const stderrLines: string[] = [];
      const stderrPromise = child.stderr
        ? collectTail(child.stderr, stderrLines)
        : Promise.resolve();

      // Claude Code repeats the final assistant text in `result.result`.
      // Emit it only when no assistant text was streamed (as the SDK driver
      // does with `emittedOutput`), otherwise the answer appears twice.
      let emittedAssistantText = false;
      // The `result` line reports model, usage, cost, turns and duration;
      // they go on the `completed` event.
      let summary: ExternalAgentRunSummary = {};
      // Tool_use id -> tool name, to name the matching tool_result.
      const toolNames = new Map<string, string>();
      // A `result` line that reports a failure (`error_max_turns`, ...), and
      // whether an error was already reported from the stream.
      let resultError: Record<string, unknown> | undefined;
      let reportedError = false;
      // The tools the session's system/init reported, for the stop message.
      let offeredTools: string[] | undefined;
      // Background tasks still live when the run ends fail it.
      const backgroundTasks = new ClaudeBackgroundTaskTracker();
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        const raw = parseJsonLine(line);
        if (raw === undefined) {
          continue;
        }
        if (isolation.isolated) {
          // Fail closed when the CLI reports, or the model is about to use,
          // tools or MCP servers outside the configured set.
          offeredTools = claudeInitTools(raw) ?? offeredTools;
          try {
            assertClaudeMessageIsolated(
              raw,
              { tools: isolation.tools ?? [], mcpServers: [] },
              "Claude CLI",
              offeredTools,
            );
          } catch (error) {
            if (error instanceof ExternalAgentPolicyError) {
              yield policyErrorEvent(error);
              yield {
                type: "completed",
                exitCode: 1,
                timestamp: Date.now(),
              };
              return;
            }
            throw error;
          }
        }
        const record = asRecord(raw);
        backgroundTasks.observe(record);
        if (record.type === "assistant") {
          const error = claudeAssistantErrorEvent(record, "CLAUDE_CLI_ERROR");
          if (error) {
            reportedError = true;
            yield error;
            continue;
          }
        }
        if (record.type === "result" && isResultError(record)) {
          resultError = record;
          summary = claudeResultSummary(record);
          continue;
        }
        const content = asRecord(record.message).content;
        if (record.type === "user" && hasToolResults(content)) {
          // Tool results are runtime data, not model output.
          yield* toolResultEvents(
            content,
            toolNames,
            record.parent_tool_use_id,
          );
          continue;
        }
        const toolCalls =
          record.type === "assistant"
            ? toolUseEvents(content, toolNames, record.parent_tool_use_id)
            : [];
        const parsed = this.parseClaudeStreamLine(raw);
        if (!parsed) {
          yield* toolCalls;
          continue;
        }
        if (parsed.source === "result") {
          summary = parsed.summary;
        }
        if (!parsed.event) {
          yield* toolCalls;
          continue;
        }
        if (parsed.source === "assistant" && parsed.event.type === "output") {
          emittedAssistantText = true;
        }
        if (parsed.source === "result" && parsed.event.type === "output") {
          if (emittedAssistantText) {
            continue;
          }
          emittedAssistantText = true;
        }
        yield parsed.event;
        yield* toolCalls;
      }
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
        yield policyErrorEvent(claudeCliMissing());
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      supervisor.markExited();
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }

      if (resultError) {
        // The result line says why the run stopped (as the SDK driver reads
        // it); the exit code alone does not.
        if (!reportedError) {
          yield resultErrorEvent(resultError);
        }
        yield {
          type: "completed",
          exitCode: exitCode === 0 ? 1 : exitCode,
          ...summary,
          timestamp: Date.now(),
        };
        return;
      }

      if (exitCode === 0) {
        const pending = backgroundTasks.pending();
        if (pending.length > 0) {
          yield backgroundTaskPendingEvent(pending, "Claude CLI");
        }
        yield {
          type: "completed",
          exitCode: pending.length > 0 ? 1 : 0,
          ...summary,
          timestamp: Date.now(),
        };
        return;
      }

      if (!reportedError) {
        yield exitErrorEvent({
          runtime: "Claude CLI",
          exitCode,
          stderr: stderrLines,
          code: "CLAUDE_CLI_EXIT",
        });
      }
      yield { type: "completed", exitCode, ...summary, timestamp: Date.now() };
    } finally {
      supervisor.release();
      runTemp?.dispose();
    }
  }

  /**
   * CLI arguments for a request: `-p` with text input, output format,
   * permission flags, isolation flags, `model`, `maxTurns` and
   * `systemPrompt`, then the configured extra `args`.
   *
   * @remarks
   * The prompt is not an argument: {@link ClaudeCliDriver.run} writes it to
   * stdin. As an operand it could be read as a flag (`--version`) or, even
   * after `--`, as a subcommand name (`update`), which Claude Code would run
   * instead of the prompt.
   *
   * @param request - The run request.
   * @returns The argument list passed to the process.
   */
  buildArgs(request: ExternalAgentRunRequest): readonly string[] {
    return [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      ...mapClaudePermissionArgs(request.permissions),
      ...claudeCliIsolationArgs(this.isolationPlan(request)),
      // Joined to the flag, so a value that starts with `-` stays a value.
      ...(this.#model ? [`--model=${this.#model}`] : []),
      ...(this.#maxTurns !== undefined
        ? [`--max-turns=${this.#maxTurns}`]
        : []),
      ...(this.#systemPrompt !== undefined
        ? [`--system-prompt=${this.#systemPrompt}`]
        : []),
      ...this.args,
    ];
  }

  /**
   * The same isolation as `ClaudeAgentSdkDriver`: an explicit tool list,
   * no MCP servers, settings files, skills or claude.ai connectors, and the
   * no-network sandbox for Bash without `allowNetwork: true`.
   *
   * @param request - The run request; its permissions drive the plan.
   * @returns The plan for this run.
   */
  isolationPlan(request: ExternalAgentRunRequest): ClaudeIsolationPlan {
    return planClaudeIsolation(request.permissions, {
      tools: this.#tools,
      inheritHostConfig: this.#inheritHostConfig,
      allowUnsandboxedShell: this.#allowUnsandboxedShell,
      allowLocalBinding: this.#allowLocalBinding,
      env: this.#env,
      ...(request.workingDirectory
        ? { workingDirectory: request.workingDirectory }
        : {}),
    });
  }

  /**
   * Environment of the child process: only `PATH`, `HOME`, `USER`, `SHELL` and
   * the Claude config directories from the driver's environment, plus the
   * credential variables the provider allowlists when the credential is an
   * `env` one, and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` unless
   * `allowBackgroundTasks`. Nothing else is inherited.
   * {@link ClaudeCliDriver.run} adds the run's private temp directory
   * (`CLAUDE_CODE_TMPDIR`, `TMPDIR`).
   *
   * @param request - The run request.
   * @returns The environment to pass to the process.
   */
  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    // The config directories let Claude Code use its existing local
    // OAuth/native login cache without the bridge storing secrets.
    const env = buildChildEnv(
      this.#env,
      ["PATH", "HOME", "USER", "SHELL", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"],
      request,
    );
    applyBackgroundTaskSetting(env, this.#allowBackgroundTasks);
    return env;
  }

  /**
   * Maps one `stream-json` line to an event.
   *
   * @param line - One stdout line.
   * @returns The event, or `undefined` for a blank line, a JSON value that is
   * not an object, or a diagnostic (`system`, `rate_limit_event`) that is not
   * shown.
   * @throws `SyntaxError` when the line is not valid JSON.
   */
  parseClaudeLine(line: string): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = parseJson(trimmed);
    if (!parsed.ok) {
      throw new SyntaxError(parsed.error);
    }
    if (!isJsonObject(parsed.value)) {
      return undefined;
    }
    return normalizeClaudeEvent(parsed.value as ClaudeStreamEvent);
  }

  private parseClaudeStreamLine(raw: unknown):
    | {
        event: ExternalAgentEvent | undefined;
        source: ClaudeEventSource;
        summary: ExternalAgentRunSummary;
      }
    | undefined {
    const parsed = asRecord(raw) as ClaudeStreamEvent;
    const event = normalizeClaudeEvent(parsed);
    if (!event) {
      // A `result` line without text still reports the run summary.
      return parsed.type === "result"
        ? {
            event: undefined,
            source: "result",
            summary: claudeResultSummary(parsed),
          }
        : undefined;
    }
    const source: ClaudeEventSource =
      parsed.type === "assistant"
        ? "assistant"
        : parsed.type === "result" ||
            parsed.type === "completed" ||
            parsed.type === "complete"
          ? "result"
          : "other";
    return {
      event,
      source,
      summary: parsed.type === "result" ? claudeResultSummary(parsed) : {},
    };
  }
}

type ClaudeEventSource = "assistant" | "result" | "other";

/** A `result` line that reports a failure: an error subtype or `is_error`. */
function isResultError(record: Record<string, unknown>): boolean {
  const subtype = stringValue(record.subtype);
  return (
    record.is_error === true || (subtype !== undefined && subtype !== "success")
  );
}

/** Whether a user message carries `tool_result` blocks. */
function hasToolResults(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((block) => asRecord(block).type === "tool_result")
  );
}

/**
 * The `error` event for a failed `result` line, classified from its subtype
 * (`error_max_turns` is `MAX_TURNS_EXCEEDED`, ...), with its `errors` or
 * `result` text as the message.
 */
function resultErrorEvent(record: Record<string, unknown>): ExternalAgentEvent {
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((item): item is string => typeof item === "string")
    : [];
  const subtype = stringValue(record.subtype);
  const message =
    errors.join("\n") ||
    (subtype && subtype !== "success"
      ? undefined
      : stringValue(record.result)) ||
    `Claude CLI result: ${subtype ?? "error"}`;
  const classification = classifyRecoverable({
    subtype,
    message,
    fallbackCode: "CLAUDE_CLI_EXIT",
  });
  return {
    type: "error",
    message,
    code: classification.code,
    recoverable: classification.recoverable,
    timestamp: Date.now(),
  };
}

/**
 * Parses one stdout line. Blank lines give `undefined`; a non-JSON line (a
 * banner or debug print) is logged and skipped instead of ending the run.
 */
function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseJson(trimmed);
  if (parsed.ok) {
    return parsed.value;
  }
  warn(
    "CLAUDE_CLI_NON_JSON_LINE",
    `Ignoring a non-JSON line from claude --output-format stream-json: ${trimmed.slice(0, 200)}`,
  );
  return undefined;
}

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  message?: unknown;
  result?: string;
  text?: string;
  content?: unknown;
  name?: string;
  input?: unknown;
  tool_name?: string;
  tool_input?: unknown;
  error?: unknown;
  code?: unknown;
  session_id?: string;
  providerId?: string;
};

/**
 * Translates a permission policy into `claude` CLI flags.
 *
 * @remarks
 * `read-only` maps to `--permission-mode dontAsk`, `ask` to `manual`,
 * `workspace-write` to `acceptEdits` and `full-access` to `bypassPermissions`.
 * `dontAsk` denies every tool that would need a prompt; a tool that settings
 * pre-approve still runs. Read-only holds because the driver pins the read
 * tools (unless `inheritHostConfig` is set without `tools`), always removes
 * the write and shell tools, and denies `mcp__*`, so no write tool is left to
 * approve. `plan` is not
 * used: the CLI's plan mode runs a different model than `--model`.
 * Each allowed path becomes `--add-dir`.
 *
 * @param permissions - Policy of the run. Defaults to mode `ask`.
 * @returns The flag list.
 */
export function mapClaudePermissionArgs(
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);
  const args: string[] = [];

  if (flags.readOnly) {
    args.push("--permission-mode", "dontAsk");
  } else if (flags.requireApproval) {
    args.push("--permission-mode", "manual");
  } else if (flags.workspaceWrite) {
    args.push("--permission-mode", "acceptEdits");
  } else if (flags.fullAccess) {
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", "manual");
  }

  for (const path of flags.paths ?? []) {
    args.push("--add-dir", path);
  }

  return args;
}

function normalizeClaudeEvent(
  event: ClaudeStreamEvent,
): ExternalAgentEvent | undefined {
  const bridged = bridgeEvent(event as Record<string, unknown>);
  if (bridged !== undefined) {
    return bridged === "drop" ? undefined : bridged;
  }

  const type = event.type;
  if (type === "system" || type === "rate_limit_event") {
    // Claude Code stream-json emits lifecycle, hook, plugin, and rate-limit
    // diagnostics as system events. The bridge already emits a normalized
    // started/completed lifecycle, so suppress these diagnostics from chat text.
    return undefined;
  }

  if (type === "assistant" || type === "user") {
    const text = extractText(event.message ?? event.content ?? event.text);
    return text
      ? { type: "output", content: text, timestamp: Date.now() }
      : undefined;
  }

  if (type === "result" || type === "completed" || type === "complete") {
    // The run ends when the process exits, so a terminal line from the child
    // never becomes `completed`; only its final text is kept.
    const resultText = stringValue(event.result);
    return resultText
      ? { type: "output", content: resultText, timestamp: Date.now() }
      : undefined;
  }

  const toolName = stringValue(event.name) ?? stringValue(event.tool_name);
  if (toolName && (type === "tool_call" || type === "tool_use")) {
    return {
      type: "tool_call",
      name: toolName,
      input: event.input ?? event.tool_input,
      timestamp: Date.now(),
    };
  }

  if (type === "error") {
    const detail = isJsonObject(event.error) ? event.error : undefined;
    const message =
      (typeof event.error === "string" ? event.error : undefined) ??
      stringValue(detail?.message) ??
      stringValue(event.message) ??
      "Claude CLI error";
    const code = detail ? stringValue(detail.code) : stringValue(event.code);
    return {
      type: "error",
      message,
      code,
      recoverable: isRecoverableMessage(message),
      timestamp: Date.now(),
    };
  }

  const fallbackText = extractText(event);
  return fallbackText
    ? { type: "output", content: fallbackText, timestamp: Date.now() }
    : undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  const direct =
    stringValue(record.text) ??
    stringValue(record.content) ??
    stringValue(record.result) ??
    stringValue(record.message);
  if (direct) {
    return direct;
  }

  const arrayContent = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.parts)
      ? record.parts
      : undefined;
  if (arrayContent) {
    const parts = arrayContent
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  return undefined;
}
