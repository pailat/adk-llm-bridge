/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { ExternalAgentEvent } from "../events.js";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";

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

type CodexSdkThreadLike = {
  runStreamed(
    input: string,
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
    const sdk = await this.loadSdk(request);
    const thread = sdk.startThread(this.buildThreadOptions(request));
    const prompt = buildPrompt(request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    let completed = false;
    try {
      const { events } = await thread.runStreamed(prompt, {
        signal: request.context.abortSignal,
        outputSchema: this.#outputSchema,
      });
      for await (const event of events) {
        for (const normalized of this.normalizeEvent(event)) {
          if (normalized.type === "completed") {
            completed = true;
          }
          yield normalized;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: "CODEX_SDK_ERROR",
        recoverable: true,
        timestamp: Date.now(),
      };
    }

    if (!completed) {
      yield { type: "completed", exitCode: 0, timestamp: Date.now() };
    }
  }

  buildClientOptions(request: ExternalAgentRunRequest): CodexSdkOptions {
    return removeUndefined({
      codexPathOverride: this.#codexPathOverride,
      baseUrl: this.#baseUrl,
      apiKey: this.#apiKey ?? readCredentialEnv(request, "CODEX_API_KEY"),
      config: this.#config,
      env: this.buildEnv(request),
    }) as CodexSdkOptions;
  }

  buildThreadOptions(request: ExternalAgentRunRequest): CodexSdkThreadOptions {
    return removeUndefined({
      ...mapPolicyToCodexSdkThreadOptions(request.permissions),
      model: this.#model,
      workingDirectory: request.workingDirectory,
      skipGitRepoCheck: this.#skipGitRepoCheck,
      modelReasoningEffort: this.#modelReasoningEffort,
      webSearchMode: this.#webSearchMode,
      webSearchEnabled: this.#webSearchEnabled,
    }) as CodexSdkThreadOptions;
  }

  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    const env: Record<string, string> = {};
    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");
    copyIfPresent(this.#env, env, "XDG_CONFIG_HOME");

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
      return [
        {
          type: "error",
          message: stringValue(error.message) ?? "Codex turn failed",
          code: "CODEX_TURN_FAILED",
          recoverable: true,
          timestamp,
        },
        { type: "completed", exitCode: 1, timestamp },
      ];
    }

    if (type === "error") {
      return [
        {
          type: "error",
          message: stringValue(event.message) ?? "Codex SDK error",
          code: "CODEX_SDK_STREAM_ERROR",
          recoverable: true,
          timestamp,
        },
      ];
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
    return [
      {
        type: "error",
        message: stringValue(item.message) ?? "Codex item error",
        code: "CODEX_ITEM_ERROR",
        recoverable: true,
        timestamp,
      },
    ];
  }

  if (itemType === "mcp_tool_call") {
    return [
      {
        type: "tool_call",
        name: stringValue(item.tool) ?? "mcp_tool_call",
        input: {
          server: item.server,
          arguments: item.arguments,
          status: item.status,
          result: item.result,
          error: item.error,
        },
        timestamp,
      },
    ];
  }

  if (itemType === "command_execution") {
    return [
      {
        type: "tool_call",
        name: "command_execution",
        input: {
          command: item.command,
          status: item.status,
          exitCode: item.exit_code,
        },
        timestamp,
      },
    ];
  }

  return [];
}

function buildPrompt(request: ExternalAgentRunRequest): string {
  const parts = [
    request.instruction,
    extractContextText(request.context),
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.join("\n\n");
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
