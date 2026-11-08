/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { type ExternalAgentEvent, isExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import { asRecord, copyIfPresent, stringValue } from "./shared.js";
import { spawnSubprocess, superviseSubprocess } from "./spawn.js";
import { SubprocessJsonlDriver } from "./subprocess-jsonl.js";

export interface CodexCliSpawnOptions {
  cwd?: string;
  env: Record<string, string>;
}

export interface CodexCliSubprocess {
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

export type LineSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>;

export type CodexCliSpawn = (
  command: string,
  args: readonly string[],
  options: CodexCliSpawnOptions,
) => CodexCliSubprocess;

export interface CodexCliDriverConfig {
  command?: string;
  args?: readonly string[];
  spawn?: CodexCliSpawn;
  env?: Record<string, string | undefined>;
  /**
   * Pass `--skip-git-repo-check` to `codex exec`, allowing runs outside a
   * git repository (for example a temp directory). Off by default, matching
   * the Codex SDK driver option of the same name.
   */
  skipGitRepoCheck?: boolean;
}

export class CodexCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: CodexCliSpawn;
  readonly #env: Record<string, string | undefined>;
  readonly #skipGitRepoCheck: boolean;

  constructor(config: CodexCliDriverConfig = {}) {
    super({
      providerId: CODEX_PROVIDER.id,
      command: config.command ?? CODEX_PROVIDER.command ?? "codex",
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#env = config.env ?? process.env;
    this.#skipGitRepoCheck = config.skipGitRepoCheck ?? false;
  }

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const args = this.buildArgs(request);
    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }
    const child = this.#spawn(this.command, args, {
      cwd: request.workingDirectory,
      env: this.buildEnv(request),
    });
    const supervisor = superviseSubprocess(child, signal);

    try {
      yield {
        type: "started",
        providerId: this.providerId,
        timestamp: Date.now(),
      };

      // Drain stderr while stdout is read so a chatty stderr cannot fill its
      // pipe and stall the process; its lines are reported after stdout.
      const stderrLines: string[] = [];
      const stderrPromise = child.stderr
        ? collectLines(child.stderr, stderrLines)
        : Promise.resolve();

      if (child.stdout) {
        for await (const line of readLines(child.stdout)) {
          if (signal?.aborted) {
            return;
          }
          if (line.trim().length === 0) {
            continue;
          }
          yield this.parseLine(line);
        }
      }
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }

      for (const line of stderrLines) {
        if (isIgnorableCodexStderr(line)) {
          continue;
        }
        yield { type: "error", message: line, recoverable: false };
      }

      const exitCode = await child.exited;
      supervisor.markExited();
      if (signal?.aborted) {
        return;
      }
      yield { type: "completed", exitCode, timestamp: Date.now() };
    } finally {
      supervisor.release();
    }
  }

  buildArgs(request: ExternalAgentRunRequest): readonly string[] {
    const prompt = buildPrompt(request);
    return [
      ...mapPolicyToCodexArgs(request.permissions),
      ...(this.#skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      ...this.args,
      prompt,
    ];
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

  override parseLine(line: string): ExternalAgentEvent {
    const parsed = JSON.parse(line) as unknown;
    if (isExternalAgentEvent(parsed)) {
      return parsed;
    }
    return normalizeCodexEvent(parsed);
  }
}

export function mapPolicyToCodexArgs(
  policy: ExternalAgentPermissionPolicy = { mode: "read-only" },
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

function normalizeCodexEvent(value: unknown): ExternalAgentEvent {
  const record = asRecord(value);
  const type =
    stringValue(record.type) ?? stringValue(record.event) ?? "unknown";
  const timestamp = numberValue(record.timestamp);

  // `codex exec --json` ends a failed turn with `turn.failed`
  // ({ error: { message } }), which does not contain the word "error".
  if (type.includes("error") || type.includes("failed")) {
    return {
      type: "error",
      message:
        stringValue(record.message) ??
        stringValue(record.error) ??
        stringValue(asRecord(record.error).message) ??
        JSON.stringify(value),
      code: stringValue(record.code),
      recoverable: false,
      timestamp,
    };
  }

  const item = asRecord(record.item);
  const itemType = stringValue(item.type);
  if (itemType === "agent_message") {
    return {
      type: "output",
      content: extractText(item) ?? JSON.stringify(item),
      stream: "stdout",
      timestamp,
    };
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
        timestamp,
      };
    }
    return {
      type: "tool_call",
      name: toolName,
      input: record.input ?? record.arguments ?? item.input ?? item.arguments,
      callId: stringValue(item.id),
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
    return {
      type: "completed",
      exitCode: numberValue(record.exit_code),
      timestamp,
    };
  }

  return {
    type: "output",
    content: extractText(value) ?? JSON.stringify(value),
    stream: "stdout",
    timestamp,
  };
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

async function* readLines(source: LineSource): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of toAsyncIterable(source)) {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
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

async function* toAsyncIterable(
  source: LineSource,
): AsyncIterable<Uint8Array | string> {
  const maybeReadableStream = source as Partial<ReadableStream<Uint8Array>>;
  if (typeof maybeReadableStream.getReader === "function") {
    const reader = maybeReadableStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  }

  const maybeAsyncIterable = source as Partial<
    AsyncIterable<Uint8Array | string>
  >;
  if (typeof maybeAsyncIterable[Symbol.asyncIterator] === "function") {
    yield* source as AsyncIterable<Uint8Array | string>;
  }
}

function isIgnorableCodexStderr(line: string): boolean {
  return line.trim() === "Reading additional input from stdin...";
}

async function collectLines(
  source: LineSource,
  target: string[],
): Promise<void> {
  for await (const line of readLines(source)) {
    if (line.trim().length > 0) {
      target.push(line);
    }
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
