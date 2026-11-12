import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { InputValidationError } from "@google/adk";
import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentMcpServerGrant,
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import {
  declaredMcpTool,
  guardRequestPaths,
  readOnlyMcpToolAllowed,
  readPathsReadAllowed,
} from "../permissions/confirmation.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import { canonicalPath, policySetsPaths } from "../permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CLAUDE_PROVIDER } from "../provider/claude.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import {
  flattenContentsToPrompt,
  safeCollectContents,
} from "../runtime/content-collector.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import type { SessionStoreFactory } from "../session-store/adk-artifacts.js";
import type { SessionStore } from "../session-store/types.js";
import {
  BRIDGE_MCP_SERVER,
  BRIDGE_TOOL_PREFIX,
  type ClaudeIsolationExpectation,
  type ClaudeIsolationPlan,
  ClaudeToolUseCheck,
  claudeInitTools,
  DEFAULT_CLAUDE_TOOLS,
  isExpectedClaudeTool,
  isListedClaudeMcpTool,
  planClaudeIsolation,
} from "./claude-isolation.js";
import {
  type CheckedMcpServer,
  type ClaudeMcpServer,
  checkClaudeMcpServers,
  checkMcpServerNetwork,
  checkStdioServerForRun,
} from "./claude-mcp-servers.js";
import {
  contentsToSdkMessages,
  type SDKUserMessage,
} from "./claude-message-mapper.js";
import {
  applyBackgroundTaskSetting,
  backgroundTaskPendingEvent,
  ClaudeBackgroundTaskTracker,
  type ClaudeRunTempDir,
  createClaudeRunTempDir,
} from "./claude-run-env.js";
import {
  claudeConfigDir,
  claudeSessionToolResultsDir,
  isSessionToolResultsRead,
} from "./claude-session-files.js";
import {
  type ClaudeSpillPathState,
  type ClaudeSpillReservation,
  reserveClaudeSpillPath,
} from "./claude-spill-guard.js";
import {
  checkMcpSecretsEnforceable,
  hasMcpSecrets,
  mcpSecretHost,
  resolveMcpSecrets,
  SecretScrubber,
} from "./mcp-secrets.js";
import {
  assertModelOption,
  assertSmallFastModelOption,
  isClaudeModelEnv,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
  withModelPins,
} from "./model.js";
import { CLAUDE_AGENT_SDK_OPTION_KEYS } from "./option-keys.js";
import {
  dependencyMissing,
  EXTERNAL_AGENT_DEPENDENCY_MISSING,
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
  EXTERNAL_AGENT_MCP_SERVER_INVALID,
  EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE,
  EXTERNAL_AGENT_MISSING_BINARY,
  EXTERNAL_AGENT_NO_RESULT,
  EXTERNAL_AGENT_NO_TURN,
  EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
  EXTERNAL_AGENT_TOOL_NOT_OFFERED,
  ExternalAgentPolicyError,
  networkUnenforceable,
  policyErrorEvent,
  webToolsRefusal,
} from "./policy-errors.js";
import {
  claudeInitModel,
  claudeResultBaseline,
  claudeResultSummary,
} from "./run-summary.js";
import {
  agentWritableRoots,
  asRecord,
  assertKnownDriverOptions,
  contextText,
  copyIfPresent,
  credentialEnv,
  describeMissingExecutable,
  executableCandidates,
  findExecutable,
  readCredentialEnv,
  removeUndefined,
  sandboxTempRoots,
  stringValue,
  validateDriverConfig,
} from "./shared.js";
import {
  type StrictBinaryCheck,
  strictBinaryRefusal,
} from "./strict-binary.js";

/**
 * Most SDK sessions for which the driver keeps the last usage counters; the
 * least recently updated one is dropped first.
 */
const MAX_USAGE_BASELINES = 256;

type ClaudeAgentSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

type ClaudeAgentSdkSettingSource = "user" | "project" | "local";

type ClaudeAgentSdkOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  abortController?: AbortController;
  permissionMode?: ClaudeAgentSdkPermissionMode;
  additionalDirectories?: string[];
  pathToClaudeCodeExecutable?: string;
  settingSources?: ClaudeAgentSdkSettingSource[];
  maxTurns?: number;
  model?: string;
  systemPrompt?:
    | string
    | { type: "preset"; preset: "claude_code"; append?: string };
  allowDangerouslySkipPermissions?: true;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  strictMcpConfig?: boolean;
  skills?: string[] | "all";
  managedSettings?: Record<string, unknown>;
  settings?: string | Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  resume?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  sessionId?: string;
  sessionStore?: SessionStore | SessionStoreFactory;
  sessionStoreFlush?: ClaudeSessionStoreFlush;
  loadTimeoutMs?: number;
  canUseTool?: ClaudeAgentSdkCanUseTool;
  hooks?: Partial<Record<string, ClaudeAgentSdkHookMatcher[]>>;
};

/** The subset of the SDK's `HookCallbackMatcher` the driver uses. */
type ClaudeAgentSdkHookMatcher = {
  matcher?: string;
  hooks: Array<
    (
      input: Record<string, unknown>,
      toolUseID: string | undefined,
      options: { signal: AbortSignal },
    ) => Promise<Record<string, unknown>>
  >;
};

type ClaudeAgentSdkCanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal?: AbortSignal;
    toolUseID?: string;
    title?: string;
    description?: string;
    decisionReason?: string;
    blockedPath?: string;
  },
) => Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

type ClaudeAgentSdkMessage = Record<string, unknown>;
type ClaudeAgentSdkToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};
type ClaudeAgentSdkToolDefinition = unknown;

/**
 * The object returned by `query()`. The real SDK returns a `Query` (an
 * `AsyncGenerator` that additionally exposes `interrupt()`); generator-based
 * test fakes expose `return()`. Both are used to tear down the spawned
 * subprocess on early break/error.
 */
type ClaudeAgentSdkQuery = AsyncIterable<ClaudeAgentSdkMessage> & {
  interrupt?(): Promise<void> | void;
  return?(value?: unknown): Promise<unknown> | unknown;
  /** Replaces the session's dynamic MCP servers; declared servers go here. */
  setMcpServers?(servers: Record<string, unknown>): Promise<{
    added?: string[];
    removed?: string[];
    errors?: Record<string, string>;
  }>;
  /** Connection state of each MCP server. Its `config` is never read. */
  mcpServerStatus?(): Promise<
    Array<{ name?: unknown; status?: unknown; error?: unknown }>
  >;
};

type ClaudeAgentSdkLike = {
  query(params: {
    prompt: string | AsyncIterable<unknown>;
    options?: ClaudeAgentSdkOptions;
  }): ClaudeAgentSdkQuery;
  createSdkMcpServer?(options: {
    name: string;
    version?: string;
    tools?: ClaudeAgentSdkToolDefinition[];
    alwaysLoad?: boolean;
  }): unknown;
  tool?(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<ClaudeAgentSdkToolResult>,
    extras?: Record<string, unknown>,
  ): ClaudeAgentSdkToolDefinition;
};

/** Result of looking for the Claude Code executable. */
export interface ClaudeExecutableResolution {
  /** Path to use, when one was configured or found on disk. */
  path?: string;
  /** Every candidate that was considered, in order, for error messages. */
  checked: string[];
}

/** Every `?: boolean` option of the driver config, checked when the driver is built. */
const CLAUDE_AGENT_SDK_BOOLEAN_OPTIONS = [
  "requireExplicitModel",
  "debugEvents",
  "inheritHostConfig",
  "allowUnsandboxedShell",
  "allowLocalBinding",
  "allowBackgroundTasks",
  "strictBinaryResolution",
  "forkSession",
] as const;

/** Configuration of {@link ClaudeAgentSdkDriver}. */
export interface ClaudeAgentSdkDriverConfig {
  /** Already loaded Claude Agent SDK module; skips `importSdk`. */
  sdk?: ClaudeAgentSdkLike;
  /**
   * Loader for the optional `@anthropic-ai/claude-agent-sdk` package.
   *
   * @defaultValue a dynamic import of the package
   */
  importSdk?: () => Promise<ClaudeAgentSdkLike>;
  /**
   * Absolute path to the `claude` executable. Takes precedence over the
   * `CLAUDE_CODE_EXECUTABLE` and `CLAUDE_CODE_PATH` variables and over the
   * search paths.
   */
  pathToClaudeCodeExecutable?: string;
  /**
   * Extra directories searched for the `claude` executable. A directory at
   * or under the run's working directory or `allowedPaths` is skipped; use
   * `pathToClaudeCodeExecutable` for a binary there.
   */
  executableSearchPaths?: string[];
  /**
   * Environment that `PATH`, `HOME`, `USER`, `SHELL` and the Claude config
   * directories are copied from. The child process never gets the whole
   * environment.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Which Claude Code settings files the SDK loads. Empty means none, so host
   * permission rules, MCP servers, hooks and `CLAUDE.md` cannot override the
   * bridge's policy.
   *
   * @defaultValue `[]`
   */
  settingSources?: ClaudeAgentSdkSettingSource[];
  /** Maximum agent turns per run (SDK `maxTurns`). */
  maxTurns?: number;
  /**
   * Model id passed to the SDK; also reported as `gen_ai.request.model`. A
   * string of 1 to 256 characters without whitespace or control characters,
   * not starting with `-`; anything else (including `""`, which the SDK
   * would drop for the default model) is refused with
   * `EXTERNAL_AGENT_MODEL_INVALID` when the driver is built.
   *
   * @defaultValue the account or host default
   */
  model?: string;
  /**
   * Refuse to build the driver without a `model`, or with an alias that lets
   * Claude Code choose (`default`, `best`, `opusplan`, `opusplan[1m]`), or
   * without a full-id `smallFastModel`: `EXTERNAL_AGENT_MODEL_REQUIRED`.
   *
   * @defaultValue false
   */
  requireExplicitModel?: boolean;
  /**
   * Model id of Claude Code's small/fast model, which runs the helper calls
   * (WebFetch page processing, tool summaries, titles). The driver sets
   * `ANTHROPIC_SMALL_FAST_MODEL` in the child environment, after the model
   * environment refusal: a host cannot forward that variable itself. Same
   * grammar as `model`; anything else is refused with
   * `EXTERNAL_AGENT_MODEL_INVALID` when the driver is built.
   *
   * @remarks
   * Required with `requireExplicitModel` (`EXTERNAL_AGENT_MODEL_REQUIRED`),
   * and then it must be a full model id, not an alias such as `haiku`.
   * Pinned, the runtime's helper fallback chain is off. Not covered: the
   * quota and key-check probes of a subscription login, and an organization
   * `deniedModels` policy, which replaces a denied pin with the main model.
   * The run reports every model it billed in `externalAgentModel.used`.
   *
   * @defaultValue the runtime's own small model (the built-in haiku, or the
   * main model when the runtime has no haiku tier)
   */
  smallFastModel?: string;
  /**
   * Emit every unrecognized SDK message as an `output` event containing its
   * JSON. For debugging only.
   *
   * @defaultValue false
   */
  debugEvents?: boolean;
  /**
   * MCP servers that must be connected before Claude starts the first model
   * turn. The SDK reports their connection state in `system/init`; treating a
   * missing or degraded required server as a provider error prevents the model
   * from silently continuing without its authority or completion tools.
   *
   * @remarks
   * An isolated run (the default) passes `strictMcpConfig` with the bridge's
   * own `adk_bridge` server and the servers in `mcpServers` alone, so it may
   * require only those; other host MCP servers load only with
   * `inheritHostConfig: true`. A required server from `mcpServers` that is
   * not connected within `mcpConnectTimeoutMs` ends the run with the
   * recoverable `EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE` error.
   *
   * @throws InputValidationError (from `@google/adk`) at construction when a
   * server other than `adk_bridge` or one in `mcpServers` is required without
   * `inheritHostConfig`.
   * @defaultValue `[]`
   */
  requiredMcpServers?: string[];
  /**
   * MCP servers the host declares for this agent, by server name. The agent
   * sees their tools as `mcp__<name>__<tool>`; header and env values are
   * secret references (`{ resolve }` or `{ env }`) or explicit
   * `{ public }` values, read when each run starts and never placed in the
   * runtime's options, command line or environment. Works in both modes.
   *
   * @remarks
   * Checked when the driver is built (names, shape, URL grammar, bare
   * secrets) and when a run starts (network, stdio command and arguments,
   * whether the run can keep the secrets from the agent), in that order and
   * before any resolver runs. Every secret read joins the run's scrubber,
   * which replaces it with `[redacted]` in events, logs, errors, session
   * store batches and successful tool results the model sees. An error
   * result from a server is not rewritten before the model sees it: a server
   * must not echo credentials. See docs/external-agent-isolation.md, "Host
   * MCP servers and secrets".
   *
   * @defaultValue none
   * @experimental
   */
  mcpServers?: Readonly<Record<string, ClaudeMcpServer>>;
  /**
   * How long the first message waits for required servers from `mcpServers`
   * to connect, in milliseconds (1000 to 120000).
   *
   * @defaultValue 10000
   * @experimental
   */
  mcpConnectTimeoutMs?: number;
  /**
   * Opt-in plain-string system prompt. When set, it REPLACES the
   * `claude_code` preset (and `request.instruction` is appended to it) so a
   * non-coding agent is not forced into the full coding-agent persona/token
   * cost. When unset, the driver keeps the preset+append default.
   *
   * @defaultValue the `claude_code` preset with `request.instruction` appended
   */
  systemPrompt?: string;
  /**
   * Built-in Claude Code tools the agent gets (the SDK `tools` option).
   * Defaults to {@link DEFAULT_CLAUDE_TOOLS}. Under a `read-only` policy
   * the write and shell tools are removed from it, and the web tools are
   * removed unless the policy sets `allowNetwork: true`. Pass `[]` for no
   * built-in tools.
   *
   * @defaultValue `DEFAULT_CLAUDE_TOOLS`
   */
  tools?: readonly string[];
  /**
   * Opt-in: let the agent inherit the host's Claude Code configuration. When
   * `true` the driver does not pin the tool set (the SDK default `claude_code`
   * preset applies unless `tools` is set), does not pass `strictMcpConfig`,
   * does not hide bundled skills or claude.ai connectors, and does not check
   * the `init` listing or each `tool_use` against the isolated set. Use it only when
   * the host's tools, MCP servers and connectors are trusted for this agent.
   * `settingSources` stays a separate opt-in.
   *
   * Security invariant: under `read-only`, and without `allowNetwork: true`
   * in every mode, host MCP tools are still denied by a `PreToolUse` hook
   * (pre-approved ones too); only the bridge's own tools run.
   *
   * @defaultValue false
   */
  inheritHostConfig?: boolean;
  /**
   * Opt-in: without `allowNetwork: true`, run Bash without the Claude Code
   * no-network sandbox. By default the sandbox is on (every host denied, no
   * unsandboxed escape) and the run fails at start where the sandbox cannot
   * run. With this set, shell commands can reach the network.
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
   * Opt-out: let Claude Code run tasks in the background (Bash
   * `run_in_background`, background subagents). Off by default: a headless
   * run ends at its result, nothing delivers a background task's completion,
   * and the model would stop while waiting for it. The driver sets
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for Claude Code unless this is
   * true. Either way, a run whose result arrives while a background task is
   * still running ends with an `EXTERNAL_AGENT_BACKGROUND_TASK_PENDING`
   * error and exit code 1.
   *
   * @defaultValue false
   */
  allowBackgroundTasks?: boolean;

  /**
   * Opt-in: refuse a run with `MISSING_BINARY` instead of letting the SDK
   * fall back to the Claude Code binary bundled with its install, when no
   * executable was found outside the directories the agent can write and
   * this package's install, the SDK package or its platform binary package
   * is at or under the run's working directory or `allowedPaths` (symlinks
   * resolved), or the SDK package cannot be located.
   *
   * @remarks
   * An explicit `pathToClaudeCodeExecutable`, `CLAUDE_CODE_EXECUTABLE` or
   * `CLAUDE_CODE_PATH` is used as given. Turning this on breaks a host
   * started from the directory its agent edits without a global `claude`
   * until one of those is set. It narrows the hole, it does not close it:
   * an agent that can write the installed packages can still change the
   * JavaScript the next host start loads (see the isolation guide). The check
   * inspects the SDK package as Node finds it from this package's install;
   * an SDK passed through `sdk` or `importSdk` is not inspected, so it must come from
   * that same install. A writable root nested inside a checked package
   * (for example its `vendor` directory) is refused too.
   *
   * @defaultValue false
   */
  strictBinaryResolution?: boolean;

  /**
   * If set, the driver passes this session id to the Claude SDK
   * `options.resume` field and sends only the current user turn (not the full
   * ADK history) so the SDK appends to the resumed session instead of
   * re-feeding history that the SDK already has on disk. It wins over every
   * other source. Resume order: this option, then the run's
   * `request.runtimeSession.id`, then the id saved in ADK session state (see
   * {@link claudeSdkSessionStateKey}), then the id this driver captured
   * earlier for the same ADK session.
   *
   * With an `mcpServers` secret (`{ resolve }` or `{ env }`) the run keeps
   * no transcript on disk and resumes nothing: the constructor refuses this
   * option with `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`, and a run
   * refuses `runtimeSession.id` the same way.
   */
  resumeSessionId?: string;
  /**
   * Pass-through for the Claude SDK `options.forkSession` flag. Use with
   * `resumeSessionId` to fork rather than continue the previous session.
   */
  forkSession?: boolean;
  /**
   * Durable storage every Claude session of this driver is mirrored to (the
   * SDK `sessionStore` option), and loaded from when a run resumes.
   *
   * @remarks
   * Passed to `query()` on every run, first turns and resumes alike, so a
   * resumed run reads its transcript from the store before Claude starts.
   * The SDK still writes the local transcript under the Claude config
   * directory. The SDK keys a transcript by a project key derived from the
   * working directory, so a resume finds it only from the same path. When
   * the SDK drops a batch it could not store (3 attempts in total, no retry
   * after a timeout) the run reports a recoverable
   * `CLAUDE_SESSION_STORE_MIRROR_ERROR` event and continues. `SqliteSessionStore` (from
   * `adk-llm-bridge/agents/session-store/sqlite`) is a ready adapter.
   *
   * Transcripts can hold tool output and file contents, and the store
   * receives them: protecting access to it is up to the host. With an
   * `mcpServers` secret the constructor refuses a store
   * (`EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`): the store needs the local
   * transcript, which a server's echo of its secret would reach unredacted.
   *
   * @experimental Follows the Claude Agent SDK's `@alpha` `sessionStore`
   * contract, which can change in a minor SDK release.
   * @defaultValue `undefined` (no store: only the local transcript is written)
   */
  sessionStore?: SessionStore | SessionStoreFactory;
  /**
   * How eagerly the SDK sends transcript entries to {@link sessionStore}
   * (the SDK `sessionStoreFlush` option): `"batched"` or `"eager"`.
   *
   * @remarks
   * Requires `sessionStore`; the constructor refuses it otherwise.
   *
   * @experimental Follows the Claude Agent SDK's `@alpha` option.
   * @defaultValue the SDK's default (`"batched"`)
   */
  sessionStoreFlush?: ClaudeSessionStoreFlush;
  /**
   * Milliseconds each `sessionStore.load()` / `listSubkeys()` call may take
   * when a run resumes (the SDK `loadTimeoutMs` option); a slower store fails
   * the run instead of hanging it.
   *
   * @remarks
   * Requires `sessionStore`; the constructor refuses it otherwise. A positive
   * integer.
   *
   * @experimental Follows the Claude Agent SDK's `@alpha` option.
   * @defaultValue the SDK's default (60 000)
   */
  sessionStoreLoadTimeoutMs?: number;
}

/**
 * How eagerly the Claude Agent SDK flushes transcript entries to a session
 * store (its `SessionStoreFlush`).
 *
 * @experimental Follows the Claude Agent SDK's `@alpha` `SessionStoreFlush`.
 */
export type ClaudeSessionStoreFlush = "batched" | "eager";

/** Refuses session store tuning the SDK would reject or silently ignore. */
function validateSessionStoreTuning(config: ClaudeAgentSdkDriverConfig): void {
  const { sessionStoreFlush, sessionStoreLoadTimeoutMs } = config;
  if (
    sessionStoreFlush !== undefined &&
    sessionStoreFlush !== "batched" &&
    sessionStoreFlush !== "eager"
  ) {
    throw new InputValidationError(
      'ClaudeAgentSdkDriver: sessionStoreFlush must be "batched" or "eager".',
    );
  }
  if (
    sessionStoreLoadTimeoutMs !== undefined &&
    !(
      typeof sessionStoreLoadTimeoutMs === "number" &&
      Number.isSafeInteger(sessionStoreLoadTimeoutMs) &&
      sessionStoreLoadTimeoutMs > 0
    )
  ) {
    throw new InputValidationError(
      "ClaudeAgentSdkDriver: sessionStoreLoadTimeoutMs must be a positive integer of milliseconds.",
    );
  }
  if (
    config.sessionStore === undefined &&
    (sessionStoreFlush !== undefined || sessionStoreLoadTimeoutMs !== undefined)
  ) {
    throw new InputValidationError(
      "ClaudeAgentSdkDriver: sessionStoreFlush and sessionStoreLoadTimeoutMs need a sessionStore; without one the SDK ignores them.",
    );
  }
}

/**
 * Built-in Claude Code tools an isolated agent gets by default.
 *
 * @deprecated Use {@link DEFAULT_CLAUDE_TOOLS}: this is the same list, which
 * both Claude drivers use. This alias stays until the next major version.
 */
export const DEFAULT_CLAUDE_SDK_TOOLS: readonly string[] = DEFAULT_CLAUDE_TOOLS;

/**
 * Code of the recoverable `error` event a Claude Agent SDK run reports when
 * the SDK dropped a transcript batch that its `sessionStore` rejected or timed
 * out on (3 attempts in total).
 * The run continues; the store is missing that batch.
 */
export const CLAUDE_SESSION_STORE_MIRROR_ERROR =
  "CLAUDE_SESSION_STORE_MIRROR_ERROR";

/**
 * Code of the non-recoverable `error` event a run reports, before the SDK
 * starts, when a `sessionStore` factory (such as `adkArtifactSessionStore()`)
 * cannot build its store, for example because the run has no ADK artifact
 * service.
 */
export const CLAUDE_SESSION_STORE_UNAVAILABLE =
  "CLAUDE_SESSION_STORE_UNAVAILABLE";

/** A `sessionStore` factory failed; reported as CLAUDE_SESSION_STORE_UNAVAILABLE. */
class SessionStoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SessionStoreUnavailableError";
  }
}

/** The bridge's delegation tool; it maps to transfer events, not tool events. */
const BRIDGE_SUBAGENT_TOOL = `${BRIDGE_TOOL_PREFIX}run_adk_subagent`;

/**
 * What `strictBinaryResolution` checks for Claude: the SDK takes its binary
 * from its own platform packages (its optional dependencies).
 *
 * @internal
 */
export const CLAUDE_STRICT_BINARY_CHECK: StrictBinaryCheck = {
  runtime: "Claude Agent SDK",
  sdkPackage: "@anthropic-ai/claude-agent-sdk",
  option: "pathToClaudeCodeExecutable",
  envVar: "CLAUDE_CODE_EXECUTABLE",
};

/**
 * Runs Claude Code through `@anthropic-ai/claude-agent-sdk` and maps its
 * messages to {@link ExternalAgentEvent}s.
 *
 * @remarks
 * Security and lifecycle rules:
 * - Isolated by default: an explicit tool list, `strictMcpConfig` with only the
 *   bridge's own `adk_bridge` MCP server, no skills, no claude.ai connectors
 *   and no host setting sources. Three layers enforce it: a `PreToolUse` hook
 *   denies a tool outside the set in every permission mode, the permission
 *   callback denies it when the host handles prompts, and each stream message
 *   is checked so the run stops with `EXTERNAL_AGENT_ISOLATION_VIOLATED`.
 *   `inheritHostConfig: true` turns these checks off.
 * - Fail-closed permissions: the host decides within the effective policy and
 *   can never grant more than it allows; `read-only` is always denied. With no
 *   host that handles prompts, the SDK denies them. An approval never rewrites
 *   the tool input.
 * - Without `allowNetwork: true`, Bash runs in a no-network sandbox, and the run
 *   fails at start where the sandbox cannot run, unless `allowUnsandboxedShell`.
 * - With `allowedPaths` (or inherited path bounds), Bash runs in the sandbox
 *   with only the allowed roots writable (reads are not limited). While a
 *   shell tool is on offer, a run is refused with
 *   `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` when its working directory is
 *   outside them, its shell runs unsandboxed (`allowNetwork: true`,
 *   `allowUnsandboxedShell`), it inherits the host config, or its working
 *   directory or an allowed root is in the sandbox's always-writable temp
 *   area.
 * - With `allowedPaths` (or inherited path bounds), a `PreToolUse` hook checks
 *   the path arguments of every tool call, also the edits and reads Claude
 *   Code approves without asking (inside its working directory and
 *   `additionalDirectories`), and denies a path outside them. The bridge's own
 *   tools are left to the bridge. One exception: `Read` of a file in the
 *   `tool-results` directory of the session this run started, where Claude
 *   Code saves a tool output too large to return inline (never a write, never
 *   another session).
 * - `readPaths` are not passed as `additionalDirectories` and never join the
 *   sandbox's writable roots. A known read tool may reach them (the hook lets
 *   it through, and the permission callback approves it without asking the
 *   host, in every mode); every other tool there is denied by the hook.
 * - The child environment is an allowlist, never the whole parent environment.
 * - Abort: the run's abort signal is bridged to the SDK's `AbortController`;
 *   when the consumer stops early or an error occurs, the driver interrupts the
 *   query and finalizes it so no `claude` subprocess lingers.
 * - Errors become `error` events (never thrown) followed by `completed`;
 *   recoverability comes from `classifyRecoverable`.
 * - Session resume: the SDK session id is kept per agent instance and ADK
 *   session, and in session state, so a later turn sends only the newest user
 *   message and the SDK reloads history from its own transcript. With an
 *   `mcpServers` secret there is no transcript on disk and no resume
 *   (`persistSession: false`): each turn folds the scrubbed ADK history
 *   into its prompt.
 * - A "model-less" result (success, `num_turns` 0, empty `result`) before
 *   any turn activity does not end the run: the turn that runs the input
 *   follows. A stream that ends after only such results fails with
 *   `EXTERNAL_AGENT_NO_TURN` instead of completing empty.
 * - A stream that ends with no result message at all (the child exited or
 *   the pipe closed mid-run) fails with `EXTERNAL_AGENT_NO_RESULT` and exit
 *   code 1, not a clean exit 0.
 */
export class ClaudeAgentSdkDriver {
  /** Provider id of this driver (`claude`). */
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly #sdk?: ClaudeAgentSdkLike;
  /** Removes the run-signal listener of each controller this driver built. */
  readonly #abortDetach = new WeakMap<AbortController, () => void>();
  readonly #importSdk: () => Promise<ClaudeAgentSdkLike>;
  readonly #env: Record<string, string | undefined>;
  readonly #pathToClaudeCodeExecutable?: string;
  readonly #executableSearchPaths: string[];
  readonly #settingSources: ClaudeAgentSdkSettingSource[];
  readonly #maxTurns?: number;
  readonly #model?: string;
  readonly #requireExplicitModel: boolean;
  readonly #smallFastModel?: string;
  readonly #debugEvents: boolean;
  readonly #requiredMcpServers: readonly string[];
  readonly #mcpServers: readonly CheckedMcpServer[];
  readonly #mcpConnectTimeoutMs: number;
  readonly #resumeSessionId?: string;
  readonly #forkSession?: boolean;
  readonly #sessionStore?: SessionStore | SessionStoreFactory;
  readonly #resolvedStores = new WeakMap<object, SessionStore>();
  readonly #sessionStoreFlush?: ClaudeSessionStoreFlush;
  readonly #sessionStoreLoadTimeoutMs?: number;
  readonly #systemPrompt?: string;
  readonly #tools?: readonly string[];
  readonly #inheritHostConfig: boolean;
  readonly #allowUnsandboxedShell: boolean;
  readonly #allowLocalBinding: boolean;
  readonly #allowBackgroundTasks: boolean;
  readonly #strictBinaryResolution: boolean;
  // Maps an ADK session id -> the SDK session id captured from the
  // first turn's system/init (or result) message. Subsequent turns of the same
  // ADK session pass it as `options.resume` and send only the newest user turn,
  // so the SDK reloads prior user/assistant/tool history from its own on-disk
  // transcript instead of replaying it through the user-only input stream
  // (which would crash with "Expected message role 'user', got 'assistant'").
  //
  // Keyed first by the requesting agent *instance*: a driver can be shared by
  // several agents (e.g. `ExternalAgent.clone()` reuses it), and two of them
  // running in the same ADK session must not resume each other's transcript.
  readonly #sdkSessionsByAgent = new WeakMap<object, Map<string, string>>();
  // Cumulative counters of the last `result` per SDK session id (counters only;
  // past `MAX_USAGE_BASELINES` the least recently updated is dropped, because
  // each result moves its session to the end). A resumed session reports
  // cumulative `modelUsage`/`total_cost_usd`; this is the baseline to subtract.
  // In memory only: a session resumed from another process or replica, or from
  // `resumeSessionId`, has no baseline on its first run and reports its total,
  // marked `scope: "session"`.
  readonly #lastResultBySdkSession = new Map<string, unknown>();

  /**
   * Creates a driver that runs Claude through `@anthropic-ai/claude-agent-sdk`.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when a boolean option
   * (see the config's `?: boolean` fields) is set to a non-boolean value such
   * as the string `"false"`.
   * @throws {@link InputValidationError} when `requiredMcpServers` names a
   * server other than `adk_bridge` and `inheritHostConfig` is not `true`,
   * when `maxTurns` is not a positive integer, when `sessionStoreFlush` is not
   * `"batched"` or `"eager"`, when `sessionStoreLoadTimeoutMs` is not a
   * positive integer, or when either is given without `sessionStore`.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_OPTION_UNKNOWN` for a config that is not a plain object
   * or has an unknown key, `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not
   * a model id (it also covers `smallFastModel`),
   * `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` is set and
   * `model` is absent or a router alias, or `smallFastModel` is absent or an
   * alias, and `EXTERNAL_AGENT_MCP_SERVER_INVALID` or
   * `EXTERNAL_AGENT_MCP_SECRET_LITERAL` for a malformed `mcpServers` or
   * `mcpConnectTimeoutMs`.
   */
  constructor(config: ClaudeAgentSdkDriverConfig = {}) {
    assertKnownDriverOptions(
      "ClaudeAgentSdkDriver",
      config,
      CLAUDE_AGENT_SDK_OPTION_KEYS,
    );
    validateDriverConfig(
      "ClaudeAgentSdkDriver",
      config,
      CLAUDE_AGENT_SDK_BOOLEAN_OPTIONS,
    );
    this.#model = assertModelOption(
      "ClaudeAgentSdkDriver",
      config.model,
      config.requireExplicitModel ?? false,
      MODEL_ALIAS_DENYLIST.claude,
    );
    this.#requireExplicitModel = config.requireExplicitModel ?? false;
    this.#smallFastModel = assertSmallFastModelOption(
      "ClaudeAgentSdkDriver",
      config.smallFastModel,
      config.requireExplicitModel ?? false,
    );
    this.#mcpServers = checkClaudeMcpServers(config.mcpServers);
    this.#mcpConnectTimeoutMs = checkMcpConnectTimeout(
      config.mcpConnectTimeoutMs,
    );
    this.#sdk = config.sdk;
    this.#importSdk = config.importSdk ?? importClaudeAgentSdk;
    this.#env = config.env ?? process.env;
    this.#pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable;
    this.#executableSearchPaths = config.executableSearchPaths ?? [];
    // Default to SDK isolation (`[]`) instead of `undefined`. Leaving it
    // undefined causes `removeUndefined` to strip the key, which makes the SDK
    // load ALL host setting sources (user `~/.claude` + project `.claude` +
    // local) — permission rules, MCP servers, hooks, CLAUDE.md — and can
    // silently override the intended policy. Consumers opt back in by passing an
    // explicit allowlist.
    this.#settingSources = config.settingSources ?? [];
    this.#maxTurns = config.maxTurns;
    this.#debugEvents = config.debugEvents ?? false;
    this.#requiredMcpServers = [...new Set(config.requiredMcpServers ?? [])];
    const declaredNames = new Set(this.#mcpServers.map((s) => s.name));
    const unloadable = this.#requiredMcpServers.filter(
      (name) => name !== BRIDGE_MCP_SERVER && !declaredNames.has(name),
    );
    if (unloadable.length > 0 && !config.inheritHostConfig) {
      throw new InputValidationError(
        `requiredMcpServers (${unloadable.join(", ")}) needs inheritHostConfig: true, or a server of that name in mcpServers. An isolated Claude agent loads no host MCP servers, so a required one could never connect.`,
      );
    }
    this.#resumeSessionId = config.resumeSessionId;
    this.#forkSession = config.forkSession;
    // Declared secrets keep the transcript off disk (the transcript spill): Claude Code
    // writes a tool's raw result there, before the bridge's hook redacts it
    // for the model. A session store needs that local write, and a resumed
    // session continues a transcript on disk, so neither can be combined.
    if (
      hasMcpSecrets(this.#mcpServers) &&
      (config.sessionStore !== undefined ||
        config.resumeSessionId !== undefined)
    ) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
        `ClaudeAgentSdkDriver: ${config.sessionStore !== undefined ? "sessionStore" : "resumeSessionId"} cannot be combined with an MCP server that has a { resolve } or { env } secret. Claude Code would write the session transcript to disk, and a server that echoes its secret would leave it there unredacted. Drop the option, or pass the secret another way.`,
      );
    }
    this.#sessionStore = config.sessionStore;
    validateSessionStoreTuning(config);
    this.#sessionStoreFlush = config.sessionStoreFlush;
    this.#sessionStoreLoadTimeoutMs = config.sessionStoreLoadTimeoutMs;
    this.#systemPrompt = config.systemPrompt;
    this.#tools = config.tools ? [...config.tools] : undefined;
    this.#inheritHostConfig = config.inheritHostConfig ?? false;
    this.#allowUnsandboxedShell = config.allowUnsandboxedShell ?? false;
    this.#allowLocalBinding = config.allowLocalBinding ?? false;
    this.#allowBackgroundTasks = config.allowBackgroundTasks ?? false;
    this.#strictBinaryResolution = config.strictBinaryResolution ?? false;
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /** Whether the driver was built with `requireExplicitModel`. */
  get requireExplicitModel(): boolean {
    return this.#requireExplicitModel;
  }

  /** The configured small/fast model pin, if any. */
  get smallFastModel(): string | undefined {
    return this.#smallFastModel;
  }

  /** `true`: the SDK's `system/init` message and `result` name the model it ran. */
  get reportsResolvedModel(): boolean {
    return true;
  }

  /**
   * Features this driver supports: ADK tools, sub-agents, MCP servers,
   * approvals and permissions.
   *
   * @remarks
   * Streaming is not claimed: the driver emits whole assistant messages, not
   * token deltas (`includePartialMessages` is off). Claim it only together
   * with `stream_event` delta handling in `normalizeMessage`.
   */
  capabilities(): AgentRuntimeCapabilities {
    return {
      streaming: false,
      permissions: true,
      tools: true,
      subagents: true,
      mcpServers: true,
      approvals: true,
      sessions: true,
    };
  }

  /**
   * The servers declared in `mcpServers`, as the permission guard sees them.
   *
   * @returns One grant per declared server: name, tool allowlist and
   * read-only attestation.
   * @experimental
   */
  declaredMcpServers(): readonly ExternalAgentMcpServerGrant[] {
    return this.#mcpServers.map((server) => ({
      name: server.name,
      ...(server.tools !== undefined ? { tools: server.tools } : {}),
      readOnly: server.readOnly,
    }));
  }

  #sdkSessionsFor(request: ExternalAgentRunRequest): Map<string, string> {
    const owner: object = request.agent ?? this;
    let sessions = this.#sdkSessionsByAgent.get(owner);
    if (!sessions) {
      sessions = new Map();
      this.#sdkSessionsByAgent.set(owner, sessions);
    }
    return sessions;
  }

  /**
   * Runs one request through the SDK and streams its events.
   *
   * @remarks
   * Never throws for run failures: they are reported as an `error` event and a
   * `completed` event with exit code 1. `started` is always emitted first (it
   * waits for `system/init` to carry the resolved model). A stream that ends
   * with no `result` message ends with an `EXTERNAL_AGENT_NO_RESULT` error
   * (`EXTERNAL_AGENT_NO_TURN` after only model-less results) and exit code 1.
   *
   * @param request - The run request (instruction, context, permissions,
   * credential, working directory, abort signal and bridge tools).
   * @returns The event stream; it ends with exactly one `completed` event.
   */
  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    // Every event leaves through the run's scrubber, which holds the MCP
    // secrets the run read; it is cleared when the run ends.
    const scrubber = new SecretScrubber();
    try {
      for await (const event of this.#run(request, scrubber)) {
        yield scrubber.scrubDeep(event).value;
      }
    } finally {
      scrubber.clear();
    }
  }

  async *#run(
    request: ExternalAgentRunRequest,
    scrubber: SecretScrubber,
  ): AsyncIterable<ExternalAgentEvent> {
    // Resume order: static config, then the caller's `runtimeSession.id`,
    // then the id persisted in ADK session state (survives restarts and
    // replicas), then this process's per-agent memory.
    const adkSessionId = adkSessionIdOf(request);
    const stateKey = request.agent
      ? claudeSdkSessionStateKey(request.agent.name)
      : undefined;
    const persisted = stateKey
      ? readStateString(request.context, stateKey)
      : undefined;
    // With declared secrets nothing is resumed or saved: the transcript stays
    // off disk, and each turn folds the scrubbed ADK history into its prompt.
    const offDisk = hasMcpSecrets(this.#mcpServers);
    const resolvedResume = offDisk
      ? undefined
      : (this.#resumeSessionId ??
        stringValue(request.runtimeSession?.id) ??
        persisted ??
        (adkSessionId
          ? this.#sdkSessionsFor(request).get(adkSessionId)
          : undefined));

    // `started` waits for the first SDK message so it can carry the
    // resolved model from `system/init`; its timestamp is still the run start.
    const startedAt = Date.now();
    let startedEmitted = false;
    const startedEvent = (model?: string): ExternalAgentEvent => {
      startedEmitted = true;
      return {
        type: "started",
        providerId: this.providerId,
        ...(model ? { model } : {}),
        timestamp: startedAt,
      };
    };
    let initModel: string | undefined;
    // Tool_use id -> tool name, to name the matching tool_result.
    const toolNames = new Map<string, string>();

    const persistedIds = new Set<string>();
    let completed = false;
    let failed = false;
    let emittedOutput = false;
    // Whether this run saw any turn activity (assistant, stream or user
    // message), and the model-less results it read before any.
    let sawTurn = false;
    let modelLessResults = 0;
    let modelLessSession: string | undefined;
    // Capture the Query so we can tear down the spawned `claude`
    // subprocess on early consumer break or thrown error. We drive the iterator
    // manually (rather than `for await`) so the `finally` reliably runs even
    // when the consumer breaks out of *this* generator early — a `for await`
    // over the inner Query can swallow the outer return on some runtimes.
    // `query()` itself is invoked inside the try so a synchronous throw is
    // classified too. The `finally` runs on normal completion, break, AND throw.
    let query: ClaudeAgentSdkQuery | undefined;
    let abortController: AbortController | undefined;
    // Tools the isolation hook blocked; the run ends on the next message.
    const blockedTools: string[] = [];
    // The tools the session's system/init reported, for the stop message.
    let offeredTools: string[] | undefined;
    // Out-of-set calls held until the runtime answers them.
    let toolUseCheck: ClaudeToolUseCheck | undefined;
    // Reads of the session's own tool-results directory under allowedPaths.
    let sessionReads: SessionToolResultsReads | undefined;
    // Background tasks still live when the result arrives fail the run.
    const backgroundTasks = new ClaudeBackgroundTaskTracker();
    let runTemp: ClaudeRunTempDir | undefined;
    // With declared secrets: the session id the driver picks, and its
    // reserved session path, so no large tool result is saved to disk.
    const spillSessionId = offDisk ? randomUUID() : undefined;
    let spill: ClaudeSpillReservation | undefined;
    let spillMismatch = false;
    // What the end-of-run check found at the reserved path, and what it
    // scrubbed there.
    let spillEnd:
      | {
          state: ClaudeSpillPathState;
          scrubbed?: { files: number; rewritten: number };
        }
      | undefined;
    // Set by the gated prompt when the declared servers cannot be delivered;
    // reported instead of whatever the stream does next.
    let transportError: Error | undefined;
    // Start time of each MCP tool call, for `durationMs` on its result.
    const mcpEvents: ToolEventMcpContext = {
      servers: new Set(this.#mcpServers.map((server) => server.name)),
      started: new Map(),
    };
    for (const name of this.#requiredMcpServers) {
      if (name !== BRIDGE_MCP_SERVER) mcpEvents.servers.add(name);
    }
    try {
      // A session store factory that cannot build its store ends the run
      // here, before the SDK is loaded: a store that fails inside append()
      // would only be reported as mirror_error and the run would go on
      // without its transcript.
      this.resolveSessionStore(request);
      // A model variable in the child environment would change the model
      // the runtime runs: refuse before anything else.
      const envRefusal = modelEnvRefusal(
        "ClaudeAgentSdkDriver",
        this.buildEnv(request),
        isClaudeModelEnv,
      );
      if (envRefusal) {
        throw envRefusal;
      }
      if (offDisk && stringValue(request.runtimeSession?.id) !== undefined) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
          "ClaudeAgentSdkDriver: runtimeSession.id cannot be resumed with an MCP server that has a { resolve } or { env } secret. The run keeps no transcript on disk, so there is no session to continue. Leave runtimeSession unset.",
        );
      }
      // Declared MCP servers: network, stdio, then whether the run can keep
      // their secrets from the agent. Nothing is read yet.
      const stdioForRun = this.checkMcpServersForRun(request);
      // Shell writes that the sandbox cannot keep inside allowedPaths: refuse
      // before anything starts.
      const webTools = this.isolationPlan(request).unenforceableWebTools;
      if (webTools) {
        throw networkUnenforceable(
          webToolsRefusal("Claude Agent SDK", webTools),
        );
      }
      const shellPaths = this.isolationPlan(request).shellPathsUnenforceable;
      if (shellPaths) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
          `Claude Agent SDK cannot enforce allowedPaths: ${shellPaths}. Set the working directory inside allowedPaths, remove the shell tools (tools without Bash), or drop allowedPaths.`,
        );
      }
      // Inside the try: a missing SDK package becomes an error event, like
      // every other failure, instead of a throw out of the agent.
      const sdk = await this.loadSdk();
      const strictRefusal = this.strictBinaryRefusal(request);
      if (strictRefusal) {
        throw strictRefusal;
      }
      let prompt: string | AsyncIterable<unknown> = this.buildPromptInput(
        request,
        resolvedResume,
      );
      const built = await this.buildRunOptions(request, sdk, resolvedResume);
      let options = built.options;
      const isolation = this.isolationPlan(request);
      const declared = this.declaredMcpServers();
      const allowlists = Object.fromEntries(
        this.#mcpServers.flatMap((server) =>
          server.tools !== undefined ? [[server.name, server.tools]] : [],
        ),
      );
      // What an isolated run may report in system/init and use.
      const expectation: ClaudeIsolationExpectation | undefined =
        isolation.isolated
          ? {
              tools: isolation.tools ?? [],
              mcpServers: [
                ...Object.keys(options.mcpServers ?? {}),
                ...this.#requiredMcpServers,
                ...declared.map((server) => server.name),
              ],
              bridgeTools: built.bridgeTools,
              mcpToolAllowlists: allowlists,
            }
          : undefined;
      if (expectation) {
        toolUseCheck = new ClaudeToolUseCheck(expectation, "Claude Agent SDK");
        // Three layers: the hook blocks the call in every permission mode,
        // the permission callback denies it when the host handles prompts,
        // and the message check below ends the run.
        options = {
          ...options,
          hooks: withIsolationHook(
            options.hooks,
            expectation,
            (name) => {
              blockedTools.push(name);
            },
            { policy: request.permissions, declared },
          ),
          ...(options.canUseTool
            ? {
                canUseTool: denyOutsideIsolation(
                  options.canUseTool,
                  expectation,
                  (name) => {
                    blockedTools.push(name);
                  },
                ),
              }
            : {}),
        };
      }
      if (policySetsPaths(request.permissions)) {
        sessionReads = {
          sessionId: undefined,
          configDir: claudeConfigDir(this.buildEnv(request)),
          workingDirectory: request.workingDirectory ?? process.cwd(),
          allowedCalls: new Map(),
        };
        options = {
          ...options,
          hooks: withPathGuardHook(
            options.hooks,
            request.permissions,
            request.workingDirectory,
            built.bridgeTools,
            sessionReads,
          ),
          ...(options.canUseTool
            ? {
                canUseTool: allowSessionToolResultsRead(
                  options.canUseTool,
                  sessionReads,
                ),
              }
            : {}),
        };
      }
      if (!expectation && isolation.denyForeignMcpTools) {
        // inheritHostConfig under read-only or with the network off: host
        // settings may pre-approve an MCP tool, which then skips canUseTool.
        // The hook denies it anyway.
        options = {
          ...options,
          hooks: withForeignMcpDenyHook(options.hooks, built.bridgeTools, {
            policy: request.permissions,
            declared,
          }),
        };
      }
      abortController = options.abortController;
      if (spillSessionId !== undefined) {
        spill = this.reserveSpillPath(request, options, spillSessionId);
        const reservation = spill;
        options = {
          ...options,
          sessionId: spillSessionId,
          // First on every call, so a removed or replaced reservation is
          // caught before the call that could spill (see the report on
          // parallel batches in docs/external-agent-isolation.md).
          hooks: withPreToolUseGuard(options.hooks, {
            deny: (_name, _toolInput, hookInput) => {
              if (!reservation.matches(hookInput)) {
                spillMismatch = true;
                return SPILL_SESSION_MISMATCH;
              }
              if (!reservation.stillReserved()) {
                return SPILL_RESERVATION_LOST;
              }
              return undefined;
            },
            unnamedReason: SPILL_SESSION_MISMATCH,
          }),
        };
      }
      // Declared servers: read their secrets (last, after every check), then
      // deliver them over the control channel before the user message.
      let deliver: ((query: ClaudeAgentSdkQuery) => Promise<void>) | undefined;
      if (this.#mcpServers.length > 0) {
        const servers = await this.resolveDeclaredMcpServers(
          stdioForRun,
          abortController?.signal ?? new AbortController().signal,
          scrubber,
          options.env ?? {},
        );
        const bridge = options.mcpServers?.[BRIDGE_MCP_SERVER];
        // `setMcpServers` drops an in-process server missing from its
        // payload, so the bridge's own server goes with it.
        const payload =
          bridge === undefined
            ? servers
            : { ...servers, [BRIDGE_MCP_SERVER]: bridge };
        deliver = (current) =>
          this.deliverMcpServers(current, payload, scrubber);
        options = {
          ...options,
          hooks: withMcpOutputScrubHook(
            options.hooks,
            this.#mcpServers.map((server) => server.name),
            scrubber,
          ),
        };
      }
      runTemp = createClaudeRunTempDir();
      if (runTemp) {
        options = { ...options, env: { ...options.env, ...runTemp.env } };
      }
      let queryReady: ((query: ClaudeAgentSdkQuery) => void) | undefined;
      if (deliver) {
        const gate = deliver;
        const created = new Promise<ClaudeAgentSdkQuery>((resolveQuery) => {
          queryReady = resolveQuery;
        });
        const controller = abortController;
        prompt = gatedPrompt(prompt, async () => {
          try {
            await gate(await created);
            return true;
          } catch (error) {
            transportError =
              error instanceof Error ? error : new Error(String(error));
            controller?.abort();
            return false;
          }
        });
      }
      query = sdk.query({ prompt, options });
      if (deliver && typeof query.setMcpServers !== "function") {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_DEPENDENCY_MISSING,
          "The installed @anthropic-ai/claude-agent-sdk has no Query.setMcpServers, which mcpServers needs. Update the SDK.",
        );
      }
      queryReady?.(query);
      const iterator = query[Symbol.asyncIterator]();
      stream: while (true) {
        let next: IteratorResult<ClaudeAgentSdkMessage>;
        try {
          next = await iterator.next();
        } catch (error) {
          throw transportError ?? error;
        }
        if (transportError) {
          throw transportError;
        }
        if (next.done) {
          // A call held for the runtime's answer that never came stops the
          // run, as a result message without it does.
          toolUseCheck?.finish();
          if (modelLessResults > 0) {
            // Only model-less results: the input was never worked on.
            failed = true;
            if (!startedEmitted) {
              yield startedEvent(initModel);
            }
            yield noTurnEvent(modelLessSession ?? resolvedResume);
          } else if (
            backgroundTasks.pending().length === 0 &&
            !resolveAbortSignal(request)?.aborted
          ) {
            // No result message at all: the run was cut off. (Tasks still
            // running are reported below, under their own error; a caller's
            // abort is not a cut-off.)
            failed = true;
            if (!startedEmitted) {
              yield startedEvent(initModel);
            }
            yield noResultEvent(resolvedResume);
          }
          break;
        }
        const message = next.value;
        if (spill) {
          const reported = initSessionId(message);
          if (
            spillMismatch ||
            (reported !== undefined && reported !== spillSessionId)
          ) {
            throw spillSessionError();
          }
          if (!spill.stillReserved()) {
            throw spillLostError();
          }
        }
        initModel ??= claudeInitModel(message);
        sawTurn ||= isTurnMessage(message);
        for (const name of claudeInitMcpServerNames(message)) {
          if (name !== BRIDGE_MCP_SERVER) mcpEvents.servers.add(name);
        }
        if (sessionReads) {
          // The session the runtime reports, never one the model names.
          sessionReads.sessionId =
            initSessionId(message) ?? sessionReads.sessionId;
        }
        if (!startedEmitted) {
          yield startedEvent(initModel);
        }
        let refusedCalls: readonly string[] = [];
        if (toolUseCheck) {
          // A blocked call means the tool exists: stop before the check
          // can count its error result as a refusal.
          if (blockedTools.length > 0) {
            throw isolationHookViolation(blockedTools);
          }
          offeredTools = claudeInitTools(message) ?? offeredTools;
          refusedCalls = toolUseCheck.check(message, offeredTools);
        }
        this.assertRequiredMcpServersConnected(message);
        backgroundTasks.observe(message);
        if (!sawTurn && isModelLessResult(message)) {
          // Claude Code writes this when display rows arrive while no turn
          // is under way (on a resume, before the new input is queued); the
          // turn that runs the input follows with its own result. Not the
          // end of the run, and not a baseline: it carries the session total.
          modelLessResults++;
          modelLessSession =
            stringValue(asRecord(message).session_id) ?? modelLessSession;
          continue;
        }
        // Capture the SDK session id (system/init or result) so the
        // next turn of this ADK session can resume it.
        if (adkSessionId && !offDisk) {
          const captured = extractSdkSessionId(message);
          if (captured) {
            this.#sdkSessionsFor(request).set(adkSessionId, captured);
            if (
              stateKey &&
              captured !== persisted &&
              !persistedIds.has(captured)
            ) {
              persistedIds.add(captured);
              yield {
                type: "state_delta",
                stateDelta: { [stateKey]: captured },
                timestamp: Date.now(),
              };
            }
          }
        }
        // If the turn produced no streamed assistant text, fall back to
        // the aggregated `result.result` on a successful result message so the
        // run does not complete with silent-empty output.
        if (!emittedOutput && isSuccessResultWithText(message)) {
          const text = stringValue(asRecord(message).result);
          if (text) {
            emittedOutput = true;
            yield { type: "output", content: text, timestamp: Date.now() };
          }
        }
        const events = this.normalizeMessage(
          message,
          toolNames,
          resolvedResume !== undefined,
          mcpEvents,
        );
        for (let event of events) {
          if (
            event.type === "tool_result" &&
            event.callId !== undefined &&
            refusedCalls.includes(event.callId)
          ) {
            warn(
              EXTERNAL_AGENT_TOOL_NOT_OFFERED,
              scrubber.scrub(
                `Claude Agent SDK: the model requested ${JSON.stringify(event.name)} (call ${event.callId}), a tool it was not offered; the runtime refused it and the run goes on.`,
              ),
            );
            event = {
              ...event,
              metadata: {
                ...event.metadata,
                isolation: EXTERNAL_AGENT_TOOL_NOT_OFFERED,
              },
            };
          }
          if (event.type === "completed") {
            toolUseCheck?.finish();
            completed = true;
            if (!event.model && initModel) {
              event = { ...event, model: initModel, modelFromInit: true };
            }
            const pending = backgroundTasks.pending();
            if (event.exitCode === 0 && pending.length > 0) {
              yield backgroundTaskPendingEvent(pending, "Claude Agent SDK");
              event = { ...event, exitCode: 1 };
            }
          }
          if (event.type === "output") {
            emittedOutput = true;
          }
          yield event;
          if (event.type === "completed") {
            // A result message is the terminal protocol event. Do not wait for another iterator
            // read: older SDK/CLI combinations can leave it pending after the child has exited.
            break stream;
          }
        }
      }
    } catch (caught) {
      failed = true;
      // The gated prompt's failure is the cause of whatever the stream did.
      const error = transportError ?? caught;
      if (!startedEmitted) {
        yield startedEvent();
      }
      if (error instanceof SessionStoreUnavailableError) {
        yield {
          type: "error",
          message: error.message,
          code: CLAUDE_SESSION_STORE_UNAVAILABLE,
          recoverable: false,
          timestamp: Date.now(),
        };
      } else if (error instanceof ExternalAgentPolicyError) {
        yield policyErrorEvent(error);
      } else if (error instanceof McpServerUnavailableError) {
        yield {
          type: "error",
          message: error.message,
          code: EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE,
          recoverable: true,
          timestamp: Date.now(),
        };
      } else {
        const { message, missingExecutable } = this.describeError(
          error,
          request,
        );
        // A missing executable is a setup problem: report it under the same
        // non-recoverable code as the CLI drivers and the Codex SDK.
        const classification = missingExecutable
          ? { code: EXTERNAL_AGENT_MISSING_BINARY, recoverable: false }
          : classifyRecoverable({
              message,
              fallbackCode: "CLAUDE_AGENT_SDK_ERROR",
            });
        yield {
          type: "error",
          message,
          code: classification.code,
          recoverable: classification.recoverable,
          timestamp: Date.now(),
        };
      }
    } finally {
      if (query) {
        await this.disposeQuery(query, completed);
      }
      if (abortController) {
        // After the graceful teardown: stop anything the SDK still runs, and
        // drop the listener so a long-lived run signal does not keep it.
        this.#abortDetach.get(abortController)?.();
        abortController.abort();
      }
      // After the subprocess is stopped, so nothing still writes there.
      runTemp?.dispose();
      if (spill) {
        // The end-of-run check, still after the teardown: a folder in the
        // reserved file's place may hold a saved tool result. Scrub it and
        // keep it for the host; release() leaves anything but our file.
        const state = spill.inspect();
        spillEnd = {
          state,
          ...(state === "folder"
            ? { scrubbed: spill.scrubLeftover((text) => scrubber.scrub(text)) }
            : {}),
        };
        spill.release();
      }
    }

    if (!startedEmitted) {
      yield startedEvent();
    }
    if (spill && spillEnd && spillEnd.state !== "reserved") {
      if (spillEnd.state === "folder" || !failed) {
        failed = true;
        yield policyErrorEvent(
          spillEnd.state === "folder"
            ? spillFolderError(spill.path, spillEnd.scrubbed)
            : spillLostError(),
        );
      }
    }
    if (!completed && !failed && backgroundTasks.pending().length > 0) {
      // The stream ended without a result while tasks still ran.
      failed = true;
      yield backgroundTaskPendingEvent(
        backgroundTasks.pending(),
        "Claude Agent SDK",
      );
    }
    if (!completed) {
      yield {
        type: "completed",
        exitCode: failed ? 1 : 0,
        ...(initModel ? { model: initModel } : {}),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * The store for one run: a configured store as is, or the product of a
   * configured factory (built once per request).
   *
   * @throws `SessionStoreUnavailableError` when the factory throws.
   */
  private resolveSessionStore(
    request: ExternalAgentRunRequest,
  ): SessionStore | undefined {
    const configured = this.#sessionStore;
    if (typeof configured !== "function") {
      return configured;
    }
    const cached = this.#resolvedStores.get(request);
    if (cached) {
      return cached;
    }
    let store: SessionStore;
    try {
      store = configured({ context: request.context });
    } catch (error) {
      throw new SessionStoreUnavailableError(error);
    }
    this.#resolvedStores.set(request, store);
    return store;
  }

  /**
   * SDK `query()` options for a request, without the bridge MCP server (see
   * {@link ClaudeAgentSdkDriver.buildOptionsForRun}). Undefined keys are
   * removed.
   *
   * @param request - The run request.
   * @param resume - SDK session id to resume; defaults to the configured
   * `resumeSessionId`.
   * @returns The options object.
   */
  buildOptions(
    request: ExternalAgentRunRequest,
    resume: string | undefined = this.#resumeSessionId,
  ): ClaudeAgentSdkOptions {
    const permission = mapPolicyToClaudeSdkPermission(request.permissions);
    const options: ClaudeAgentSdkOptions = {
      cwd: request.workingDirectory,
      // The pin joins the environment after the refusal checked it.
      env: withModelPins(this.buildEnv(request), this.#smallFastModel),
      abortController: this.buildAbortController(request),
      permissionMode: permission.permissionMode,
      additionalDirectories: request.permissions?.allowedPaths
        ? [...request.permissions.allowedPaths]
        : undefined,
      pathToClaudeCodeExecutable: this.resolveClaudeExecutable(request).path,
      settingSources: this.#settingSources,
      maxTurns: this.#maxTurns,
      model: this.#model,
      systemPrompt: this.buildSystemPrompt(request),
      allowDangerouslySkipPermissions:
        permission.allowDangerouslySkipPermissions,
      resume,
      forkSession: this.#forkSession,
      // A declared secret keeps the transcript off disk.
      persistSession: hasMcpSecrets(this.#mcpServers) ? false : undefined,
      sessionStore: this.resolveSessionStore(request),
      sessionStoreFlush: this.#sessionStoreFlush,
      loadTimeoutMs: this.#sessionStoreLoadTimeoutMs,
      canUseTool: this.buildCanUseTool(request),
      ...this.buildToolIsolation(request),
    };

    return removeUndefined(options) as ClaudeAgentSdkOptions;
  }

  /**
   * What the agent can reach; see `planClaudeIsolation`.
   * Isolated mode passes an explicit tool list, `strictMcpConfig` (only the
   * bridge's own MCP server), no skills, and turns claude.ai connectors off.
   * Without `allowNetwork: true` Bash runs in the no-network sandbox.
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

  private buildToolIsolation(
    request: ExternalAgentRunRequest,
  ): Partial<ClaudeAgentSdkOptions> {
    const plan = this.isolationPlan(request);
    const sandbox = plan.sandbox
      ? (structuredClone(plan.sandbox) as Record<string, unknown>)
      : undefined;
    // Read-only web tools with the network on run without a prompt. With a
    // permission callback the host's guard allows them (an `allowedTools`
    // entry next to `canUseTool` would make the SDK warn); without one, a
    // rule does.
    const allowedTools = request.requestPermission
      ? undefined
      : plan.readOnlyWebTools;
    if (!plan.isolated) {
      return {
        tools: plan.tools,
        disallowedTools: plan.disallowedTools,
        allowedTools,
        sandbox,
      };
    }
    return {
      tools: plan.tools,
      disallowedTools: plan.disallowedTools,
      allowedTools,
      strictMcpConfig: true,
      skills: [],
      managedSettings: { disableClaudeAiConnectors: true },
      // Flag settings (`--settings`), the highest user-controlled layer:
      // without it Claude Code tells the agent to read and write the host's
      // auto-memory directory, outside the run's isolation.
      settings: { autoMemoryEnabled: false },
      sandbox,
    };
  }

  /**
   * Routes the SDK's permission prompts to the host (`requestPermission`). The
   * host decides within the effective policy: it never grants more than the
   * policy allows and always denies under `read-only`. Never returns
   * `updatedInput` other than the original input, so an approval cannot rewrite
   * the call. A read inside `readPaths` (see `readPathsReadAllowed`) is
   * approved here without asking the host. Absent when the host handles no
   * prompts and the policy sets no `readPaths` (the SDK then denies them).
   */
  private buildCanUseTool(
    request: ExternalAgentRunRequest,
  ): ClaudeAgentSdkCanUseTool | undefined {
    const requestPermission = request.requestPermission;
    const policy = request.permissions;
    // Reads inside `readPaths` reach the callback because those roots are not
    // `additionalDirectories`; the driver answers them itself, in every mode.
    const readsInReadPaths = (
      toolName: string,
      input: Record<string, unknown>,
      blockedPath: string | undefined,
    ) =>
      readPathsReadAllowed(
        policy,
        { toolName, input, ...(blockedPath ? { blockedPath } : {}) },
        request.workingDirectory
          ? { workingDirectory: request.workingDirectory }
          : {},
      );
    if (!requestPermission) {
      if (!policy?.readPaths) {
        return undefined;
      }
      // No host answers prompts: approve the reads inside `readPaths` and
      // deny the rest, as the SDK does without a callback.
      return async (toolName, input, options) =>
        readsInReadPaths(toolName, input, options.blockedPath)
          ? { behavior: "allow", updatedInput: input }
          : {
              behavior: "deny",
              message:
                "Denied: this call needs an approval and no host answers permission prompts.",
            };
    }
    // Tell the guard whether shell commands are kept off the network.
    const { networkSandbox } = this.isolationPlan(request);
    return async (toolName, input, options) => {
      if (readsInReadPaths(toolName, input, options.blockedPath)) {
        return { behavior: "allow", updatedInput: input };
      }
      try {
        const decision = await requestPermission({
          requestId: options.toolUseID ?? `claude-${crypto.randomUUID()}`,
          toolName,
          input,
          ...(options.title ? { title: options.title } : {}),
          ...(options.description ? { description: options.description } : {}),
          ...(options.decisionReason ? { reason: options.decisionReason } : {}),
          ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
          ...(networkSandbox ? { networkSandbox } : {}),
        });
        return decision.behavior === "allow"
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.message };
      } catch {
        return { behavior: "deny", message: "Permission request failed." };
      }
    };
  }

  /**
   * Resolve the system prompt. A configured plain-string
   * `systemPrompt` replaces the `claude_code` preset (with the run instruction
   * appended); otherwise the preset+append default is kept.
   */
  private buildSystemPrompt(
    request: ExternalAgentRunRequest,
  ): ClaudeAgentSdkOptions["systemPrompt"] {
    if (this.#systemPrompt) {
      return request.instruction
        ? `${this.#systemPrompt}\n\n${request.instruction}`
        : this.#systemPrompt;
    }
    return request.instruction
      ? { type: "preset", preset: "claude_code", append: request.instruction }
      : { type: "preset", preset: "claude_code" };
  }

  /**
   * Build the SDK `prompt` input from a run request. Returns either a plain
   * string (single-shot mode) or an `AsyncIterable<SDKUserMessage>` carrying a
   * SINGLE user message (multimodal or resumed turn).
   *
   * MCP-SAFE: this NEVER emits more than one streaming-input message. Emitting
   * several (a synthetic transcript) makes the SDK run multiple
   * turns inside one `query()`, and the in-process MCP server (`adk_bridge`) is
   * torn down after the first turn's `result`, so a subagent tool call in a
   * later turn fails with "Stream closed" before the handler runs. Prior history
   * is restored by the SDK from its own transcript via `options.resume`
   * — for a non-resumed turn it is folded into the single user prompt
   * as text — never replayed as assistant/tool turns through the input stream.
   *
   * @param request - The run request.
   * @param resume - SDK session id being resumed, if any; defaults to the
   * configured `resumeSessionId`.
   * @returns A string, or an iterable with one user message.
   */
  buildPromptInput(
    request: ExternalAgentRunRequest,
    resume: string | undefined = this.#resumeSessionId,
  ): string | AsyncIterable<SDKUserMessage> {
    const contents = safeCollectContents(request.context);

    if (contents.length === 0) {
      return contextText(request.context) ?? "";
    }

    // Send only the newest user turn. Prefer the last non-model content so a
    // trailing model/tool turn never becomes the (user-rendered) prompt.
    const lastUser =
      [...contents].reverse().find((content) => content.role !== "model") ??
      contents[contents.length - 1];

    if (resume) {
      // Resuming: the SDK reloads prior turns from its transcript; send only the
      // newest user turn as a single streaming-input message.
      return asyncIterable(contentsToSdkMessages([lastUser]));
    }

    // First turn (no resume). Text-only -> a plain string (single-shot mode),
    // which keeps the in-process MCP server alive for the whole tool round-trip
    // and folds any pre-existing history into the prompt as text. Multimodal ->
    // a single message carrying the newest turn's lossless blocks.
    const onlyTextParts = (lastUser.parts ?? []).every(
      (part) => typeof part.text === "string" && !part.thought,
    );
    if (onlyTextParts) {
      return buildPrompt(request);
    }

    const messages = contentsToSdkMessages([lastUser]);
    if (messages.length === 0) {
      return buildPrompt(request);
    }
    return asyncIterable(messages);
  }

  /**
   * Finds the Claude Code executable.
   *
   * @remarks
   * Order: the configured `pathToClaudeCodeExecutable`, the
   * `CLAUDE_CODE_EXECUTABLE` and `CLAUDE_CODE_PATH` variables (driver
   * environment, then the run's credential), then the first existing candidate
   * under `PATH`, the home directory, `executableSearchPaths` and the
   * `node_modules` of the host process directory and of this package's
   * install.
   *
   * Security invariant: no candidate at or under a directory the agent may
   * write is searched: the run's working directory (the process directory
   * when it is unset) and its `allowedPaths`, symlinks resolved. The
   * explicit paths above are used as given. When nothing is found the SDK
   * looks for its own bundled binary next to its install; if that install
   * is inside the workspace, the agent can change it (see the isolation
   * guide), unless `strictBinaryResolution` refuses the run.
   *
   * @param request - The run request, for its credential, working directory
   * and permissions.
   * @returns The path, if any, and every candidate that was checked.
   */
  resolveClaudeExecutable(
    request: ExternalAgentRunRequest,
  ): ClaudeExecutableResolution {
    return findExecutable(
      [
        this.#pathToClaudeCodeExecutable,
        this.#env.CLAUDE_CODE_EXECUTABLE,
        this.#env.CLAUDE_CODE_PATH,
        readCredentialEnv(request, "CLAUDE_CODE_EXECUTABLE"),
        readCredentialEnv(request, "CLAUDE_CODE_PATH"),
      ],
      () =>
        claudeExecutableCandidates({
          env: this.#env,
          executableSearchPaths: this.#executableSearchPaths,
          excluded: agentWritableRoots(request),
        }),
    );
  }

  /**
   * The `strictBinaryResolution` refusal for a run, if any.
   *
   * @param request - The run, for its working directory and permissions.
   * @returns `MISSING_BINARY` when the option is on, no executable was found
   * and the SDK's bundled-binary fallback could load from a directory the
   * agent can write; otherwise `undefined`.
   */
  private strictBinaryRefusal(
    request: ExternalAgentRunRequest,
  ): ExternalAgentPolicyError | undefined {
    if (
      !this.#strictBinaryResolution ||
      this.resolveClaudeExecutable(request).path !== undefined
    ) {
      return undefined;
    }
    return strictBinaryRefusal(
      CLAUDE_STRICT_BINARY_CHECK,
      agentWritableRoots(request),
    );
  }

  /**
   * Environment of the `claude` subprocess: only `PATH`, `HOME`, `USER`,
   * `SHELL` (with a fallback shell), the Claude config directories and the
   * client-app marker, plus the credential variables the provider allowlists
   * when the credential is an `env` one, and
   * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` unless `allowBackgroundTasks`.
   * Nothing else is inherited. {@link ClaudeAgentSdkDriver.run} adds the
   * run's private temp directory (`CLAUDE_CODE_TMPDIR`, `TMPDIR`).
   *
   * @param request - The run request.
   * @returns The environment to pass to the SDK.
   */
  buildEnv(
    request: ExternalAgentRunRequest,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};

    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");
    if (!env.SHELL && process.platform !== "win32") {
      env.SHELL = [
        "/bin/bash",
        "/usr/bin/bash",
        "/bin/zsh",
        "/usr/bin/zsh",
      ].find(existsSync);
    }
    copyIfPresent(this.#env, env, "CLAUDE_CONFIG_DIR");
    copyIfPresent(this.#env, env, "XDG_CONFIG_HOME");
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "adk-llm-bridge";

    Object.assign(env, credentialEnv(request));
    applyBackgroundTaskSetting(env, this.#allowBackgroundTasks);
    if (hasMcpSecrets(this.#mcpServers)) {
      // An MCP result too large to inline stays inline (truncated) instead of
      // going to a file under the session folder; see claude-spill-guard.ts.
      env.ENABLE_MCP_LARGE_OUTPUT_FILES = "0";
    }
    return env;
  }

  /**
   * Run-time checks of the declared MCP servers, in order: network (an http
   * or sse server off loopback needs `allowNetwork: true`), stdio command,
   * arguments and env names, then whether the run can keep their secrets
   * from the agent. Reads no secret.
   *
   * @returns The real command and arguments of each stdio server, by name.
   */
  private checkMcpServersForRun(
    request: ExternalAgentRunRequest,
  ): Map<string, { command: string; args: string[] }> {
    const stdio = new Map<string, { command: string; args: string[] }>();
    if (this.#mcpServers.length === 0) return stdio;
    checkMcpServerNetwork(this.#mcpServers, request.permissions);
    const roots = [
      ...agentWritableRoots(request),
      ...sandboxTempRoots(this.#env),
      ...worldWritableTempRoots(),
    ];
    for (const server of this.#mcpServers) {
      if (server.type !== "stdio") continue;
      stdio.set(
        server.name,
        checkStdioServerForRun(
          {
            name: server.name,
            command: server.command,
            ...(server.args ? { args: server.args } : {}),
            envNames: Object.keys(server.env ?? {}),
          },
          roots,
        ),
      );
    }
    const plan = this.isolationPlan(request);
    checkMcpSecretsEnforceable(this.#mcpServers, {
      platform: mcpSecretHost.platform(),
      shellOffered: plan.shellOffered,
      // Only the no-network sandbox profile was measured to hide process
      // environments (macOS); a confined profile built on it keeps it.
      shellSandboxed: plan.networkSandbox === "enforced",
      fileReadOffered: plan.fileReadOffered,
      policy: request.permissions,
      workingDirectory: request.workingDirectory ?? process.cwd(),
      readPtraceScope: mcpSecretHost.readPtraceScope,
      childEnv: this.buildEnv(request),
    });
    return stdio;
  }

  /**
   * Reads the declared servers' secrets and builds their runtime configs.
   * Every config gets `alwaysLoad: true`: an isolated run offers no tool
   * search, so a deferred MCP tool could not be reached.
   */
  /**
   * Reserves the run's session path so Claude Code cannot save a large tool
   * result, which may echo a secret, to disk (see `claude-spill-guard.ts`).
   *
   * @throws ExternalAgentPolicyError `EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE`
   * when the config dir is unknown or the path cannot be reserved.
   */
  private reserveSpillPath(
    request: ExternalAgentRunRequest,
    options: ClaudeAgentSdkOptions,
    sessionId: string,
  ): ClaudeSpillReservation {
    const configDir = claudeConfigDir(options.env ?? {});
    const refuse = (reason: string) =>
      new ExternalAgentPolicyError(
        EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
        `ClaudeAgentSdkDriver: ${reason}. Claude Code saves a large tool result to a file under the session folder, and a server that echoes its secret would leave it there; the run cannot hold an MCP server with a { resolve } or { env } secret without blocking that folder. Set CLAUDE_CONFIG_DIR or HOME to an absolute path and use a working directory with a shorter path.`,
      );
    if (configDir === undefined) {
      throw refuse("the Claude config dir is not an absolute path");
    }
    try {
      return reserveClaudeSpillPath({
        configDir,
        workingDirectory: request.workingDirectory ?? process.cwd(),
        sessionId,
      });
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error));
    }
  }

  private async resolveDeclaredMcpServers(
    stdio: Map<string, { command: string; args: string[] }>,
    signal: AbortSignal,
    scrubber: SecretScrubber,
    childEnv: Readonly<Record<string, string | undefined>> = {},
  ): Promise<Record<string, Record<string, unknown>>> {
    const resolved = await resolveMcpSecrets(this.#mcpServers, {
      env: this.#env,
      childEnv,
      signal,
      scrubber,
    });
    const byName = new Map(resolved.map((server) => [server.name, server]));
    const out: Record<string, Record<string, unknown>> = {};
    for (const server of this.#mcpServers) {
      const values = byName.get(server.name);
      if (server.type === "stdio") {
        const real = stdio.get(server.name);
        out[server.name] = removeUndefined({
          type: "stdio",
          command: real?.command,
          args: real?.args,
          env: values?.env,
          timeout: server.timeoutMs,
          alwaysLoad: true,
        });
      } else {
        out[server.name] = removeUndefined({
          type: server.type,
          url: server.url,
          headers: values?.headers,
          timeout: server.timeoutMs,
          alwaysLoad: true,
        });
      }
    }
    return out;
  }

  /**
   * Delivers the declared servers through `setMcpServers`, then waits for
   * the required ones to connect, polling `mcpServerStatus` every 250 ms up
   * to `mcpConnectTimeoutMs`.
   *
   * @throws McpServerUnavailableError for a required server that reported an
   * error or did not connect in time.
   */
  private async deliverMcpServers(
    query: ClaudeAgentSdkQuery,
    payload: Record<string, unknown>,
    scrubber: SecretScrubber,
  ): Promise<void> {
    if (typeof query.setMcpServers !== "function") {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_DEPENDENCY_MISSING,
        "The installed @anthropic-ai/claude-agent-sdk has no Query.setMcpServers, which mcpServers needs. Update the SDK.",
      );
    }
    const declared = new Set(this.#mcpServers.map((server) => server.name));
    const required = this.#requiredMcpServers.filter((name) =>
      declared.has(name),
    );
    const result = await query.setMcpServers(payload);
    for (const [name, error] of Object.entries(result?.errors ?? {})) {
      if (!declared.has(name)) continue;
      const text = scrubber.scrub(String(error)).slice(0, 500);
      if (required.includes(name)) {
        throw new McpServerUnavailableError(
          `Required MCP server ${name} could not be added: ${text}`,
        );
      }
      warn(
        EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE,
        `Claude Agent SDK: MCP server ${name} could not be added: ${text}`,
      );
    }
    if (required.length === 0) return;
    const deadline = Date.now() + this.#mcpConnectTimeoutMs;
    for (;;) {
      const statuses = new Map<string, { status?: string; error?: string }>();
      for (const item of (await query.mcpServerStatus?.()) ?? []) {
        const name = stringValue(item.name);
        if (name !== undefined) {
          statuses.set(name, {
            status: stringValue(item.status),
            error: stringValue(item.error),
          });
        }
      }
      const pending: string[] = [];
      for (const name of required) {
        const entry = statuses.get(name);
        if (entry?.status === "connected") continue;
        if (
          entry?.status === "failed" ||
          entry?.status === "needs-auth" ||
          entry?.status === "disabled"
        ) {
          const detail = entry.error
            ? `: ${scrubber.scrub(entry.error).slice(0, 500)}`
            : "";
          throw new McpServerUnavailableError(
            `Required MCP server ${name} is ${entry.status}${detail}`,
          );
        }
        pending.push(name);
      }
      if (pending.length === 0) return;
      if (Date.now() >= deadline) {
        throw new McpServerUnavailableError(
          `Required MCP server ${pending.join(", ")} did not connect within ${this.#mcpConnectTimeoutMs} ms (mcpConnectTimeoutMs).`,
        );
      }
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, MCP_STATUS_POLL_MS),
      );
    }
  }

  private assertRequiredMcpServersConnected(
    message: ClaudeAgentSdkMessage,
  ): void {
    if (this.#requiredMcpServers.length === 0) return;

    const record = asRecord(message);
    if (record.type !== "system" || record.subtype !== "init") return;

    const statuses = new Map<string, string>();
    if (Array.isArray(record.mcp_servers)) {
      for (const item of record.mcp_servers) {
        const server = asRecord(item);
        const name = stringValue(server.name);
        const status = stringValue(server.status);
        if (name && status) statuses.set(name, status);
      }
    }

    const unavailable = this.#requiredMcpServers.flatMap((name) => {
      const status = statuses.get(name);
      return status === "connected" ? [] : [`${name}:${status ?? "missing"}`];
    });
    if (unavailable.length > 0) {
      throw new Error(
        `Required Claude MCP server unavailable (${unavailable.join(", ")})`,
      );
    }
  }

  /**
   * Build the `AbortController` wired into `options.abortController`.
   * The SDK aborts the spawned `claude` subprocess and releases resources when
   * this controller fires. We bridge the shared run cancellation signal
   * (`request.abortSignal` ?? `context.abortSignal`) onto a fresh controller so
   * the driver also owns a handle it can abort from its own `finally` cleanup.
   * `run` removes the listener on the run signal and aborts the controller
   * when the run ends.
   */
  private buildAbortController(
    request: ExternalAgentRunRequest,
  ): AbortController {
    const controller = new AbortController();
    const signal = resolveAbortSignal(request);
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        this.#abortDetach.set(controller, () =>
          signal.removeEventListener("abort", onAbort),
        );
      }
    }
    return controller;
  }

  /**
   * Tear down a Query. When the loop ends early (break/throw)
   * the turn is still in flight, so `interrupt()` is requested first to stop
   * the spawned subprocess gracefully; `return()` then finalizes the
   * generator. Both are best-effort — disposal must never mask the original
   * outcome, so all errors here are swallowed.
   */
  private async disposeQuery(
    query: ClaudeAgentSdkQuery,
    completed: boolean,
  ): Promise<void> {
    if (!completed && typeof query.interrupt === "function") {
      try {
        await query.interrupt();
      } catch {
        // best-effort: subprocess may already be gone
      }
    }
    if (typeof query.return === "function") {
      try {
        await query.return(undefined);
      } catch {
        // best-effort: generator may already be finalized
      }
    }
  }

  /**
   * Maps one SDK message to bridge events. Pass the same `toolNames` map for
   * every message of a run so a `tool_result` gets the name of its
   * `tool_use`; without it results of earlier messages are not named.
   *
   * @remarks
   * Errors are classified with `classifyRecoverable`; a permission denial is
   * never recoverable, because retrying does not make it allowed.
   *
   * @param message - One SDK message.
   * @param toolNames - Map of `tool_use` id to tool name, shared across the run;
   * a new empty map by default.
   * @param resumed - Whether the run resumed or forked an existing SDK
   * session; without a baseline its usage is then the session total, marked
   * `scope: "session"`.
   * @param mcp - Known MCP server names and call start times, for the
   * `metadata.mcp` and `durationMs` of MCP tool events.
   * @returns Zero or more events.
   */
  normalizeMessage(
    message: ClaudeAgentSdkMessage,
    toolNames: Map<string, string> = new Map(),
    resumed = false,
    mcp?: ToolEventMcpContext,
  ): ExternalAgentEvent[] {
    const record = asRecord(message);
    const type = stringValue(record.type);

    if (type === "assistant") {
      const error = claudeAssistantErrorEvent(record, "CLAUDE_AGENT_SDK_ERROR");
      if (error) {
        return [error];
      }

      const content = asRecord(record.message).content;
      const text = extractText(
        Array.isArray(content)
          ? content.filter((block) => asRecord(block).type !== "tool_use")
          : content,
      );
      return [
        ...(text
          ? [{ type: "output" as const, content: text, timestamp: Date.now() }]
          : []),
        ...toolUseEvents(content, toolNames, record.parent_tool_use_id, mcp),
      ];
    }

    if (type === "user") {
      return toolResultEvents(
        asRecord(record.message).content,
        toolNames,
        record.parent_tool_use_id,
        mcp,
      );
    }

    if (type === "result") {
      const sdkSession = stringValue(record.session_id);
      const summary = claudeResultSummary(
        record,
        sdkSession ? this.#lastResultBySdkSession.get(sdkSession) : undefined,
        resumed,
      );
      if (sdkSession) {
        this.#lastResultBySdkSession.delete(sdkSession);
        this.#lastResultBySdkSession.set(
          sdkSession,
          claudeResultBaseline(record),
        );
        if (this.#lastResultBySdkSession.size > MAX_USAGE_BASELINES) {
          const oldest = this.#lastResultBySdkSession.keys().next();
          if (!oldest.done) this.#lastResultBySdkSession.delete(oldest.value);
        }
      }
      if (record.subtype === "success") {
        return [
          {
            type: "completed" as const,
            exitCode: 0,
            ...summary,
            timestamp: Date.now(),
          },
        ];
      }

      const errors = Array.isArray(record.errors)
        ? record.errors.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const subtype = stringValue(record.subtype);
      const message =
        errors.join("\n") ||
        `Claude Agent SDK result: ${String(record.subtype ?? "error")}`;
      // SDKResultError subtype (error_max_turns/error_max_budget_usd/
      // error_max_structured_output_retries/error_during_execution).
      const classification = classifyRecoverable({
        subtype,
        message,
        fallbackCode: "CLAUDE_AGENT_SDK_RESULT_ERROR",
      });
      return [
        {
          type: "error",
          message,
          code: classification.code,
          recoverable: classification.recoverable,
          timestamp: Date.now(),
        },
        { type: "completed", exitCode: 1, ...summary, timestamp: Date.now() },
      ];
    }

    if (type === "auth_status") {
      const error = stringValue(record.error);
      if (!error) {
        return [];
      }
      // An auth status error is always an authentication failure.
      const classification = classifyRecoverable({
        subtype: "AUTH_ERROR",
        message: error,
      });
      return [
        {
          type: "error",
          message: error,
          code: classification.code,
          recoverable: classification.recoverable,
          timestamp: Date.now(),
        },
      ];
    }

    if (type === "system" && record.subtype === "permission_denied") {
      // Keep the base SDK rejection message, enriched
      // with tool_name / decision_reason when present. Permission denials do
      // not become allowed by retrying, so they are non-recoverable.
      const base = stringValue(record.message) ?? "Claude permission denied";
      const toolName = stringValue(record.tool_name);
      const decisionReason =
        stringValue(record.decision_reason) ??
        stringValue(record.decision_reason_type);
      const details = [
        toolName ? `tool: ${toolName}` : undefined,
        decisionReason ? `reason: ${decisionReason}` : undefined,
      ].filter((part): part is string => part !== undefined);
      const message =
        details.length > 0 ? `${base} (${details.join(", ")})` : base;
      return [
        {
          type: "error",
          message,
          code: "CLAUDE_PERMISSION_DENIED",
          recoverable: false,
          timestamp: Date.now(),
        },
      ];
    }

    if (type === "system" && record.subtype === "mirror_error") {
      // The local transcript is intact; only the store copy lost a batch, so
      // the run goes on and a retry of the run can succeed.
      const detail = stringValue(record.error) ?? "unknown error";
      return [
        {
          type: "error",
          message: `Claude session store dropped a transcript batch after its retries: ${detail}`,
          code: CLAUDE_SESSION_STORE_MIRROR_ERROR,
          recoverable: true,
          timestamp: Date.now(),
        },
      ];
    }

    if (this.#debugEvents) {
      return [
        {
          type: "output",
          content: JSON.stringify(message),
          timestamp: Date.now(),
        },
      ];
    }

    return [];
  }

  /**
   * {@link ClaudeAgentSdkDriver.buildOptions}, plus the bridge's in-process MCP
   * server (`adk_bridge`) when the request exposes sub-agents or ADK tools.
   *
   * @remarks
   * The bridge's own tools are pre-approved because the bridge enforces their
   * confirmation and the read-only exposure filter before the call reaches the
   * tool. Every other tool still goes to the host.
   *
   * @param request - The run request.
   * @param sdk - The loaded SDK, used to create the MCP server.
   * @param resume - SDK session id to resume; defaults to the configured
   * `resumeSessionId`.
   * @returns The options for `query()`.
   * @throws `Error` when the SDK has no MCP support but bridge tools are needed.
   */
  async buildOptionsForRun(
    request: ExternalAgentRunRequest,
    sdk: ClaudeAgentSdkLike,
    resume: string | undefined = this.#resumeSessionId,
  ): Promise<ClaudeAgentSdkOptions> {
    return (await this.buildRunOptions(request, sdk, resume)).options;
  }

  /**
   * {@link buildOptionsForRun}, plus the names of the tools the bridge's own
   * MCP server registered (empty without a bridge server).
   */
  private async buildRunOptions(
    request: ExternalAgentRunRequest,
    sdk: ClaudeAgentSdkLike,
    resume: string | undefined,
  ): Promise<{ options: ClaudeAgentSdkOptions; bridgeTools: string[] }> {
    const options = this.buildOptions(request, resume);
    const exposeSubAgents =
      Boolean(request.toolGateway) && (request.subAgents?.length ?? 0) > 0;
    const adkDeclarations = request.adkTools?.declarations ?? [];
    if (!exposeSubAgents && adkDeclarations.length === 0) {
      return { options, bridgeTools: [] };
    }

    const { server, toolNames } = await this.buildBridgeMcpServer(
      request,
      sdk,
      exposeSubAgents,
    );
    // The bridge's own tools are pre-authorized on purpose: their confirmation
    // (`requireConfirmation`) and the read-only exposure filter are enforced by
    // the bridge before the call reaches the tool.
    const bridgeTools = new Set(
      toolNames.map((name) => `${BRIDGE_TOOL_PREFIX}${name}`),
    );
    const hostCanUseTool = options.canUseTool;
    if (hostCanUseTool) {
      // With a `canUseTool` callback, a bare `allowedTools` entry makes the
      // SDK warn `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` on every run. Approve the
      // bridge tools inside the callback instead; every other tool still goes
      // to the host.
      const canUseTool: ClaudeAgentSdkCanUseTool = (toolName, input, extra) =>
        bridgeTools.has(toolName)
          ? Promise.resolve({ behavior: "allow", updatedInput: input })
          : hostCanUseTool(toolName, input, extra);
      return {
        options: removeUndefined({
          ...options,
          mcpServers: {
            ...(options.mcpServers ?? {}),
            [BRIDGE_MCP_SERVER]: server,
          },
          canUseTool,
        }) as ClaudeAgentSdkOptions,
        bridgeTools: [...bridgeTools],
      };
    }
    return {
      options: removeUndefined({
        ...options,
        mcpServers: {
          ...(options.mcpServers ?? {}),
          [BRIDGE_MCP_SERVER]: server,
        },
        allowedTools: [...(options.allowedTools ?? []), ...bridgeTools],
      }) as ClaudeAgentSdkOptions,
      bridgeTools: [...bridgeTools],
    };
  }

  /** Runs one ADK tool for the runtime, resolving confirmations through the host. */
  private async runAdkTool(
    request: ExternalAgentRunRequest,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ClaudeAgentSdkToolResult> {
    const bridge = request.adkTools;
    if (!bridge) {
      return toolTextResult("ADK tools are not available.", true);
    }
    const functionCallId = `claude-adk-${crypto.randomUUID()}`;
    let result = await bridge.execute(name, args, request.context, {
      functionCallId,
    });
    if (result.status === "confirmationRequired") {
      // Never widen: the host decides within the effective policy and denies
      // when it has no approver.
      const decision = request.requestPermission
        ? await request
            .requestPermission({
              requestId: functionCallId,
              toolName: name,
              input: args,
              title: result.confirmation?.hint,
            })
            .catch(
              () =>
                ({
                  behavior: "deny",
                  message: "Permission request failed.",
                }) as const,
            )
        : ({
            behavior: "deny",
            message: "Denied: no approver is configured for this agent.",
          } as const);
      if (decision.behavior !== "allow") {
        return toolTextResult(
          `The call to ${name} was not approved: ${decision.message}`,
          true,
        );
      }
      result = await bridge.execute(name, args, request.context, {
        functionCallId,
        toolConfirmation: { confirmed: true },
      });
    }
    if (Object.keys(result.actions.stateDelta).length > 0) {
      request.emitStateDelta?.(result.actions.stateDelta);
    }
    return toolTextResult(
      JSON.stringify(result.response),
      result.status !== "ok",
    );
  }

  private async buildBridgeMcpServer(
    request: ExternalAgentRunRequest,
    sdk: ClaudeAgentSdkLike,
    exposeSubAgents: boolean,
  ): Promise<{ server: unknown; toolNames: string[] }> {
    if (!sdk.createSdkMcpServer || !sdk.tool) {
      throw new Error(
        "Claude Agent SDK MCP support is required to expose ADK subagents and tools. Update @anthropic-ai/claude-agent-sdk or run without subAgents/tools.",
      );
    }

    const tools: ClaudeAgentSdkToolDefinition[] = [];
    const toolNames: string[] = [];

    if (exposeSubAgents) {
      const schema = await createRunSubAgentSchema();
      const available =
        request.subAgents?.map((agent) => agent.name).join(", ") ?? "";
      tools.push(
        sdk.tool(
          "run_adk_subagent",
          `Run one of the ADK subagents by name. Available subagents: ${available}`,
          schema,
          async (args) => {
            const agentName = stringValue(args.agentName) ?? "";
            const task = stringValue(args.task) ?? "";
            const result = await request.toolGateway?.runSubAgent({
              agentName,
              task,
            });
            if (!result) {
              return toolTextResult("ADK ToolGateway is not available.", true);
            }
            if (result.error) {
              return toolTextResult(result.error, true);
            }
            return toolTextResult(
              result.output ||
                `Subagent ${result.agentName} completed with ${result.events} events.`,
            );
          },
          { alwaysLoad: true },
        ),
      );
      toolNames.push("run_adk_subagent");
    }

    for (const declaration of request.adkTools?.declarations ?? []) {
      const shape = await jsonSchemaToZodShape(declaration.inputSchema);
      if (!shape) {
        // A schema we cannot translate is skipped rather than exposed untyped.
        continue;
      }
      tools.push(
        sdk.tool(
          declaration.name,
          declaration.description,
          shape,
          (args) => this.runAdkTool(request, declaration.name, args),
          { alwaysLoad: true },
        ),
      );
      toolNames.push(declaration.name);
    }

    return {
      server: sdk.createSdkMcpServer({
        name: BRIDGE_MCP_SERVER,
        version: "0.1.0",
        tools,
        alwaysLoad: true,
      }),
      toolNames,
    };
  }

  private describeError(
    error: unknown,
    request: ExternalAgentRunRequest,
  ): { message: string; missingExecutable: boolean } {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes("Native CLI binary") &&
      !message.includes("pathToClaudeCodeExecutable")
    ) {
      return { message, missingExecutable: false };
    }

    const described = describeMissingExecutable({
      headline: "Claude Agent SDK could not locate a Claude Code executable.",
      hint: "Set CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude or CLAUDE_CODE_PATH=/absolute/path/to/claude, add the executable directory to PATH, pass executableSearchPaths, or reinstall @anthropic-ai/claude-agent-sdk with optional dependencies.",
      original: message,
      checked: this.resolveClaudeExecutable(request).checked,
    });
    return { message: described, missingExecutable: true };
  }

  private async loadSdk(): Promise<ClaudeAgentSdkLike> {
    if (this.#sdk) {
      return this.#sdk;
    }

    try {
      return await this.#importSdk();
    } catch (error) {
      throw Object.assign(
        dependencyMissing(
          "package",
          "The Claude Agent SDK (@anthropic-ai/claude-agent-sdk)",
          "npm install @anthropic-ai/claude-agent-sdk",
          "use driver: new ClaudeCliDriver(...)",
        ),
        { cause: error },
      );
    }
  }
}

/** Why the spill guard denies a call from a session it did not reserve. */
const SPILL_SESSION_MISMATCH =
  "The tool call comes from a session other than the one the bridge reserved; a large result could be saved to disk.";

/** Why the spill guard denies a call once the reserved file is gone. */
const SPILL_RESERVATION_LOST =
  "The session path the bridge reserved was removed or replaced; a large result could be saved to disk.";

/** The run ends when the reserved file is removed or replaced. */
function spillLostError(): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    "ClaudeAgentSdkDriver: the session path the bridge reserved was removed or replaced during the run, so a large tool result, which may echo an MCP secret, could be saved to disk. The run was stopped. Do not let the agent write Claude Code's config dir.",
  );
}

/** Reported at the end of a run when a folder took the reserved file's place. */
function spillFolderError(
  path: string,
  scrubbed: { files: number; rewritten: number } = { files: 0, rewritten: 0 },
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    `ClaudeAgentSdkDriver: a folder took the place of the session path the bridge reserved (${path}), so Claude Code may have saved tool results there. Declared secrets were redacted in ${scrubbed.rewritten} of ${scrubbed.files} files under it; the folder is kept. Inspect and delete it, and do not let the agent write Claude Code's config dir.`,
  );
}

/** The run ends when the runtime does not use the reserved session. */
function spillSessionError(): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_MCP_SECRET_UNENFORCEABLE,
    "ClaudeAgentSdkDriver: the runtime did not use the session the bridge reserved, so a large tool result, which may echo an MCP secret, could be saved to disk. The run was stopped. Use a Claude Code version that honors sessionId.",
  );
}

/** What {@link withPreToolUseGuard} decides for each tool call. */
interface PreToolUseGuard {
  /**
   * The reason to deny a named call, or `undefined` to let it through to the
   * next hook.
   */
  deny: (
    toolName: string,
    toolInput: Record<string, unknown>,
    hookInput: Record<string, unknown>,
    toolUseID: string | undefined,
  ) => string | undefined;
  /** The reason given when a call names no tool. */
  unnamedReason: string;
  /** Called for each denied call, with `""` for one that names no tool. */
  onDenied?: (toolName: string) => void;
}

/** How often the first message polls `mcpServerStatus` for required servers. */
const MCP_STATUS_POLL_MS = 250;

/** Default and bounds of `mcpConnectTimeoutMs`. */
const MCP_CONNECT_TIMEOUT_MS = { default: 10_000, min: 1000, max: 120_000 };

function checkMcpConnectTimeout(value: unknown): number {
  if (value === undefined) return MCP_CONNECT_TIMEOUT_MS.default;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MCP_CONNECT_TIMEOUT_MS.min ||
    value > MCP_CONNECT_TIMEOUT_MS.max
  ) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_MCP_SERVER_INVALID,
      `ClaudeAgentSdkDriver: mcpConnectTimeoutMs must be an integer from ${MCP_CONNECT_TIMEOUT_MS.min} to ${MCP_CONNECT_TIMEOUT_MS.max}.`,
    );
  }
  return value;
}

/**
 * A required declared MCP server did not connect: reported as the
 * recoverable `EXTERNAL_AGENT_MCP_SERVER_UNAVAILABLE` error.
 */
class McpServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerUnavailableError";
  }
}

/**
 * The prompt as a single-message iterable whose first read waits for
 * `ready`: the declared MCP servers are delivered before the user message.
 * When `ready` gives `false` the iterable ends without the message.
 */
/**
 * World-writable temp directories that exist on this host (`/var/tmp`,
 * `/dev/shm`), canonical. A stdio server's command or path arguments there
 * could be replaced by any local user, the agent included.
 */
function worldWritableTempRoots(): string[] {
  return ["/var/tmp", "/dev/shm"]
    .map((path) => canonicalPath(path, "/"))
    .filter((path): path is string => path !== undefined);
}

function gatedPrompt(
  prompt: string | AsyncIterable<unknown>,
  ready: () => Promise<boolean>,
): AsyncIterable<unknown> {
  return (async function* () {
    if (!(await ready())) return;
    if (typeof prompt === "string") {
      const message: SDKUserMessage = {
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      };
      yield message;
      return;
    }
    yield* prompt;
  })();
}

/** What replaces an MCP tool result whose shape the scrubber does not know. */
const MCP_OUTPUT_WITHHELD = "[output withheld: unrecognized shape]";

/**
 * A declared server's tool result with the run's secrets scrubbed. Known
 * shapes: a string, an array of content blocks (objects with a string
 * `type`), or an object with a `content` array.
 *
 * @returns The output to give the model, and whether it differs.
 */
function scrubMcpToolOutput(
  output: unknown,
  scrubber: SecretScrubber,
): { value: unknown; changed: boolean } {
  const isBlocks = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).type === "string",
    );
  const known =
    typeof output === "string" ||
    isBlocks(output) ||
    (typeof output === "object" &&
      output !== null &&
      !Array.isArray(output) &&
      isBlocks((output as Record<string, unknown>).content));
  if (!known) {
    return { value: MCP_OUTPUT_WITHHELD, changed: true };
  }
  return scrubber.scrubDeep(output);
}

/**
 * Adds a `PostToolUse` hook that scrubs the run's secrets from the
 * successful results of declared servers' tools before the model sees them.
 * It returns a rewrite only when the output changed, so it never replaces
 * another hook's rewrite with the same text. An error result does not reach
 * `PostToolUse` and is not rewritten.
 */
function withMcpOutputScrubHook(
  hooks: ClaudeAgentSdkOptions["hooks"],
  servers: readonly string[],
  scrubber: SecretScrubber,
): NonNullable<ClaudeAgentSdkOptions["hooks"]> {
  const prefixes = servers.map((server) => `mcp__${server}__`);
  const matcher: ClaudeAgentSdkHookMatcher = {
    hooks: [
      async (input) => {
        const toolName = stringValue(input.tool_name);
        if (
          toolName === undefined ||
          !prefixes.some((prefix) => toolName.startsWith(prefix))
        ) {
          return {};
        }
        const { value, changed } = scrubMcpToolOutput(
          input.tool_response,
          scrubber,
        );
        if (!changed) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            updatedMCPToolOutput: value,
            updatedToolOutput: value,
          },
        };
      },
    ],
  };
  return {
    ...(hooks ?? {}),
    PostToolUse: [...(hooks?.PostToolUse ?? []), matcher],
  };
}

/** The MCP server names a `system/init` message lists; empty otherwise. */
function claudeInitMcpServerNames(message: unknown): string[] {
  const record = asRecord(message);
  if (record.type !== "system" || record.subtype !== "init") return [];
  if (!Array.isArray(record.mcp_servers)) return [];
  return record.mcp_servers
    .map((server) => stringValue(asRecord(server).name))
    .filter((name): name is string => name !== undefined);
}

/**
 * Puts a `PreToolUse` hook in front of the existing ones.
 *
 * @remarks
 * Security invariant: a call whose `tool_name` is missing or not a
 * non-empty string is denied (fail closed), since it cannot be checked. The
 * SDK calls `canUseTool` only for tools that need permission, so a
 * `PreToolUse` deny is what blocks a call in every permission mode, also a
 * tool in `allowedTools` or one host settings pre-approve. Programmatic hooks
 * are not a setting source, so an isolated run (no host settings) keeps them.
 *
 * @param hooks - The hooks already configured.
 * @param guard - The decision and the reason for a call without a name.
 * @returns The hooks with the guard first under `PreToolUse`.
 */
function withPreToolUseGuard(
  hooks: ClaudeAgentSdkOptions["hooks"],
  guard: PreToolUseGuard,
): NonNullable<ClaudeAgentSdkOptions["hooks"]> {
  const denied = (reason: string) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  const matcher: ClaudeAgentSdkHookMatcher = {
    hooks: [
      async (input, toolUseID) => {
        const toolName = stringValue(input.tool_name);
        if (toolName === undefined) {
          guard.onDenied?.("");
          return denied(guard.unnamedReason);
        }
        const reason = guard.deny(
          toolName,
          asRecord(input.tool_input),
          input,
          toolUseID,
        );
        if (reason === undefined) {
          return {};
        }
        guard.onDenied?.(toolName);
        return denied(reason);
      },
    ],
  };
  return {
    ...(hooks ?? {}),
    PreToolUse: [matcher, ...(hooks?.PreToolUse ?? [])],
  };
}

/**
 * Adds a `PreToolUse` hook that denies every tool outside the isolated set.
 *
 * @remarks Without it, in `bypassPermissions` mode or for a tool already in
 * `allowedTools`, a late connector tool would run.
 */
function withIsolationHook(
  hooks: ClaudeAgentSdkOptions["hooks"],
  expectation: ClaudeIsolationExpectation,
  onBlocked: (toolName: string) => void,
  mcp: DeclaredMcpCallContext,
): NonNullable<ClaudeAgentSdkOptions["hooks"]> {
  return withPreToolUseGuard(hooks, {
    unnamedReason:
      "A tool call with no tool name is outside this agent's isolated tool set.",
    deny: (toolName) =>
      isExpectedClaudeTool(toolName, expectation)
        ? declaredMcpCallDenial(toolName, expectation, mcp)
        : `${toolName} is outside this agent's isolated tool set.`,
    // A declared server's tool it does not list exists by design: the call
    // is denied, the run goes on.
    onDenied: (toolName) => {
      if (!isExpectedClaudeTool(toolName, expectation)) onBlocked(toolName);
    },
  });
}

/** The policy and declared servers a call to a declared MCP tool is checked against. */
interface DeclaredMcpCallContext {
  readonly policy: ExternalAgentPermissionPolicy | undefined;
  readonly declared: readonly ExternalAgentMcpServerGrant[];
}

/**
 * Why a call to a tool of a declared MCP server is denied, or `undefined`:
 * a tool its server does not list, and under `read-only` any tool but a
 * listed one of a `readOnly` server.
 */
function declaredMcpCallDenial(
  toolName: string,
  expectation: ClaudeIsolationExpectation | undefined,
  mcp: DeclaredMcpCallContext,
): string | undefined {
  const declared = declaredMcpTool(toolName, mcp.declared);
  if (declared === undefined) return undefined;
  if (
    !declared.listed ||
    (expectation !== undefined && !isListedClaudeMcpTool(toolName, expectation))
  ) {
    return `${toolName} is not in the tool list of MCP server ${declared.server.name} for this agent.`;
  }
  if (
    mcp.policy?.mode === "read-only" &&
    !readOnlyMcpToolAllowed(mcp.policy, toolName, mcp.declared)
  ) {
    return `${toolName} may write: under a read-only policy only listed tools of a readOnly MCP server run.`;
  }
  return undefined;
}

/**
 * Adds a `PreToolUse` hook that denies every MCP tool except the bridge's own
 * registered tools. Used for runs that inherit the host config under
 * `read-only` or with the network off, where a host `permissions.allow` rule
 * would let a host MCP tool (which may write, or reach the network) run
 * without reaching the permission callback.
 */
function withForeignMcpDenyHook(
  hooks: ClaudeAgentSdkOptions["hooks"],
  bridgeTools: readonly string[] | undefined,
  mcp: DeclaredMcpCallContext,
): NonNullable<ClaudeAgentSdkOptions["hooks"]> {
  const allowed = new Set(bridgeTools ?? []);
  return withPreToolUseGuard(hooks, {
    unnamedReason:
      "A tool call with no tool name cannot be checked, so it may be an MCP tool outside the bridge, which this agent cannot use.",
    deny: (toolName) => {
      if (!toolName.startsWith("mcp__") || allowed.has(toolName)) {
        return undefined;
      }
      if (declaredMcpTool(toolName, mcp.declared) !== undefined) {
        return declaredMcpCallDenial(toolName, undefined, mcp);
      }
      return `${toolName} is an MCP tool outside the bridge and the declared servers; this agent cannot use it (read-only, or the network is off).`;
    },
  });
}

/**
 * Adds a `PreToolUse` hook that denies a tool call whose path arguments leave
 * `allowedPaths` or a `pathBounds` list.
 *
 * @remarks The permission callback sees only the calls Claude Code asks
 * about. Edits inside the working directory or `additionalDirectories` in
 * `acceptEdits` mode, reads there, and every call in `bypassPermissions` mode
 * run without asking, so the guard must run here as well. The bridge's own
 * tools take ADK tool arguments, not runtime paths, and are left to the
 * bridge. A `Read` of the run's own session `tool-results` directory is let
 * through (see {@link SessionToolResultsReads}) and its call id recorded.
 */
function withPathGuardHook(
  hooks: ClaudeAgentSdkOptions["hooks"],
  policy: ExternalAgentPermissionPolicy,
  workingDirectory: string | undefined,
  bridgeTools: readonly string[] | undefined,
  sessionReads: SessionToolResultsReads,
): NonNullable<ClaudeAgentSdkOptions["hooks"]> {
  const bridged = new Set(bridgeTools ?? []);
  return withPreToolUseGuard(hooks, {
    unnamedReason: "Denied: tool call without a name.",
    deny: (toolName, toolInput, hookInput, toolUseID) => {
      if (bridged.has(toolName)) {
        return undefined;
      }
      const toolResultsDir = claudeSessionToolResultsDir({
        sessionId: sessionReads.sessionId,
        hookSessionId: hookInput.session_id,
        transcriptPath: hookInput.transcript_path,
        configDir: sessionReads.configDir,
      });
      if (
        isSessionToolResultsRead(
          toolResultsDir,
          toolName,
          toolInput,
          sessionReads.workingDirectory,
        )
      ) {
        if (toolUseID !== undefined && toolResultsDir !== undefined) {
          sessionReads.allowedCalls.set(toolUseID, toolResultsDir);
        }
        return undefined;
      }
      const denial = guardRequestPaths(
        policy,
        { toolName, input: toolInput },
        workingDirectory ? { workingDirectory } : {},
      );
      return denial?.behavior === "deny" ? denial.message : undefined;
    },
  });
}

/**
 * Per-run state of the one read allowed outside `allowedPaths`: `Read` of a
 * file in the `tool-results` directory of the session this run started.
 */
interface SessionToolResultsReads {
  /** The session id from the runtime's latest `system/init`. */
  sessionId: string | undefined;
  /** The runtime's configuration directory, from the child environment. */
  readonly configDir: string | undefined;
  /** Base for a relative `file_path`. */
  readonly workingDirectory: string;
  /**
   * For each `Read` the `PreToolUse` hook allowed: its tool-use id and the
   * directory, so the permission callback answers only those calls.
   */
  readonly allowedCalls: Map<string, string>;
}

/**
 * Wraps the permission callback so a `Read` that the path hook allowed as a
 * session tool-results read (same tool-use id, same directory, every path in
 * it) is allowed without asking the host; every other call goes on to
 * `canUseTool`.
 *
 * @remarks Claude Code may ask about a read outside its working directory.
 * The host's policy guard would deny that path as outside `allowedPaths`,
 * so the driver answers it here, only for a call the hook already checked
 * against the runtime's session.
 */
function allowSessionToolResultsRead(
  canUseTool: ClaudeAgentSdkCanUseTool,
  sessionReads: SessionToolResultsReads,
): ClaudeAgentSdkCanUseTool {
  return (toolName, input, extra) => {
    const toolUseID = extra.toolUseID;
    const toolResultsDir =
      toolUseID === undefined
        ? undefined
        : sessionReads.allowedCalls.get(toolUseID);
    if (
      toolUseID !== undefined &&
      isSessionToolResultsRead(
        toolResultsDir,
        toolName,
        input,
        sessionReads.workingDirectory,
      ) &&
      (extra.blockedPath === undefined ||
        isSessionToolResultsRead(
          toolResultsDir,
          toolName,
          { file_path: extra.blockedPath },
          sessionReads.workingDirectory,
        ))
    ) {
      sessionReads.allowedCalls.delete(toolUseID);
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    return canUseTool(toolName, input, extra);
  };
}

function isolationHookViolation(
  tools: readonly string[],
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_ISOLATION_VIOLATED,
    `Claude Agent SDK tried to use ${[...new Set(tools)].map((tool) => JSON.stringify(tool)).join(", ")}, outside the isolated set; the call was blocked and the run was stopped. A host or managed setting may be adding tools after start. Pass inheritHostConfig: true to allow the host configuration.`,
  );
}

/**
 * Wraps the permission callback so an isolated run denies a tool outside the
 * isolated set before it runs, whatever the host would decide. The stream
 * check then stops the run.
 */
function denyOutsideIsolation(
  canUseTool: ClaudeAgentSdkCanUseTool,
  expectation: ClaudeIsolationExpectation,
  onDenied: (toolName: string) => void,
): ClaudeAgentSdkCanUseTool {
  return (toolName, input, extra) => {
    if (isExpectedClaudeTool(toolName, expectation)) {
      if (!isListedClaudeMcpTool(toolName, expectation)) {
        return Promise.resolve({
          behavior: "deny",
          message: `${toolName} is not in its MCP server's tool list for this agent.`,
        });
      }
      return canUseTool(toolName, input, extra);
    }
    onDenied(toolName);
    return Promise.resolve({
      behavior: "deny",
      message: `${toolName} is outside this agent's isolated tool set.`,
    });
  };
}

/**
 * Session-state key under which the Claude SDK session id of an agent is kept.
 *
 * @param agentName - Name of the agent.
 * @returns The state key for that agent.
 *
 * Trust model: it lives in ordinary session state, which tools can write, so
 * a tool can point the next resume at another SDK session the same Claude
 * installation can read. Do not run untrusted tools in a session whose SDK
 * transcripts must stay isolated.
 */
export function claudeSdkSessionStateKey(agentName: string): string {
  return `claude_sdk_session:${agentName}`;
}

function readStateString(
  context: ExternalAgentRunRequest["context"],
  key: string,
): string | undefined {
  const state = (context?.session?.state ?? {}) as Record<string, unknown>;
  const value = state[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Translates a permission policy into the SDK's permission options.
 *
 * @remarks
 * `read-only` and `ask` use `default` (the bridge's own rules and the
 * permission callback still gate writes; the SDK's `plan` mode can stall a
 * plain question), `workspace-write` uses `acceptEdits`, and `full-access`
 * uses `bypassPermissions` together with `allowDangerouslySkipPermissions`.
 *
 * @param permissions - Policy of the run. Defaults to mode `ask`.
 * @returns The permission mode and, for `full-access`, the skip flag.
 */
export function mapPolicyToClaudeSdkPermission(
  permissions?: ExternalAgentPermissionPolicy,
): {
  permissionMode: ClaudeAgentSdkPermissionMode;
  allowDangerouslySkipPermissions?: true;
} {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);

  if (flags.readOnly) {
    // A read-only policy must still answer questions and run read-only tools.
    // `"plan"` is interactive planning mode (explore-without-executing, driven
    // by ExitPlanMode) and can stall a plain Q&A run or return a plan artifact
    // instead of an answer. `"default"` keeps normal execution while the
    // bridge's read-only permission rules continue to gate write/edit tools.
    return { permissionMode: "default" };
  }
  if (flags.workspaceWrite) {
    return { permissionMode: "acceptEdits" };
  }
  if (flags.fullAccess) {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    };
  }
  return { permissionMode: "default" };
}

function claudeExecutableCandidates({
  env,
  executableSearchPaths,
  excluded,
}: {
  env: Record<string, string | undefined>;
  executableSearchPaths?: string[];
  excluded: readonly string[];
}): string[] {
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  const home = env.HOME;
  return executableCandidates({
    executable,
    env,
    excluded,
    extraDirs: [
      ...(home
        ? [join(home, ".local", "bin"), join(home, ".claude", "local")]
        : []),
      ...(executableSearchPaths ?? []),
    ],
    packagePaths: (base) =>
      platformClaudePackages().map((platformPackage) =>
        join(
          base,
          "node_modules",
          "@anthropic-ai",
          platformPackage,
          executable,
        ),
      ),
  });
}

function platformClaudePackages(): string[] {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return ["claude-agent-sdk-darwin-arm64"];
    case "darwin:x64":
      return ["claude-agent-sdk-darwin-x64"];
    case "linux:arm64":
      return ["claude-agent-sdk-linux-arm64"];
    case "linux:x64":
      return ["claude-agent-sdk-linux-x64"];
    case "win32:arm64":
      return ["claude-agent-sdk-win32-arm64"];
    case "win32:x64":
      return ["claude-agent-sdk-win32-x64"];
    default:
      return [];
  }
}

function importClaudeAgentSdk(): Promise<ClaudeAgentSdkLike> {
  return import(
    "@anthropic-ai/claude-agent-sdk"
  ) as Promise<ClaudeAgentSdkLike>;
}

/** The ADK session id used to key captured SDK session ids. */
function adkSessionIdOf(request: ExternalAgentRunRequest): string | undefined {
  const session = (
    request.context as { session?: { id?: unknown } } | undefined
  )?.session;
  return typeof session?.id === "string" && session.id.length > 0
    ? session.id
    : undefined;
}

/** The session id of a `system`/`init` message only. */
function initSessionId(message: unknown): string | undefined {
  const record = asRecord(message);
  return record.type === "system" && record.subtype === "init"
    ? stringValue(record.session_id)
    : undefined;
}

/** Pull the SDK session id off a `system`/`init` or `result` message. */
function extractSdkSessionId(message: unknown): string | undefined {
  const record = asRecord(message);
  if (!record) {
    return undefined;
  }
  if (
    (record.type === "system" && record.subtype === "init") ||
    record.type === "result"
  ) {
    return stringValue(record.session_id);
  }
  return undefined;
}

/**
 * Translates a tool's JSON Schema into the zod raw shape the SDK's `tool()`
 * expects. Returns `undefined` when the schema is not an object schema or zod
 * cannot translate it.
 */
async function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  try {
    const { z } = await import("zod/v4");
    const converted = z.fromJSONSchema(schema as never) as unknown as {
      shape?: Record<string, unknown>;
    };
    return converted.shape;
  } catch {
    return undefined;
  }
}

async function createRunSubAgentSchema(): Promise<Record<string, unknown>> {
  try {
    const { z } = await import("zod/v4");
    return {
      agentName: z.string().describe("Name of the ADK subagent to run"),
      task: z.string().describe("Task or prompt for the subagent"),
    };
  } catch (error) {
    throw new Error(
      "Claude Agent SDK MCP subagent tooling requires zod/v4. Install zod or update @anthropic-ai/claude-agent-sdk dependencies.",
      { cause: error },
    );
  }
}

function toolTextResult(
  text: string,
  isError?: boolean,
): ClaudeAgentSdkToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asyncIterable(
  messages: ReadonlyArray<SDKUserMessage>,
): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

function buildPrompt(request: ExternalAgentRunRequest): string {
  const contents = safeCollectContents(request.context);
  if (contents.length > 0) {
    return flattenContentsToPrompt(contents);
  }
  return contextText(request.context) ?? "";
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join("") : undefined;
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
  return arrayContent ? extractText(arrayContent) : undefined;
}

/**
 * The `error` event for an assistant message that carries an `error`, or
 * undefined when it carries none.
 *
 * @remarks
 * `error` is an `SDKAssistantMessageError` subtype
 * (`authentication_failed`, `model_not_found`, `rate_limit`, ...), classified
 * with `classifyRecoverable`. The message text says what to fix ("There's an
 * issue with the selected model ..."), so it is kept after the subtype.
 * Shared by the SDK and CLI drivers.
 *
 * @param record - The assistant message (SDK message or `stream-json` line).
 * @param fallbackCode - Code for a subtype the classifier does not know.
 * @returns The error event, or undefined.
 */
export function claudeAssistantErrorEvent(
  record: Record<string, unknown>,
  fallbackCode: string,
): ExternalAgentEvent | undefined {
  const error = stringValue(record.error);
  if (!error) return undefined;
  const content = asRecord(record.message).content;
  const text = extractText(
    Array.isArray(content)
      ? content.filter((block) => asRecord(block).type !== "tool_use")
      : content,
  )?.trim();
  const message = text ? `${error}: ${text}` : error;
  const classification = classifyRecoverable({
    subtype: error,
    message,
    fallbackCode,
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
 * `tool_call` events for the `tool_use` blocks of an assistant message.
 * The bridge's delegation tool is skipped (it maps to transfer events).
 * Built-in tools carry `metadata.builtin: true`; the bridge's ADK tools carry
 * `metadata.adkTool: true`. Shared by the SDK and CLI drivers.
 *
 * @param content - The message's `content` blocks.
 * @param toolNames - Map of `tool_use` id to tool name, shared across the run.
 * @param parentToolUseId - The message's `parent_tool_use_id`, if any.
 * @returns One event per `tool_use` block.
 */
export function toolUseEvents(
  content: unknown,
  toolNames: Map<string, string>,
  parentToolUseId: unknown,
  mcp?: ToolEventMcpContext,
): ExternalAgentEvent[] {
  if (!Array.isArray(content)) return [];
  const events: ExternalAgentEvent[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block.type !== "tool_use") continue;
    const name = stringValue(block.name);
    const callId = stringValue(block.id);
    if (!name) continue;
    if (callId) toolNames.set(callId, name);
    if (name === BRIDGE_SUBAGENT_TOOL) continue;
    const metadata = toolEventMetadata(name, parentToolUseId, mcp);
    if (callId && metadata.mcp !== undefined) {
      mcp?.started.set(callId, Date.now());
    }
    events.push({
      type: "tool_call",
      name,
      input: block.input,
      ...(callId ? { callId } : {}),
      metadata,
      timestamp: Date.now(),
    });
  }
  return events;
}

/**
 * `tool_result` events for the `tool_result` blocks of a user message. Shared
 * by the SDK and CLI drivers.
 *
 * @param content - The message's `content` blocks.
 * @param toolNames - Map of `tool_use` id to tool name, shared across the run.
 * @param parentToolUseId - The message's `parent_tool_use_id`, if any.
 * @returns One event per `tool_result` block whose `tool_use` is known.
 */
export function toolResultEvents(
  content: unknown,
  toolNames: Map<string, string>,
  parentToolUseId: unknown,
  mcp?: ToolEventMcpContext,
): ExternalAgentEvent[] {
  if (!Array.isArray(content)) return [];
  const events: ExternalAgentEvent[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block.type !== "tool_result") continue;
    const callId = stringValue(block.tool_use_id);
    const name = callId ? toolNames.get(callId) : undefined;
    // A result without a known `tool_use` cannot be named or paired.
    if (!name || name === BRIDGE_SUBAGENT_TOOL) continue;
    const error =
      block.is_error === true
        ? (extractText(block.content) ?? "Tool call failed")
        : undefined;
    const metadata = toolEventMetadata(name, parentToolUseId, mcp);
    const started = callId ? mcp?.started.get(callId) : undefined;
    if (started !== undefined && callId) {
      mcp?.started.delete(callId);
      if (metadata.mcp !== undefined) {
        metadata.durationMs = Math.max(0, Date.now() - started);
      }
    }
    events.push({
      type: "tool_result",
      name,
      result: block.content,
      callId,
      ...(error ? { error } : {}),
      metadata,
      timestamp: Date.now(),
    });
  }
  return events;
}

function toolEventMetadata(
  name: string,
  parentToolUseId: unknown,
  mcp?: ToolEventMcpContext,
): Record<string, unknown> {
  const parent = stringValue(parentToolUseId);
  const server = name.startsWith(BRIDGE_TOOL_PREFIX)
    ? undefined
    : mcpToolServer(name, mcp?.servers);
  return {
    ...(name.startsWith(BRIDGE_TOOL_PREFIX)
      ? { builtin: false, adkTool: true }
      : { builtin: true }),
    ...(server !== undefined ? { mcp: server } : {}),
    ...(parent ? { parentToolUseId: parent } : {}),
  };
}

/**
 * A "model-less" result: success, not an error, zero turns and an empty
 * `result`. Claude Code writes one when display rows reach the host while no
 * turn is under way and its input queue is empty; it does not answer the
 * input.
 */
function isModelLessResult(message: ClaudeAgentSdkMessage): boolean {
  const record = asRecord(message);
  return (
    record.type === "result" &&
    record.subtype === "success" &&
    record.is_error !== true &&
    record.num_turns === 0 &&
    (record.result === undefined || record.result === "")
  );
}

/** A message that only a running turn writes. */
function isTurnMessage(message: ClaudeAgentSdkMessage): boolean {
  const type = asRecord(message).type;
  return type === "assistant" || type === "stream_event" || type === "user";
}

/**
 * The error of a run whose stream ended after only model-less results.
 *
 * @param sessionId - The SDK session the run was in, if known.
 */
function noTurnEvent(sessionId: string | undefined): ExternalAgentEvent {
  return {
    type: "error",
    message: `Claude Agent SDK: Claude Code ended the run without running the input: it wrote only a model-less result (success, num_turns 0, empty result)${sessionId ? ` in session ${sessionId}` : ""}, so the input was not worked on. A new run of the same input can work.`,
    code: EXTERNAL_AGENT_NO_TURN,
    recoverable: true,
    timestamp: Date.now(),
  };
}

/**
 * The error of a run whose stream ended with no result message.
 *
 * @param sessionId - The SDK session the run was in, if known.
 */
function noResultEvent(sessionId: string | undefined): ExternalAgentEvent {
  return {
    type: "error",
    message: `Claude Agent SDK: the stream ended without a result message${sessionId ? ` in session ${sessionId}` : ""}, so the run has no outcome. Claude Code may have exited early. A new run of the same input can work.`,
    code: EXTERNAL_AGENT_NO_RESULT,
    recoverable: true,
    timestamp: Date.now(),
  };
}

/**
 * Known MCP server names of a run, and the start time of each MCP call by
 * call id, for the `metadata.mcp` and `durationMs` of its tool events.
 */
export interface ToolEventMcpContext {
  /** Server names: declared, required and those `system/init` listed. */
  readonly servers: Set<string>;
  /** Start time of each open MCP call, by call id. */
  readonly started: Map<string, number>;
}

/**
 * The server and tool of `mcp__<server>__<tool>`, matching the longest known
 * server name; `undefined` for any other name or an unknown server.
 */
function mcpToolServer(
  name: string,
  servers: ReadonlySet<string> | undefined,
): { server: string; tool: string } | undefined {
  let best: string | undefined;
  for (const server of servers ?? []) {
    const prefix = `mcp__${server}__`;
    if (
      name.startsWith(prefix) &&
      name.length > prefix.length &&
      (best === undefined || server.length > best.length)
    ) {
      best = server;
    }
  }
  return best === undefined
    ? undefined
    : { server: best, tool: name.slice(`mcp__${best}__`.length) };
}

function isSuccessResultWithText(message: ClaudeAgentSdkMessage): boolean {
  const record = asRecord(message);
  return (
    record.type === "result" &&
    record.subtype === "success" &&
    typeof record.result === "string" &&
    record.result.length > 0
  );
}
