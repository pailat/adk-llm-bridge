/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalAgentEvent } from "../events.js";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
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

type ClaudeAgentSdkLike = {
  query(params: {
    prompt: string | AsyncIterable<unknown>;
    options?: ClaudeAgentSdkOptions;
  }): AsyncIterable<ClaudeAgentSdkMessage>;
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
  readonly #settingSources?: ClaudeAgentSdkSettingSource[];
  readonly #maxTurns?: number;
  readonly #model?: string;
  readonly #debugEvents: boolean;
  readonly #resumeSessionId?: string;
  readonly #forkSession?: boolean;

  constructor(config: ClaudeAgentSdkDriverConfig = {}) {
    this.#sdk = config.sdk;
    this.#importSdk = config.importSdk ?? importClaudeAgentSdk;
    this.#env = config.env ?? process.env;
    this.#pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable;
    this.#executableSearchPaths = config.executableSearchPaths ?? [];
    this.#settingSources = config.settingSources;
    this.#maxTurns = config.maxTurns;
    this.#model = config.model;
    this.#debugEvents = config.debugEvents ?? false;
    this.#resumeSessionId = config.resumeSessionId;
    this.#forkSession = config.forkSession;
  }

  async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    const sdk = await this.loadSdk();
    const prompt = this.buildPromptInput(request);
    const options = await this.buildOptionsForRun(request, sdk);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    let completed = false;
    let failed = false;
    try {
      for await (const message of sdk.query({ prompt, options })) {
        const events = this.normalizeMessage(message);
        for (const event of events) {
          if (event.type === "completed") {
            completed = true;
          }
          yield event;
        }
      }
    } catch (error) {
      failed = true;
      yield {
        type: "error",
        message: this.describeError(error, request),
        code: "CLAUDE_AGENT_SDK_ERROR",
        recoverable: true,
        timestamp: Date.now(),
      };
    }

    if (!completed) {
      yield { type: "completed", exitCode: failed ? 1 : 0, timestamp: Date.now() };
    }
  }

  buildOptions(request: ExternalAgentRunRequest): ClaudeAgentSdkOptions {
    const permission = mapPolicyToClaudeSdkPermission(request.permissions);
    const options: ClaudeAgentSdkOptions = {
      cwd: request.workingDirectory,
      env: this.buildEnv(request),
      permissionMode: permission.permissionMode,
      additionalDirectories: request.permissions?.allowedPaths
        ? [...request.permissions.allowedPaths]
        : undefined,
      pathToClaudeCodeExecutable: this.resolveClaudeExecutable(request).path,
      settingSources: this.#settingSources,
      maxTurns: this.#maxTurns,
      model: this.#model,
      systemPrompt: request.instruction
        ? { type: "preset", preset: "claude_code", append: request.instruction }
        : { type: "preset", preset: "claude_code" },
      allowDangerouslySkipPermissions: permission.allowDangerouslySkipPermissions,
      resume: this.#resumeSessionId,
      forkSession: this.#forkSession,
    };

    return removeUndefined(options) as ClaudeAgentSdkOptions;
  }

  /**
   * Build the SDK `prompt` input from a run request. Returns:
   * - a plain string for text-only single-turn invocations (fast path);
   * - an `AsyncIterable<SDKUserMessage>` carrying lossless multimodal blocks
   *   for multi-turn or multimodal history;
   * - an empty string when no content can be collected (defensive fallback).
   *
   * When `resumeSessionId` is configured, only the last collected `Content`
   * is sent so the resumed session continues from existing transcript on disk
   * rather than re-feeding history.
   */
  buildPromptInput(
    request: ExternalAgentRunRequest,
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

    if (this.#resumeSessionId) {
      const last = contents[contents.length - 1];
      const messages = contentsToSdkMessages([last]);
      return asyncIterable(messages);
    }

    if (contents.length === 1) {
      const onlyTextParts = (contents[0].parts ?? []).every(
        (part) => typeof part.text === "string" && !part.thought,
      );
      if (onlyTextParts) {
        return buildPrompt(request);
      }
    }

    const messages = contentsToSdkMessages(contents);
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

  normalizeMessage(message: ClaudeAgentSdkMessage): ExternalAgentEvent[] {
    const record = asRecord(message);
    const type = stringValue(record.type);

    if (type === "assistant") {
      const error = stringValue(record.error);
      if (error) {
        return [
          {
            type: "error",
            message: error,
            code: error,
            recoverable: true,
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
      return [
        {
          type: "error",
          message: errors.join("\n") || `Claude Agent SDK result: ${String(record.subtype ?? "error")}`,
          code: stringValue(record.subtype),
          recoverable: true,
          timestamp: Date.now(),
        },
        { type: "completed", exitCode: 1, timestamp: Date.now() },
      ];
    }

    if (type === "auth_status") {
      const error = stringValue(record.error);
      return error
        ? [{ type: "error", message: error, code: "CLAUDE_AUTH_STATUS", recoverable: true, timestamp: Date.now() }]
        : [];
    }

    if (type === "system" && record.subtype === "permission_denied") {
      return [
        {
          type: "error",
          message: stringValue(record.message) ?? "Claude permission denied",
          code: "CLAUDE_PERMISSION_DENIED",
          recoverable: true,
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
  ): Promise<ClaudeAgentSdkOptions> {
    const options = this.buildOptions(request);
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
    return { permissionMode: "plan" };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
