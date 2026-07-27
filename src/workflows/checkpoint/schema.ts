/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content } from "@google/genai";
import type {
  WorkflowSerializedError,
  WorkflowStepResult,
} from "../contracts.js";

export const WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type WorkflowCheckpointStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowCheckpointStepStatus = "running" | "completed" | "failed";

export interface WorkflowCheckpointStepV1 {
  id: string;
  agentName: string;
  inputHash: string;
  status: WorkflowCheckpointStepStatus;
  attempts: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  result?: WorkflowStepResult;
  error?: WorkflowSerializedError;
}

/** Durable representation written to ADK session state. */
export interface WorkflowCheckpointV1 {
  schemaVersion: typeof WORKFLOW_CHECKPOINT_SCHEMA_VERSION;
  workflowId: string;
  workflowVersion: string;
  executionId: string;
  inputHash: string;
  /** Present for script workflows; trusted handlers are versioned explicitly. */
  sourceHash?: string;
  status: WorkflowCheckpointStatus;
  steps: Record<string, WorkflowCheckpointStepV1>;
  output?: string | Content;
  error?: WorkflowSerializedError;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function isWorkflowCheckpointV1(
  value: unknown,
): value is WorkflowCheckpointV1 {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    !isNonEmptyString(value.workflowId) ||
    !isNonEmptyString(value.workflowVersion) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.inputHash) ||
    !isCheckpointStatus(value.status) ||
    typeof value.startedAt !== "number" ||
    typeof value.updatedAt !== "number" ||
    !isRecord(value.steps)
  ) {
    return false;
  }

  return Object.entries(value.steps).every(
    ([stepId, step]) => isStep(step) && stepId === step.id,
  );
}

function isStep(value: unknown): value is WorkflowCheckpointStepV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentName) &&
    isNonEmptyString(value.inputHash) &&
    (value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed") &&
    typeof value.attempts === "number" &&
    value.attempts >= 1 &&
    typeof value.startedAt === "number" &&
    typeof value.updatedAt === "number"
  );
}

function isCheckpointStatus(value: unknown): value is WorkflowCheckpointStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
