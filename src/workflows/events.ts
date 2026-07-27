/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content } from "@google/genai";
import type {
  WorkflowExecutionSummary,
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "./contracts.js";

export interface WorkflowEventBase {
  workflowId: string;
  workflowVersion: string;
  executionId: string;
  timestamp: number;
}

export interface WorkflowStartedEvent extends WorkflowEventBase {
  type: "workflow_started";
}

export interface WorkflowStepStartedEvent extends WorkflowEventBase {
  type: "step_started";
  step: WorkflowStep;
  attempt: number;
}

export interface WorkflowStepCompletedEvent extends WorkflowEventBase {
  type: "step_completed";
  result: WorkflowStepResult;
}

export interface WorkflowStepFailedEvent extends WorkflowEventBase {
  type: "step_failed";
  failure: WorkflowStepFailure;
}

export interface WorkflowStepReplayedEvent extends WorkflowEventBase {
  type: "step_replayed";
  result: WorkflowStepResult;
}

export interface WorkflowCheckpointSavedEvent extends WorkflowEventBase {
  type: "checkpoint_saved";
  checkpointKey: string;
  stepId?: string;
}

export interface WorkflowOutputEvent extends WorkflowEventBase {
  type: "output";
  content: string | Content;
  partial?: boolean;
}

export interface WorkflowErrorEvent extends WorkflowEventBase {
  type: "error";
  error: WorkflowSerializedError;
}

export interface WorkflowCompletedEvent extends WorkflowEventBase {
  type: "workflow_completed";
  summary: WorkflowExecutionSummary;
}

export interface WorkflowCustomEvent extends WorkflowEventBase {
  type: "custom";
  name: string;
  data?: unknown;
}

/** Event accepted from trusted or sandboxed workflow code via `ctx.emit`. */
export interface WorkflowUserEvent {
  type: "custom";
  name: string;
  data?: unknown;
}

/** Lifecycle, output, checkpoint, and user events emitted by a workflow runtime. */
export type WorkflowEvent =
  | WorkflowStartedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepCompletedEvent
  | WorkflowStepFailedEvent
  | WorkflowStepReplayedEvent
  | WorkflowCheckpointSavedEvent
  | WorkflowOutputEvent
  | WorkflowErrorEvent
  | WorkflowCompletedEvent
  | WorkflowCustomEvent;

const WORKFLOW_EVENT_TYPES = new Set<WorkflowEvent["type"]>([
  "workflow_started",
  "step_started",
  "step_completed",
  "step_failed",
  "step_replayed",
  "checkpoint_saved",
  "output",
  "error",
  "workflow_completed",
  "custom",
]);

export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkflowEventBase> & { type?: unknown };
  return (
    typeof candidate.type === "string" &&
    WORKFLOW_EVENT_TYPES.has(candidate.type as WorkflowEvent["type"]) &&
    typeof candidate.workflowId === "string" &&
    typeof candidate.workflowVersion === "string" &&
    typeof candidate.executionId === "string" &&
    typeof candidate.timestamp === "number"
  );
}
