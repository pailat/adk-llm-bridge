/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/** Lifecycle and output events emitted by external coding-agent runtimes. */
export type ExternalAgentEvent =
  | ExternalAgentStartedEvent
  | ExternalAgentOutputEvent
  | ExternalAgentToolCallEvent
  | ExternalAgentToolResultEvent
  | ExternalAgentErrorEvent
  | ExternalAgentStateDeltaEvent
  | ExternalAgentCompletedEvent;

export interface ExternalAgentStartedEvent {
  type: "started";
  runId?: string;
  providerId: string;
  /**
   * Resolved model id when the runtime reports it (for example the Claude
   * SDK `init.model` or the Codex thread model).
   */
  model?: string;
  timestamp?: number;
}

export interface ExternalAgentOutputEvent {
  type: "output";
  content: string;
  stream?: "stdout" | "stderr";
  partial?: boolean;
  turnComplete?: boolean;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface ExternalAgentToolCallEvent {
  type: "tool_call";
  name: string;
  input?: unknown;
  callId?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface ExternalAgentToolResultEvent {
  type: "tool_result";
  name: string;
  result: unknown;
  callId?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface ExternalAgentErrorEvent {
  type: "error";
  message: string;
  code?: string;
  recoverable?: boolean;
  timestamp?: number;
}

export interface ExternalAgentStateDeltaEvent {
  type: "state_delta";
  stateDelta: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Token usage and cost reported by an external runtime for one run. Drivers
 * leave out what the runtime does not report; they never send zeros for
 * unknown values.
 */
export interface ExternalAgentUsage {
  /**
   * Input tokens NOT served from or written to the prompt cache (Anthropic
   * semantics). A runtime that reports cached tokens inside its input count
   * (OpenAI/Codex `input_tokens` includes `cached_input_tokens`) subtracts
   * them here. The prompt size is `inputTokens + cacheReadInputTokens +
   * cacheCreationInputTokens`.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens read from the prompt cache. */
  cacheReadInputTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
  /** Per-model breakdown when the runtime reports several models. */
  byModel?: Record<string, Omit<ExternalAgentUsage, "byModel">>;
}

export interface ExternalAgentCompletedEvent {
  type: "completed";
  exitCode?: number;
  signal?: string;
  /** Resolved model id when the runtime reports it. */
  model?: string;
  usage?: ExternalAgentUsage;
  /** Number of model turns the runtime reports for the run. */
  numTurns?: number;
  /** Run duration the runtime reports, in milliseconds. */
  durationMs?: number;
  timestamp?: number;
}

export function isExternalAgentEvent(
  value: unknown,
): value is ExternalAgentEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "started" ||
    type === "output" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "error" ||
    type === "state_delta" ||
    type === "completed"
  );
}
