/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { SubprocessJsonlDriver } from "./subprocess-jsonl";
import type { ExternalAgentRunRequest } from "../external-agent-driver";
import type { ExternalAgentEvent } from "../events";
import { mapPermissionPolicyToFlags } from "../permissions/mapper";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema";
import { GEMINI_CLI_PROVIDER } from "../provider/gemini-cli";

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

export interface GeminiCliSubprocess {
  stdout?:
    | AsyncIterable<Uint8Array | string>
    | Iterable<Uint8Array | string>
    | ReadableStream<Uint8Array | string>
    | null;
  stderr?:
    | AsyncIterable<Uint8Array | string>
    | Iterable<Uint8Array | string>
    | ReadableStream<Uint8Array | string>
    | null;
  exited: Promise<number>;
}

export interface GeminiCliSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export type GeminiCliSpawn = (
  command: string,
  args: readonly string[],
  options: GeminiCliSpawnOptions,
) => GeminiCliSubprocess;

export interface GeminiCliDriverConfig {
  command?: string;
  spawn?: GeminiCliSpawn;
  env?: Record<string, string | undefined>;
}

export class GeminiCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: GeminiCliSpawn;
  readonly #env: Record<string, string | undefined>;

  constructor(config: GeminiCliDriverConfig = {}) {
    super({
      providerId: GEMINI_CLI_PROVIDER.id,
      command: config.command ?? GEMINI_CLI_PROVIDER.command ?? "gemini",
    });
    this.#spawn = config.spawn ?? bunSpawn;
    this.#env = config.env ?? process.env;
  }

  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const prompt = buildPrompt(request);
    const args = buildGeminiArgs(prompt, request.permissions);
    const env = buildGeminiEnv(this.#env, request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    const child = this.#spawn(this.command, args, {
      cwd: request.workingDirectory,
      env,
    });

    if (child.stderr) {
      void drainStderr(child.stderr);
    }

    for await (const line of readLines(child.stdout)) {
      const event = this.parseGeminiLine(line);
      if (event) {
        yield event;
      }
    }

    const exitCode = await child.exited;
    if (exitCode === 0) {
      yield { type: "completed", exitCode, timestamp: Date.now() };
      return;
    }

    yield {
      type: "error",
      message: `Gemini CLI exited with code ${exitCode}`,
      code: "GEMINI_CLI_EXIT",
      recoverable: true,
      timestamp: Date.now(),
    };
    yield { type: "completed", exitCode, timestamp: Date.now() };
  }

  parseGeminiLine(line: string): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = JSON.parse(trimmed) as GeminiStreamEvent;
    return normalizeGeminiEvent(parsed);
  }
}

type GeminiStreamEvent =
  | ExternalAgentEvent
  | {
      type?: string;
      event?: string;
      text?: string;
      content?: string;
      message?: string;
      name?: string;
      input?: unknown;
      toolCall?: { name?: string; input?: unknown };
      error?: string | { message?: string; code?: string };
      code?: string;
      exitCode?: number;
      signal?: string;
      providerId?: string;
    };

export function buildGeminiArgs(
  prompt: string,
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    ...mapGeminiPermissionArgs(permissions),
  ];
}

export function mapGeminiPermissionArgs(
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);
  const args: string[] = [];

  if (flags.readOnly) {
    args.push("--approval-mode=plan", "--sandbox");
  } else if (flags.requireApproval) {
    args.push("--approval-mode=default", "--sandbox");
  } else if (flags.workspaceWrite) {
    args.push("--approval-mode=auto_edit", "--sandbox");
  } else if (flags.fullAccess) {
    args.push("--approval-mode=yolo");
  } else {
    args.push("--approval-mode=default", "--sandbox");
  }

  for (const path of flags.paths ?? []) {
    args.push("--include-directories", path);
  }

  return args;
}

function buildPrompt(request: ExternalAgentRunRequest): string {
  return request.instruction ?? "";
}

function buildGeminiEnv(
  processEnv: Record<string, string | undefined>,
  request: ExternalAgentRunRequest,
): Record<string, string> {
  const env: Record<string, string> = {};

  if (processEnv.PATH) {
    env.PATH = processEnv.PATH;
  }
  if (processEnv.HOME) {
    env.HOME = processEnv.HOME;
  }

  const credentialEnv =
    request.credential?.kind === "env" ? request.credential.env : undefined;
  if (credentialEnv) {
    for (const key of request.provider.envAllowlist ?? []) {
      const value = credentialEnv[key];
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }
  }

  return env;
}

function normalizeGeminiEvent(
  event: GeminiStreamEvent,
): ExternalAgentEvent | undefined {
  if (isNormalizedExternalEvent(event)) {
    return event;
  }

  const type = event.type ?? event.event;

  if (type === "content" || type === "output" || type === "message") {
    const content = event.text ?? event.content ?? event.message;
    return typeof content === "string"
      ? { type: "output", content, timestamp: Date.now() }
      : undefined;
  }

  if (type === "tool_call" || type === "tool-call") {
    const name = event.name ?? event.toolCall?.name;
    if (typeof name === "string") {
      return {
        type: "tool_call",
        name,
        input: event.input ?? event.toolCall?.input,
        timestamp: Date.now(),
      };
    }
  }

  if (type === "error") {
    const message =
      typeof event.error === "string"
        ? event.error
        : (event.error?.message ?? event.message ?? "Gemini CLI error");
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

  if (type === "result" || type === "completed" || type === "complete") {
    return {
      type: "completed",
      exitCode: event.exitCode,
      signal: event.signal,
      timestamp: Date.now(),
    };
  }

  return undefined;
}

function isNormalizedExternalEvent(
  event: GeminiStreamEvent,
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

async function* readLines(
  input?:
    | AsyncIterable<Uint8Array | string>
    | Iterable<Uint8Array | string>
    | ReadableStream<Uint8Array | string>
    | null,
): AsyncIterable<string> {
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
      yield buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer;
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

async function drainStderr(
  input:
    | AsyncIterable<Uint8Array | string>
    | Iterable<Uint8Array | string>
    | ReadableStream<Uint8Array | string>,
): Promise<void> {
  for await (const _line of readLines(input)) {
    // Gemini stream-json events are read from stdout. Stderr is drained so the
    // subprocess cannot block if it emits diagnostics.
  }
}

const bunSpawn: GeminiCliSpawn = (command, args, options) => {
  const subprocess = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited,
  };
};
