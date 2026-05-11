/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { type ExternalAgentEvent, isExternalAgentEvent } from "../events.js";
import type { ExternalAgentRunRequest } from "../external-agent-driver.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CODEX_PROVIDER } from "../provider/codex.js";
import { SubprocessJsonlDriver } from "./subprocess-jsonl.js";

declare const Bun: {
  spawn(
    command: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      stdout: "pipe";
      stderr: "pipe";
    },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
};

export interface CodexCliSpawnOptions {
  cwd?: string;
  env: Record<string, string>;
}

export interface CodexCliSubprocess {
  stdout?: LineSource;
  stderr?: LineSource;
  exited: Promise<number>;
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
}

export class CodexCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: CodexCliSpawn;
  readonly #env: Record<string, string | undefined>;

  constructor(config: CodexCliDriverConfig = {}) {
    super({
      providerId: CODEX_PROVIDER.id,
      command: config.command ?? CODEX_PROVIDER.command ?? "codex",
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnWithBun;
    this.#env = config.env ?? process.env;
  }

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const args = this.buildArgs(request);
    const child = this.#spawn(this.command, args, {
      cwd: request.workingDirectory,
      env: this.buildEnv(request),
    });

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    if (child.stdout) {
      for await (const line of readLines(child.stdout)) {
        if (line.trim().length === 0) {
          continue;
        }
        yield this.parseLine(line);
      }
    }

    if (child.stderr) {
      for await (const line of readLines(child.stderr)) {
        if (line.trim().length === 0 || isIgnorableCodexStderr(line)) {
          continue;
        }
        yield { type: "error", message: line, recoverable: false };
      }
    }

    const exitCode = await child.exited;
    yield { type: "completed", exitCode, timestamp: Date.now() };
  }

  buildArgs(request: ExternalAgentRunRequest): readonly string[] {
    const prompt = buildPrompt(request);
    return [
      ...mapPolicyToCodexArgs(request.permissions),
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

  if (type.includes("error")) {
    return {
      type: "error",
      message:
        stringValue(record.message) ??
        stringValue(record.error) ??
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
    return {
      type: "tool_call",
      name: toolName,
      input: record.input ?? record.arguments,
      timestamp,
    };
  }

  if (type.includes("started") || type.includes("created")) {
    return {
      type: "started",
      providerId: CODEX_PROVIDER.id,
      runId: stringValue(record.run_id) ?? stringValue(record.id),
      timestamp,
    };
  }

  if (type.includes("completed") || type.includes("done")) {
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
    return stringValue(item.name) ?? stringValue(item.tool_name);
  }

  return undefined;
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
  let buffer = "";
  for await (const chunk of toAsyncIterable(source)) {
    buffer +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      yield buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
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

function spawnWithBun(
  command: string,
  args: readonly string[],
  options: CodexCliSpawnOptions,
): CodexCliSubprocess {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
  };
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
