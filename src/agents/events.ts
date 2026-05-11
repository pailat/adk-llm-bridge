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
  | ExternalAgentCompletedEvent;

export interface ExternalAgentStartedEvent {
  type: "started";
  runId?: string;
  providerId: string;
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

export interface ExternalAgentCompletedEvent {
  type: "completed";
  exitCode?: number;
  signal?: string;
  timestamp?: number;
}

export function isExternalAgentEvent(value: unknown): value is ExternalAgentEvent {
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
    type === "completed"
  );
}
