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
  timestamp?: number;
}

export interface ExternalAgentToolCallEvent {
  type: "tool_call";
  name: string;
  input?: unknown;
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
    type === "error" ||
    type === "completed"
  );
}
