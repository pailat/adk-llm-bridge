/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CLAUDE_PROVIDER } from "../provider/schema.js";
import {
  collectContents,
  flattenContentsToPrompt,
} from "../runtime/content-collector.js";
import {
  contentsToSdkMessages,
  type SDKUserMessage,
} from "./claude-message-mapper.js";

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
  systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string };
  allowDangerouslySkipPermissions?: true;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  resume?: string;
  forkSession?: boolean;
};

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
 * subprocess on early break/error (LIFECYCLE-1).
 */
type ClaudeAgentSdkQuery = AsyncIterable<ClaudeAgentSdkMessage> & {
  interrupt?(): Promise<void> | void;
  return?(value?: unknown): Promise<unknown> | unknown;
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
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ClaudeAgentSdkToolResult>,
    extras?: Record<string, unknown>,
  ): ClaudeAgentSdkToolDefinition;
};

export interface ClaudeExecutableResolution {
  path?: string;
  checked: string[];
}

export interface ClaudeAgentSdkDriverConfig {
  sdk?: ClaudeAgentSdkLike;
  importSdk?: () => Promise<ClaudeAgentSdkLike>;
  pathToClaudeCodeExecutable?: string;
  executableSearchPaths?: string[];
  env?: Record<string, string | undefined>;
  settingSources?: ClaudeAgentSdkSettingSource[];
  maxTurns?: number;
  model?: string;
  debugEvents?: boolean;
  /**
   * AUTH-2: opt-in plain-string system prompt. When set, it REPLACES the
   * `claude_code` preset (and `request.instruction` is appended to it) so a
   * non-coding agent is not forced into the full coding-agent persona/token
   * cost. When unset, the driver keeps the preset+append default.
   */
  systemPrompt?: string;
  /**
   * If set, the driver passes this session id to the Claude SDK
   * `options.resume` field and sends only the current user turn (not the full
   * ADK history) so the SDK appends to the resumed session instead of
   * re-feeding history that the SDK already has on disk.
   */
  resumeSessionId?: string;
  /**
   * Pass-through for the Claude SDK `options.forkSession` flag. Use with
   * `resumeSessionId` to fork rather than continue the previous session.
   */
  forkSession?: boolean;
}

export class ClaudeAgentSdkDriver {
  readonly providerId = CLAUDE_PROVIDER.id;
  readonly #sdk?: ClaudeAgentSdkLike;
  readonly #importSdk: () => Promise<ClaudeAgentSdkLike>;
  readonly #env: Record<string, string | undefined>;
  readonly #pathToClaudeCodeExecutable?: string;
  readonly #executableSearchPaths: string[];
  readonly #settingSources: ClaudeAgentSdkSettingSource[];
  readonly #maxTurns?: number;
  readonly #model?: string;
  readonly #debugEvents: boolean;
  readonly #resumeSessionId?: string;
  readonly #forkSession?: boolean;
  readonly #systemPrompt?: string;
  // RESUME-1: maps an ADK session id -> the SDK session id captured from the
  // first turn's system/init (or result) message. Subsequent turns of the same
  // ADK session pass it as `options.resume` and send only the newest user turn,
  // so the SDK reloads prior user/assistant/tool history from its own on-disk
  // transcript instead of replaying it through the user-only input stream
  // (which would crash with "Expected message role 'user', got 'assistant'").
  readonly #sdkSessionByAdkSession = new Map<string, string>();

  constructor(config: ClaudeAgentSdkDriverConfig = {}) {
    this.#sdk = config.sdk;
    this.#importSdk = config.importSdk ?? importClaudeAgentSdk;
    this.#env = config.env ?? process.env;
    this.#pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable;
    this.#executableSearchPaths = config.executableSearchPaths ?? [];
    // AUTH-1: default to SDK isolation (`[]`) instead of `undefined`. Leaving it
    // undefined causes `removeUndefined` to strip the key, which makes the SDK
    // load ALL host setting sources (user `~/.claude` + project `.claude` +
    // local) — permission rules, MCP servers, hooks, CLAUDE.md — and can
    // silently override the intended policy. Consumers opt back in by passing an
    // explicit allowlist.
    this.#settingSources = config.settingSources ?? [];
    this.#maxTurns = config.maxTurns;
    this.#model = config.model;
    this.#debugEvents = config.debugEvents ?? false;
    this.#resumeSessionId = config.resumeSessionId;
    this.#forkSession = config.forkSession;
    this.#systemPrompt = config.systemPrompt;
  }

  async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    const sdk = await this.loadSdk();
    // RESUME-1: a static #resumeSessionId (config) wins; otherwise resume the SDK
    // session previously captured for this ADK session, if any.
    const adkSessionId = adkSessionIdOf(request);
    const resolvedResume =
      this.#resumeSessionId ??
      (adkSessionId ? this.#sdkSessionByAdkSession.get(adkSessionId) : undefined);
    const prompt = this.buildPromptInput(request, resolvedResume);
    const options = await this.buildOptionsForRun(request, sdk, resolvedResume);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    let completed = false;
    let failed = false;
    let emittedOutput = false;
    // LIFECYCLE-1: capture the Query so we can tear down the spawned `claude`
    // subprocess on early consumer break or thrown error. We drive the iterator
    // manually (rather than `for await`) so the `finally` reliably runs even
    // when the consumer breaks out of *this* generator early — a `for await`
    // over the inner Query can swallow the outer return on some runtimes.
    // `query()` itself is invoked inside the try so a synchronous throw is
    // classified too. The `finally` runs on normal completion, break, AND throw.
    let query: ClaudeAgentSdkQuery | undefined;
    try {
      query = sdk.query({ prompt, options });
      const iterator = query[Symbol.asyncIterator]();
      while (true) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        const message = next.value;
        // RESUME-1: capture the SDK session id (system/init or result) so the
        // next turn of this ADK session can resume it.
        if (adkSessionId) {
          const captured = extractSdkSessionId(message);
          if (captured) {
            this.#sdkSessionByAdkSession.set(adkSessionId, captured);
          }
        }
        // ERR-3: if the turn produced no streamed assistant text, fall back to
        // the aggregated `result.result` on a successful result message so the
        // run does not complete with silent-empty output.
        if (!emittedOutput && isSuccessResultWithText(message)) {
          const text = stringValue(asRecord(message).result);
          if (text) {
            emittedOutput = true;
            yield { type: "output", content: text, timestamp: Date.now() };
          }
        }
        const events = this.normalizeMessage(message);
        for (const event of events) {
          if (event.type === "completed") {
            completed = true;
          }
          if (event.type === "output") {
            emittedOutput = true;
          }
          yield event;
        }
      }
    } catch (error) {
      failed = true;
      const message = this.describeError(error, request);
      const classification = classifyRecoverable({
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
    } finally {
      if (query) {
        await this.disposeQuery(query, completed);
      }
    }

    if (!completed) {
      yield { type: "completed", exitCode: failed ? 1 : 0, timestamp: Date.now() };
    }
  }

  buildOptions(
    request: ExternalAgentRunRequest,
    resume: string | undefined = this.#resumeSessionId,
  ): ClaudeAgentSdkOptions {
    const permission = mapPolicyToClaudeSdkPermission(request.permissions);
    const options: ClaudeAgentSdkOptions = {
      cwd: request.workingDirectory,
      env: this.buildEnv(request),
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
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      resume,
      forkSession: this.#forkSession,
    };

    return removeUndefined(options) as ClaudeAgentSdkOptions;
  }

  /**
   * AUTH-2: resolve the system prompt. A configured plain-string
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
   * several (the old synthetic-transcript approach) makes the SDK run multiple
   * turns inside one `query()`, and the in-process MCP server (`adk_bridge`) is
   * torn down after the first turn's `result`, so a subagent tool call in a
   * later turn fails with "Stream closed" before the handler runs. Prior history
   * is restored by the SDK from its own transcript via `options.resume`
   * (RESUME-1) — for a non-resumed turn it is folded into the single user prompt
   * as text — never replayed as assistant/tool turns through the input stream.
   */
  buildPromptInput(
    request: ExternalAgentRunRequest,
    resume: string | undefined = this.#resumeSessionId,
  ): string | AsyncIterable<SDKUserMessage> {
    let contents: ReturnType<typeof collectContents>;
    try {
      contents = collectContents(request.context);
    } catch {
      contents = [];
    }

    if (contents.length === 0) {
      return extractContextText(request.context) ?? "";
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

  resolveClaudeExecutable(request: ExternalAgentRunRequest): ClaudeExecutableResolution {
    const checked: string[] = [];
    const explicit = firstNonEmpty(
      this.#pathToClaudeCodeExecutable,
      this.#env.CLAUDE_CODE_EXECUTABLE,
      this.#env.CLAUDE_CODE_PATH,
      readCredentialEnv(request, "CLAUDE_CODE_EXECUTABLE"),
      readCredentialEnv(request, "CLAUDE_CODE_PATH"),
    );
    if (explicit) {
      checked.push(explicit);
      return { path: explicit, checked };
    }

    for (const candidate of claudeExecutableCandidates({
      env: this.#env,
      workingDirectory: request.workingDirectory,
      executableSearchPaths: this.#executableSearchPaths,
    })) {
      checked.push(candidate);
      if (existsSync(candidate)) {
        return { path: candidate, checked };
      }
    }

    return { checked };
  }

  buildEnv(request: ExternalAgentRunRequest): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};

    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");
    copyIfPresent(this.#env, env, "CLAUDE_CONFIG_DIR");
    copyIfPresent(this.#env, env, "XDG_CONFIG_HOME");
    env.CLAUDE_AGENT_SDK_CLIENT_APP = "adk-llm-bridge";

    if (request.credential?.kind === "env") {
      for (const key of request.provider.envAllowlist ?? []) {
        const value = request.credential.env?.[key];
        if (typeof value === "string" && value.length > 0) {
          env[key] = value;
        }
      }
    }

    return env;
  }

  /**
   * Build the `AbortController` wired into `options.abortController` (LIFECYCLE-1).
   * The SDK aborts the spawned `claude` subprocess and releases resources when
   * this controller fires. We bridge the shared run cancellation signal
   * (`request.abortSignal` ?? `context.abortSignal`) onto a fresh controller so
   * the driver also owns a handle it can abort from its own `finally` cleanup.
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
        signal.addEventListener(
          "abort",
          () => controller.abort(signal.reason),
          { once: true },
        );
      }
    }
    return controller;
  }

  /**
   * Tear down a Query (LIFECYCLE-1). When the loop ends early (break/throw)
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

  normalizeMessage(message: ClaudeAgentSdkMessage): ExternalAgentEvent[] {
    const record = asRecord(message);
    const type = stringValue(record.type);

    if (type === "assistant") {
      const error = stringValue(record.error);
      if (error) {
        // `record.error` is an SDKAssistantMessageError subtype
        // (authentication_failed/billing_error/rate_limit/server_error/…).
        const classification = classifyRecoverable({
          subtype: error,
          message: error,
          fallbackCode: error,
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

      const text = extractText(asRecord(record.message).content);
      return text ? [{ type: "output", content: text, timestamp: Date.now() }] : [];
    }

    if (type === "result") {
      if (record.subtype === "success") {
        return [{ type: "completed" as const, exitCode: 0, timestamp: Date.now() }];
      }

      const errors = Array.isArray(record.errors)
        ? record.errors.filter((item): item is string => typeof item === "string")
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
        fallbackCode: subtype ?? "CLAUDE_AGENT_SDK_RESULT_ERROR",
      });
      return [
        {
          type: "error",
          message,
          code: classification.code,
          recoverable: classification.recoverable,
          timestamp: Date.now(),
        },
        { type: "completed", exitCode: 1, timestamp: Date.now() },
      ];
    }

    if (type === "auth_status") {
      const error = stringValue(record.error);
      if (!error) {
        return [];
      }
      const classification = classifyRecoverable({
        subtype: "CLAUDE_AUTH_STATUS",
        message: error,
        fallbackCode: "CLAUDE_AUTH_STATUS",
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
      // ERR-1 was REFUTED: keep the base SDK rejection message. ERR-2 enriches
      // it with tool_name / decision_reason when present. Permission denials do
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

    if (this.#debugEvents) {
      return [{ type: "output", content: JSON.stringify(message), timestamp: Date.now() }];
    }

    return [];
  }

  async buildOptionsForRun(
    request: ExternalAgentRunRequest,
    sdk: ClaudeAgentSdkLike,
    resume: string | undefined = this.#resumeSessionId,
  ): Promise<ClaudeAgentSdkOptions> {
    const options = this.buildOptions(request, resume);
    if (!request.toolGateway || !request.subAgents || request.subAgents.length === 0) {
      return options;
    }

    const mcpServer = await this.buildSubAgentMcpServer(request, sdk);
    return removeUndefined({
      ...options,
      mcpServers: {
        ...(options.mcpServers ?? {}),
        adk_bridge: mcpServer,
      },
      allowedTools: [
        ...(options.allowedTools ?? []),
        "mcp__adk_bridge__run_adk_subagent",
      ],
    }) as ClaudeAgentSdkOptions;
  }

  private async buildSubAgentMcpServer(
    request: ExternalAgentRunRequest,
    sdk: ClaudeAgentSdkLike,
  ): Promise<unknown> {
    if (!sdk.createSdkMcpServer || !sdk.tool) {
      throw new Error(
        "Claude Agent SDK MCP support is required to expose ADK subagents. Update @anthropic-ai/claude-agent-sdk or run without subAgents.",
      );
    }

    const schema = await createRunSubAgentSchema();
    const available = request.subAgents?.map((agent) => agent.name).join(", ") ?? "";
    const runSubAgentTool = sdk.tool(
      "run_adk_subagent",
      `Run one of the ADK subagents by name. Available subagents: ${available}`,
      schema,
      async (args) => {
        const agentName = stringValue(args.agentName) ?? "";
        const task = stringValue(args.task) ?? "";
        const result = await request.toolGateway?.runSubAgent({ agentName, task });
        if (!result) {
          return toolTextResult("ADK ToolGateway is not available.", true);
        }
        if (result.error) {
          return toolTextResult(result.error, true);
        }
        return toolTextResult(result.output || `Subagent ${result.agentName} completed with ${result.events} events.`);
      },
      { alwaysLoad: true },
    );

    return sdk.createSdkMcpServer({
      name: "adk_bridge",
      version: "0.1.0",
      tools: [runSubAgentTool],
      alwaysLoad: true,
    });
  }

  private describeError(error: unknown, request: ExternalAgentRunRequest): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Native CLI binary") && !message.includes("pathToClaudeCodeExecutable")) {
      return message;
    }

    const resolution = this.resolveClaudeExecutable(request);
    const checked = resolution.checked.length > 0
      ? resolution.checked.map((item) => `  - ${item}`).join("\n")
      : "  - <no candidates>";
    return [
      "Claude Agent SDK could not locate a Claude Code executable.",
      "Set CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude or CLAUDE_CODE_PATH=/absolute/path/to/claude, add the executable directory to PATH, pass executableSearchPaths, or reinstall @anthropic-ai/claude-agent-sdk with optional dependencies.",
      `Original error: ${message}`,
      "Checked paths:",
      checked,
    ].join("\n");
  }

  private async loadSdk(): Promise<ClaudeAgentSdkLike> {
    if (this.#sdk) {
      return this.#sdk;
    }

    try {
      return await this.#importSdk();
    } catch (error) {
      throw new Error(
        "ClaudeAgent requires @anthropic-ai/claude-agent-sdk. Install it or pass driver: new ClaudeCliDriver(...).",
        { cause: error },
      );
    }
  }
}

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
    return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
  }
  return { permissionMode: "default" };
}

function claudeExecutableCandidates({
  env,
  workingDirectory,
  executableSearchPaths,
}: {
  env: Record<string, string | undefined>;
  workingDirectory?: string;
  executableSearchPaths?: string[];
}): string[] {
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = new Set<string>();

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0) {
      candidates.add(join(dir, executable));
    }
  }

  const home = env.HOME;
  if (home) {
    candidates.add(join(home, ".local", "bin", executable));
    candidates.add(join(home, ".claude", "local", executable));
  }

  for (const dir of executableSearchPaths ?? []) {
    if (dir.length > 0) {
      candidates.add(join(dir, executable));
    }
  }

  for (const base of candidateBaseDirectories(workingDirectory)) {
    candidates.add(join(base, "node_modules", ".bin", executable));
    for (const platformPackage of platformClaudePackages()) {
      candidates.add(join(base, "node_modules", "@anthropic-ai", platformPackage, executable));
    }
  }

  return [...candidates];
}

function candidateBaseDirectories(workingDirectory?: string): string[] {
  const roots = new Set<string>();
  if (workingDirectory) {
    roots.add(resolve(workingDirectory));
  }
  roots.add(process.cwd());

  let current = dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index++) {
    roots.add(current);
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return [...roots].filter((item) => isAbsolute(item));
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function readCredentialEnv(
  request: ExternalAgentRunRequest,
  key: string,
): string | undefined {
  return request.credential?.kind === "env" ? request.credential.env?.[key] : undefined;
}

function importClaudeAgentSdk(): Promise<ClaudeAgentSdkLike> {
  return import("@anthropic-ai/claude-agent-sdk") as Promise<ClaudeAgentSdkLike>;
}

/** RESUME-1: the ADK session id used to key captured SDK session ids. */
function adkSessionIdOf(request: ExternalAgentRunRequest): string | undefined {
  const session = (request.context as { session?: { id?: unknown } } | undefined)
    ?.session;
  return typeof session?.id === "string" && session.id.length > 0
    ? session.id
    : undefined;
}

/** RESUME-1: pull the SDK session id off a `system`/`init` or `result` message. */
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

function toolTextResult(text: string, isError?: boolean): ClaudeAgentSdkToolResult {
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
  try {
    const contents = collectContents(request.context);
    if (contents.length > 0) {
      return flattenContentsToPrompt(contents);
    }
  } catch {
    // fall through to legacy extractor
  }
  return extractContextText(request.context) ?? "";
}

function extractContextText(context: unknown): string | undefined {
  const record = asRecord(context);
  return (
    extractText(record.userContent ?? record.user_content) ??
    stringValue(record.input) ??
    stringValue(record.prompt)
  );
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

function copyIfPresent(
  source: Record<string, string | undefined>,
  target: Record<string, string | undefined>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
}

function removeUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
