/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Content } from "@google/genai";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import { collectContents } from "../runtime/content-collector.js";
import { classifyRecoverable } from "../runtime/error-classification.js";
import {
  type CodexInputPart,
  summarizeHistoryForColdStart,
  userContentToCodexInput,
} from "./codex-input-mapper.js";

/**
 * Ambient environment variables forwarded from `this.#env` into the Codex SDK's
 * replacement env (the SDK does not inherit `process.env`). Covers proxy/cert
 * egress configuration plus a custom shell `CODEX_HOME` (CODEX-3).
 */
const CODEX_AMBIENT_PASSTHROUGH = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_HOME",
] as const;

type CodexSdkApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type CodexSdkSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type CodexSdkModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexSdkWebSearchMode = "disabled" | "cached" | "live";
type CodexSdkConfigValue =
  | string
  | number
  | boolean
  | CodexSdkConfigValue[]
  | CodexSdkConfigObject;
type CodexSdkConfigObject = { [key: string]: CodexSdkConfigValue };

type CodexSdkOptions = {
  codexPathOverride?: string;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexSdkConfigObject;
  env?: Record<string, string>;
};

type CodexSdkThreadOptions = {
  model?: string;
  sandboxMode?: CodexSdkSandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: CodexSdkModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchMode?: CodexSdkWebSearchMode;
  webSearchEnabled?: boolean;
  approvalPolicy?: CodexSdkApprovalMode;
  additionalDirectories?: string[];
};

type CodexSdkTurnOptions = {
  signal?: AbortSignal;
  outputSchema?: Record<string, unknown>;
};

type CodexSdkThreadEvent = Record<string, unknown>;

type CodexSdkInput = string | CodexInputPart[];

type CodexSdkThreadLike = {
  readonly id?: string | null;
  runStreamed(
    input: CodexSdkInput,
    options?: CodexSdkTurnOptions,
  ): Promise<{ events: AsyncGenerator<CodexSdkThreadEvent> }>;
};

type CodexSdkClientLike = {
  startThread(options?: CodexSdkThreadOptions): CodexSdkThreadLike;
  resumeThread(id: string, options?: CodexSdkThreadOptions): CodexSdkThreadLike;
};

type CodexSdkConstructor = new (options?: CodexSdkOptions) => CodexSdkClientLike;

type CodexSdkModuleLike = {
  Codex: CodexSdkConstructor;
};

export interface CodexBinaryResolution {
  path?: string;
  checked: string[];
}

export interface CodexSdkDriverConfig {
  sdk?: CodexSdkClientLike;
  Codex?: CodexSdkConstructor;
  importSdk?: () => Promise<CodexSdkModuleLike>;
  codexPathOverride?: string;
  env?: Record<string, string | undefined>;
  baseUrl?: string;
  apiKey?: string;
  config?: CodexSdkConfigObject;
  model?: string;
  modelReasoningEffort?: CodexSdkModelReasoningEffort;
  skipGitRepoCheck?: boolean;
  webSearchMode?: CodexSdkWebSearchMode;
  webSearchEnabled?: boolean;
  outputSchema?: Record<string, unknown>;
  /**
   * Computes the `session.state` key used to persist Codex thread IDs so a
   * subsequent invocation can call `resumeThread(savedId)` instead of starting
   * a fresh thread. Defaults to `"codex_thread:" + agentName`.
   */
  threadStateKey?: (agentName: string) => string;
}

export class CodexSdkDriver {
  readonly providerId = CODEX_PROVIDER.id;
  readonly #sdk?: CodexSdkClientLike;
  readonly #Codex?: CodexSdkConstructor;
  readonly #importSdk: () => Promise<CodexSdkModuleLike>;
  readonly #codexPathOverride?: string;
  readonly #env: Record<string, string | undefined>;
  readonly #baseUrl?: string;
  readonly #apiKey?: string;
  readonly #config?: CodexSdkConfigObject;
  readonly #model?: string;
  readonly #modelReasoningEffort?: CodexSdkModelReasoningEffort;
  readonly #skipGitRepoCheck?: boolean;
  readonly #webSearchMode?: CodexSdkWebSearchMode;
  readonly #webSearchEnabled?: boolean;
  readonly #outputSchema?: Record<string, unknown>;
  readonly #threadStateKey: (agentName: string) => string;

  constructor(config: CodexSdkDriverConfig = {}) {
    this.#sdk = config.sdk;
    this.#Codex = config.Codex;
    this.#importSdk = config.importSdk ?? importCodexSdk;
    this.#codexPathOverride = config.codexPathOverride;
    this.#env = config.env ?? process.env;
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
    this.#config = config.config;
    this.#model = config.model;
    this.#modelReasoningEffort = config.modelReasoningEffort;
    this.#skipGitRepoCheck = config.skipGitRepoCheck;
    this.#webSearchMode = config.webSearchMode;
    this.#webSearchEnabled = config.webSearchEnabled;
    this.#outputSchema = config.outputSchema;
    this.#threadStateKey =
      config.threadStateKey ?? ((agentName) => `codex_thread:${agentName}`);
  }

  capabilities() {
    return {
      streaming: true,
      sessions: true,
      permissions: true,
      tools: true,
      mcpServers: true,
    };
  }

  async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    let completed = false;
    let failed = false;
    const pendingEvents: ExternalAgentEvent[] = [];
    let cleanup: () => Promise<void> = async () => {};
    try {
      const sdk = await this.loadSdk(request);
      const threadOptions = this.buildThreadOptions(request);
      const agentName = request.agent?.name ?? request.context?.agent?.name;
      const stateKey = agentName ? this.#threadStateKey(agentName) : undefined;
      const savedThreadId = readSavedThreadId(request, stateKey);
      const contents = safeCollectContents(request);
      const lastContent = contents[contents.length - 1];

      let thread: CodexSdkThreadLike;
      let input: CodexSdkInput;

      if (savedThreadId) {
        thread = sdk.resumeThread(savedThreadId, threadOptions);
        const mapping = mapLastContentOrFallback(lastContent, request);
        cleanup = mapping.cleanup;
        input = applyInstruction(request.instruction, mapping.input);
      } else if (contents.length > 1 && lastContent) {
        thread = sdk.startThread(threadOptions);
        const mapping = userContentToCodexInput(lastContent);
        cleanup = mapping.cleanup;
        const transcript = summarizeHistoryForColdStart(contents);
        input = applyInstruction(
          request.instruction,
          prependColdStartTranscript(mapping.input, transcript),
        );
      } else {
        thread = sdk.startThread(threadOptions);
        const mapping = mapLastContentOrFallback(lastContent, request);
        cleanup = mapping.cleanup;
        input = applyInstruction(request.instruction, mapping.input);
      }

      const { events } = await thread.runStreamed(input, {
        signal: resolveAbortSignal(request),
        outputSchema: this.#outputSchema,
      });

      // Track the thread id as soon as it is known so resumability survives a
      // mid-turn throw. The `thread.started` event carries it before the first
      // turn completes; we emit the `state_delta` immediately (CODEX-4) and
      // remember it so the post-loop read does not re-emit.
      let emittedThreadId: string | undefined;
      const emitThreadId = (threadId: string | undefined) => {
        if (!stateKey || !threadId) return undefined;
        if (threadId === savedThreadId || threadId === emittedThreadId) {
          return undefined;
        }
        emittedThreadId = threadId;
        const delta: ExternalAgentEvent = {
          type: "state_delta",
          stateDelta: { [stateKey]: threadId },
          timestamp: Date.now(),
        };
        return delta;
      };

      for await (const event of events) {
        if (stringValue(event.type) === "thread.started") {
          const delta = emitThreadId(threadStartedId(event));
          if (delta) {
            yield delta;
          }
          continue;
        }
        for (const normalized of this.normalizeEvent(event)) {
          if (normalized.type === "completed") {
            pendingEvents.push(normalized);
            continue;
          }
          yield normalized;
        }
      }

      // Fallback: if `thread.started` was never observed (older event stream),
      // persist the id from the post-loop accessor.
      const postLoopDelta = emitThreadId(thread.id ?? undefined);
      if (postLoopDelta) {
        yield postLoopDelta;
      }

      for (const event of pendingEvents) {
        if (event.type === "completed") {
          completed = true;
        }
        yield event;
      }
    } catch (error) {
      failed = true;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const { recoverable, code } = classifyRecoverable({
        message: rawMessage,
        fallbackCode: "CODEX_SDK_ERROR",
      });
      yield {
        type: "error",
        message: this.describeError(error, request),
        code,
        recoverable,
        timestamp: Date.now(),
      };
    } finally {
      try {
        await cleanup();
      } catch {
        // best-effort cleanup; never let tmp deletion mask the real error.
      }
    }

    if (!completed) {
      yield { type: "completed", exitCode: failed ? 1 : 0, timestamp: Date.now() };
    }
  }

  buildClientOptions(request: ExternalAgentRunRequest): CodexSdkOptions {
    return removeUndefined({
      codexPathOverride: this.resolveCodexBinary(request).path,
      baseUrl: this.#baseUrl,
      apiKey: this.#apiKey ?? readCredentialEnv(request, "CODEX_API_KEY"),
      config: this.#config,
      env: this.buildEnv(request),
    }) as CodexSdkOptions;
  }

  buildThreadOptions(request: ExternalAgentRunRequest): CodexSdkThreadOptions {
    const policyOptions = mapPolicyToCodexSdkThreadOptions(request.permissions);
    // Web search needs network egress. When the resolved sandbox has network
    // access disabled (`policy.allowNetwork:false`), requesting web search asks
    // for egress the sandbox cannot grant, so omit it entirely (CODEX-7).
    const networkAccessEnabled = policyOptions.networkAccessEnabled === true;
    return removeUndefined({
      ...policyOptions,
      model: this.#model,
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: this.#skipGitRepoCheck,
      modelReasoningEffort: this.#modelReasoningEffort,
      webSearchMode: networkAccessEnabled ? this.#webSearchMode : undefined,
      webSearchEnabled: networkAccessEnabled ? this.#webSearchEnabled : undefined,
    }) as CodexSdkThreadOptions;
  }

  resolveCodexBinary(request: ExternalAgentRunRequest): CodexBinaryResolution {
    const checked: string[] = [];
    const explicit = firstNonEmpty(
      this.#codexPathOverride,
      this.#env.CODEX_EXECUTABLE,
      this.#env.CODEX_CLI_PATH,
      readCredentialEnv(request, "CODEX_EXECUTABLE"),
      readCredentialEnv(request, "CODEX_CLI_PATH"),
    );
    if (explicit) {
      checked.push(explicit);
      return { path: explicit, checked };
    }

    for (const candidate of codexBinaryCandidates({
      env: this.#env,
      workingDirectory: request.workingDirectory,
    })) {
      checked.push(candidate);
      if (existsSync(candidate)) {
        return { path: candidate, checked };
      }
    }

    return { checked };
  }

  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    const env: Record<string, string> = {};
    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");
    copyIfPresent(this.#env, env, "XDG_CONFIG_HOME");

    // The SDK builds a *replacement* env (it does not inherit `process.env`
    // when `env` is supplied), so ambient proxy/cert vars must be forwarded
    // explicitly or egress through a corporate proxy / custom CA breaks. A
    // custom shell `CODEX_HOME` is also carried through here so it is not lost
    // when it is not delivered via a structured credential (CODEX-3). When a
    // credential supplies one of these keys it overrides the ambient value via
    // the allowlist loop below.
    for (const key of CODEX_AMBIENT_PASSTHROUGH) {
      copyIfPresent(this.#env, env, key);
    }

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

  normalizeEvent(event: CodexSdkThreadEvent): ExternalAgentEvent[] {
    const type = stringValue(event.type);
    const timestamp = Date.now();

    if (type === "turn.completed") {
      return [{ type: "completed", exitCode: 0, timestamp }];
    }

    if (type === "turn.failed") {
      const error = asRecord(event.error);
      const message = stringValue(error.message) ?? "Codex turn failed";
      const { recoverable, code } = classifyRecoverable({
        message,
        fallbackCode: "CODEX_TURN_FAILED",
      });
      return [
        {
          type: "error",
          message,
          code,
          recoverable,
          timestamp,
        },
        { type: "completed", exitCode: 1, timestamp },
      ];
    }

    if (type === "error") {
      const message = stringValue(event.message) ?? "Codex SDK error";
      const { recoverable, code } = classifyRecoverable({
        message,
        fallbackCode: "CODEX_SDK_STREAM_ERROR",
      });
      return [
        {
          type: "error",
          message,
          code,
          recoverable,
          timestamp,
        },
      ];
    }

    if (type === "item.started" || type === "item.updated") {
      return normalizeProgressItem(asRecord(event.item), timestamp);
    }

    if (type !== "item.completed") {
      return [];
    }

    return normalizeCompletedItem(asRecord(event.item), timestamp);
  }

  private async loadSdk(request: ExternalAgentRunRequest): Promise<CodexSdkClientLike> {
    if (this.#sdk) {
      return this.#sdk;
    }

    const Codex = this.#Codex ?? (await this.loadConstructor());
    return new Codex(this.buildClientOptions(request));
  }

  private async loadConstructor(): Promise<CodexSdkConstructor> {
    try {
      return (await this.#importSdk()).Codex;
    } catch (error) {
      throw new Error(
        "CodexAgent requires @openai/codex-sdk. Install it or pass driver: new CodexCliDriver(...).",
        { cause: error },
      );
    }
  }

  private describeError(error: unknown, request: ExternalAgentRunRequest): string {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Unable to locate Codex CLI binaries")) {
      return message;
    }

    const resolution = this.resolveCodexBinary(request);
    const checked = resolution.checked.length > 0
      ? resolution.checked.map((item) => `  - ${item}`).join("\n")
      : "  - <no candidates>";
    return [
      "Codex SDK could not locate a Codex binary.",
      "Set CODEX_EXECUTABLE=/absolute/path/to/codex or CODEX_CLI_PATH=/absolute/path/to/codex, or reinstall @openai/codex with optional dependencies.",
      `Original error: ${message}`,
      "Checked paths:",
      checked,
    ].join("\n");
  }
}

export function mapPolicyToCodexSdkThreadOptions(
  permissions?: ExternalAgentPermissionPolicy,
): CodexSdkThreadOptions {
  const policy = permissions ?? { mode: "read-only" as const };
  const base = {
    networkAccessEnabled: policy.allowNetwork,
    additionalDirectories: policy.allowedPaths ? [...policy.allowedPaths] : undefined,
  };

  switch (policy.mode) {
    case "read-only":
      return removeUndefined({
        ...base,
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
    case "ask":
      return removeUndefined({
        ...base,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      }) as CodexSdkThreadOptions;
    case "workspace-write":
      return removeUndefined({
        ...base,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
    case "full-access":
      return removeUndefined({
        ...base,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }) as CodexSdkThreadOptions;
  }
}

async function importCodexSdk(): Promise<CodexSdkModuleLike> {
  return import("@openai/codex-sdk") as Promise<CodexSdkModuleLike>;
}

function normalizeProgressItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status);
    return command
      ? [
          {
            type: "output",
            content: `Codex command ${status ?? "running"}: ${command}`,
            partial: true,
            turnComplete: false,
            metadata: {
              itemType,
              status,
              command,
              exitCode: item.exit_code,
              title: `Codex: command_execution ${status ?? "running"}`,
            },
            timestamp,
          },
        ]
      : [];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "running";
    return [
      {
        type: "output",
        content: `Codex MCP tool ${status}: ${toolName}`,
        partial: true,
        turnComplete: false,
        metadata: {
          itemType,
          toolName,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "web_search") {
    const query = stringValue(item.query);
    return query
      ? [
          {
            type: "output",
            content: `Codex web search: ${query}`,
            partial: true,
            turnComplete: false,
            metadata: { itemType, query, title: "Codex: web_search" },
            timestamp,
          },
        ]
      : [];
  }

  return [];
}

function normalizeCompletedItem(
  item: Record<string, unknown>,
  timestamp: number,
): ExternalAgentEvent[] {
  const itemType = stringValue(item.type);

  if (itemType === "agent_message") {
    const text = stringValue(item.text);
    return text ? [{ type: "output", content: text, stream: "stdout", timestamp }] : [];
  }

  if (itemType === "error") {
    const message = stringValue(item.message) ?? "Codex item error";
    const { recoverable, code } = classifyRecoverable({
      message,
      fallbackCode: "CODEX_ITEM_ERROR",
    });
    return [
      {
        type: "error",
        message,
        code,
        recoverable,
        timestamp,
      },
    ];
  }

  if (itemType === "mcp_tool_call") {
    const toolName = stringValue(item.tool) ?? "mcp_tool_call";
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: toolName,
        input: {
          server: item.server,
          arguments: item.arguments,
          status: item.status,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          status: item.status,
          title: `Codex: ${toolName} call`,
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: toolName,
        result: {
          server: item.server,
          status: item.status,
          result: item.result,
          error: item.error,
        },
        callId: stringValue(item.id),
        error: stringValue(item.error),
        metadata: {
          itemType,
          status: item.status,
          title: `Codex: ${toolName} ${status}`,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const status = stringValue(item.status) ?? "completed";
    return [
      {
        type: "tool_call",
        name: "command_execution",
        input: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          status: item.status,
          command,
          title: "Codex: command_execution call",
        },
        timestamp,
      },
      {
        type: "tool_result",
        name: "command_execution",
        result: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
        },
        callId: stringValue(item.id),
        metadata: {
          itemType,
          status: item.status,
          command,
          exitCode: item.exit_code,
          title: `Codex: command_execution ${status}`,
        },
        timestamp,
      },
    ];
  }

  return [];
}

/**
 * Extract the thread id from a `thread.started` event. The SDK shape is
 * `ThreadStartedEvent { type: "thread.started", thread_id }`.
 */
function threadStartedId(event: CodexSdkThreadEvent): string | undefined {
  return stringValue(event.thread_id) ?? stringValue((asRecord(event.thread)).id);
}

function safeCollectContents(request: ExternalAgentRunRequest): Content[] {
  try {
    return collectContents(request.context);
  } catch {
    return [];
  }
}

function mapLastContentOrFallback(
  lastContent: Content | undefined,
  request: ExternalAgentRunRequest,
): { input: CodexSdkInput; cleanup: () => Promise<void> } {
  if (lastContent) {
    return userContentToCodexInput(lastContent);
  }
  // No content collected — fall back to the legacy text extractor so synthetic
  // contexts (e.g. unit tests with just `userContent: {...}`) keep working.
  const text = extractContextText(request.context) ?? "";
  return { input: text, cleanup: async () => {} };
}

function applyInstruction(
  instruction: string | undefined,
  input: CodexSdkInput,
): CodexSdkInput {
  if (!instruction || instruction.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${instruction}\n\n${input}` : instruction;
  }
  return [{ type: "text", text: instruction }, ...input];
}

function prependColdStartTranscript(
  input: CodexSdkInput,
  transcript: string,
): CodexSdkInput {
  if (!transcript || transcript.length === 0) {
    return input;
  }
  if (typeof input === "string") {
    return input.length > 0 ? `${transcript}\n\n${input}` : transcript;
  }
  // Array input. If the first part is text, fold the transcript into it;
  // otherwise (e.g. starts with an image), insert a synthetic text part.
  const first = input[0];
  if (first && first.type === "text") {
    return [
      { type: "text", text: `${transcript}\n\n${first.text}` },
      ...input.slice(1),
    ];
  }
  return [{ type: "text", text: transcript }, ...input];
}

function readSavedThreadId(
  request: ExternalAgentRunRequest,
  stateKey: string | undefined,
): string | undefined {
  if (!stateKey) return undefined;
  const session = (request.context as { session?: { state?: unknown } } | undefined)
    ?.session;
  const state = session?.state;
  if (!state || typeof state !== "object") {
    return undefined;
  }
  const value = (state as Record<string, unknown>)[stateKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractContextText(context: unknown): string | undefined {
  const record = asRecord(context);
  const userContent = record.userContent ?? record.user_content;
  const text = extractText(userContent);
  if (text) {
    return text;
  }
  return stringValue(record.input) ?? stringValue(record.prompt);
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

  if (Array.isArray(record.content)) {
    const parts = record.content
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  if (Array.isArray(record.parts)) {
    const parts = record.parts
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  return undefined;
}

function codexBinaryCandidates({
  env,
  workingDirectory,
}: {
  env: Record<string, string | undefined>;
  workingDirectory?: string;
}): string[] {
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const candidates = new Set<string>();

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length > 0) {
      candidates.add(join(dir, executable));
    }
  }

  for (const base of candidateBaseDirectories(workingDirectory)) {
    candidates.add(join(base, "node_modules", ".bin", executable));
    for (const [platformPackage, targetTriple] of platformCodexPackages()) {
      candidates.add(
        join(
          base,
          "node_modules",
          "@openai",
          platformPackage,
          "vendor",
          targetTriple,
          "codex",
          executable,
        ),
      );
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

function platformCodexPackages(): Array<[string, string]> {
  switch (`${process.platform}:${process.arch}`) {
    case "darwin:arm64":
      return [["codex-darwin-arm64", "aarch64-apple-darwin"]];
    case "darwin:x64":
      return [["codex-darwin-x64", "x86_64-apple-darwin"]];
    case "linux:arm64":
      return [["codex-linux-arm64", "aarch64-unknown-linux-musl"]];
    case "linux:x64":
      return [["codex-linux-x64", "x86_64-unknown-linux-musl"]];
    case "win32:arm64":
      return [["codex-win32-arm64", "aarch64-pc-windows-msvc"]];
    case "win32:x64":
      return [["codex-win32-x64", "x86_64-pc-windows-msvc"]];
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

function copyIfPresent(
  source: Record<string, string | undefined>,
  target: Record<string, string>,
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
