/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CLAUDE_PROVIDER } from "../provider/schema.js";
import {
  claudeResultSummary,
  type ExternalAgentRunSummary,
} from "./run-summary.js";
import { asRecord, copyIfPresent, stringValue } from "./shared.js";
import { spawnSubprocess, superviseSubprocess } from "./spawn.js";
import { SubprocessJsonlDriver } from "./subprocess-jsonl.js";

export interface ClaudeCliSubprocess {
  stdout?: LineSource | null;
  stderr?: LineSource | null;
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. Optional for custom spawns; the default spawn
   * always provides it.
   */
  kill?: () => void;
}

export interface ClaudeCliSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export type LineSource =
  | ReadableStream<Uint8Array | string>
  | AsyncIterable<Uint8Array | string>
  | Iterable<Uint8Array | string>;

export type ClaudeCliSpawn = (
  command: string,
  args: readonly string[],
  options: ClaudeCliSpawnOptions,
) => ClaudeCliSubprocess;

export interface ClaudeCliDriverConfig {
  command?: string;
  args?: readonly string[];
  spawn?: ClaudeCliSpawn;
  env?: Record<string, string | undefined>;
}

export class ClaudeCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: ClaudeCliSpawn;
  readonly #env: Record<string, string | undefined>;

  constructor(config: ClaudeCliDriverConfig = {}) {
    super({
      providerId: CLAUDE_PROVIDER.id,
      command: config.command ?? CLAUDE_PROVIDER.command ?? "claude",
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#env = config.env ?? process.env;
  }

  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const args = this.buildArgs(request);
    const env = this.buildEnv(request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }

    const child = this.#spawn(this.command, args, {
      cwd: request.workingDirectory,
      env,
    });
    const supervisor = superviseSubprocess(child, signal);

    try {
      const stderrLines: string[] = [];
      const stderrPromise = child.stderr
        ? collectLines(child.stderr, stderrLines)
        : Promise.resolve();

      // Claude Code repeats the final assistant text in `result.result`.
      // Emit it only when no assistant text was streamed (as the SDK driver
      // does with `emittedOutput`), otherwise the answer appears twice.
      let emittedAssistantText = false;
      // F1: the `result` line reports model, usage, cost, turns and duration;
      // they go on the `completed` event.
      let summary: ExternalAgentRunSummary = {};
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        const parsed = this.parseClaudeStreamLine(line);
        if (!parsed) {
          continue;
        }
        if (parsed.source === "result") {
          summary = parsed.summary;
          if (parsed.event.type === "completed") {
            parsed.event = { ...summary, ...parsed.event };
          }
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
      }
      if (signal?.aborted) {
        return;
      }

      const exitCode = await child.exited;
      supervisor.markExited();
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }

      if (exitCode === 0) {
        yield {
          type: "completed",
          exitCode,
          ...summary,
          timestamp: Date.now(),
        };
        return;
      }

      yield {
        type: "error",
        message:
          stderrLines.join("\n").trim() ||
          `Claude CLI exited with code ${exitCode}`,
        code: "CLAUDE_CLI_EXIT",
        recoverable: true,
        timestamp: Date.now(),
      };
      yield { type: "completed", exitCode, ...summary, timestamp: Date.now() };
    } finally {
      supervisor.release();
    }
  }

  buildArgs(request: ExternalAgentRunRequest): readonly string[] {
    return [
      "-p",
      buildPrompt(request),
      "--output-format",
      "stream-json",
      "--verbose",
      ...mapClaudePermissionArgs(request.permissions),
      ...this.args,
    ];
  }

  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    const env: Record<string, string> = {};

    copyIfPresent(this.#env, env, "PATH");
    copyIfPresent(this.#env, env, "HOME");
    copyIfPresent(this.#env, env, "USER");
    copyIfPresent(this.#env, env, "SHELL");

    // These provider-native config variables allow Claude Code to use its
    // existing local OAuth/native login cache without the bridge storing secrets.
    copyIfPresent(this.#env, env, "CLAUDE_CONFIG_DIR");
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

  parseClaudeLine(line: string): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = JSON.parse(trimmed) as ClaudeStreamEvent;
    return normalizeClaudeEvent(parsed);
  }

  private parseClaudeStreamLine(line: string):
    | {
        event: ExternalAgentEvent;
        source: ClaudeEventSource;
        summary: ExternalAgentRunSummary;
      }
    | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = JSON.parse(trimmed) as ClaudeStreamEvent;
    const event = normalizeClaudeEvent(parsed);
    if (!event) {
      return undefined;
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

type ClaudeStreamEvent =
  | ExternalAgentEvent
  | {
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
      error?: string | { message?: string; code?: string };
      code?: string;
      exitCode?: number;
      signal?: string;
      session_id?: string;
      providerId?: string;
    };

export function mapClaudePermissionArgs(
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);
  const args: string[] = [];

  if (flags.readOnly) {
    args.push("--permission-mode", "plan");
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
  if (isNormalizedExternalEvent(event)) {
    return event;
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
    const resultText = stringValue(event.result);
    if (resultText) {
      return { type: "output", content: resultText, timestamp: Date.now() };
    }
    return {
      type: "completed",
      exitCode: event.exitCode,
      signal: event.signal,
      timestamp: Date.now(),
    };
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
    const message =
      typeof event.error === "string"
        ? event.error
        : (event.error?.message ??
          stringValue(event.message) ??
          "Claude CLI error");
    const code =
      typeof event.error === "object" ? event.error.code : event.code;
    return {
      type: "error",
      message,
      code,
      recoverable: true,
      timestamp: Date.now(),
    };
  }

  const fallbackText = extractText(event);
  return fallbackText
    ? { type: "output", content: fallbackText, timestamp: Date.now() }
    : undefined;
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

function isNormalizedExternalEvent(
  event: ClaudeStreamEvent,
): event is ExternalAgentEvent {
  switch (event.type) {
    case "started":
      return typeof event.providerId === "string";
    case "output":
      return typeof event.content === "string";
    case "tool_call":
      return typeof event.name === "string";
    case "error":
      return typeof event.message === "string";
    case "completed":
      return true;
    default:
      return false;
  }
}

async function collectLines(
  input: LineSource,
  target: string[],
): Promise<void> {
  for await (const line of readLines(input)) {
    if (line.trim().length > 0) {
      target.push(line);
    }
  }
}

async function* readLines(input?: LineSource | null): AsyncIterable<string> {
  if (!input) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of toAsyncIterable(input)) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.replace(/\r$/, "");
  }
}

async function* toAsyncIterable<T>(
  input: AsyncIterable<T> | Iterable<T> | ReadableStream<T>,
): AsyncIterable<T> {
  const asyncIterable = input as AsyncIterable<T>;
  if (typeof asyncIterable[Symbol.asyncIterator] === "function") {
    yield* asyncIterable;
    return;
  }

  const iterable = input as Iterable<T>;
  if (typeof iterable[Symbol.iterator] === "function") {
    yield* iterable;
    return;
  }

  const reader = (input as ReadableStream<T>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
