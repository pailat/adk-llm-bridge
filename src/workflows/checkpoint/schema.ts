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
import { MAX_WORKFLOW_AGENT_REVISION_LENGTH } from "../contracts.js";

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
  agentRevision?: string;
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
  try {
    return isWorkflowCheckpointV1Value(value);
  } catch {
    return false;
  }
}

function isWorkflowCheckpointV1Value(
  value: unknown,
): value is WorkflowCheckpointV1 {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (hasAccessorProperty(value)) return false;
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    !isNonEmptyString(value.workflowId) ||
    !isNonEmptyString(value.workflowVersion) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.inputHash) ||
    (value.sourceHash !== undefined && !isNonEmptyString(value.sourceHash)) ||
    !isCheckpointStatus(value.status) ||
    !isFiniteNumber(value.startedAt) ||
    !isFiniteNumber(value.updatedAt) ||
    value.updatedAt < value.startedAt ||
    !isOptionalFiniteNumber(value.completedAt) ||
    (typeof value.completedAt === "number" &&
      value.completedAt < value.startedAt) ||
    !isPlainRecord(value.steps) ||
    !isWorkflowOutput(value.output) ||
    (value.error !== undefined && !isSerializedError(value.error))
  ) {
    return false;
  }

  if (
    value.status === "completed" &&
    (value.completedAt === undefined || value.error !== undefined)
  ) {
    return false;
  }
  if (
    (value.status === "failed" || value.status === "cancelled") &&
    (value.completedAt === undefined || !isSerializedError(value.error))
  ) {
    return false;
  }
  if (value.status === "running" && value.completedAt !== undefined) {
    return false;
  }

  if (
    !Object.entries(value.steps).every(([stepId, step]) => isStep(step, stepId))
  ) {
    return false;
  }

  // Unknown JSON-safe fields remain accepted for forward compatibility, while
  // the complete durable graph still rejects cycles, exotic prototypes, and
  // accessors. Legacy runtime fields are removed before this final check.
  return isJsonSafe(
    toDurableWorkflowCheckpoint(value as unknown as WorkflowCheckpointV1),
    new Set(),
    true,
  );
}

/** Removes runtime-only fields while preserving the v1 durable shape. */
export function toDurableWorkflowCheckpoint(
  checkpoint: WorkflowCheckpointV1,
): WorkflowCheckpointV1 {
  let changed = false;
  const steps = Object.fromEntries(
    Object.entries(checkpoint.steps).map(([stepId, step]) => {
      if (!step.result) return [stepId, step];
      const { events: _events, replayed: _replayed, ...result } = step.result;
      if (!("events" in step.result) && !("replayed" in step.result)) {
        return [stepId, step];
      }
      changed = true;
      return [stepId, { ...step, result }];
    }),
  );
  return changed ? { ...checkpoint, steps } : checkpoint;
}

function isStep(
  value: unknown,
  stepId: string,
): value is WorkflowCheckpointStepV1 {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (hasAccessorProperty(value)) return false;
  if (
    value.id === stepId &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentName) &&
    (value.agentRevision === undefined ||
      isBoundedRevision(value.agentRevision)) &&
    isNonEmptyString(value.inputHash) &&
    (value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed") &&
    Number.isSafeInteger(value.attempts) &&
    (value.attempts as number) >= 1 &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.updatedAt) &&
    value.updatedAt >= value.startedAt &&
    isOptionalFiniteNumber(value.completedAt)
  ) {
    if (
      value.status === "running" &&
      (value.result !== undefined ||
        value.error !== undefined ||
        value.completedAt !== undefined)
    ) {
      return false;
    }
    if (
      value.status === "completed" &&
      (value.completedAt === undefined ||
        value.error !== undefined ||
        !isStepResult(value.result, value))
    ) {
      return false;
    }
    if (
      value.status === "failed" &&
      (value.completedAt === undefined ||
        value.result !== undefined ||
        !isSerializedError(value.error))
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function isBoundedRevision(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value === value.trim() &&
    !value.includes("\0") &&
    value.length <= MAX_WORKFLOW_AGENT_REVISION_LENGTH
  );
}

function isStepResult(
  value: unknown,
  step: Record<string, unknown>,
): value is WorkflowStepResult {
  if (!isPlainRecord(value)) return false;
  if (hasAccessorProperty(value)) return false;
  const { events: _events, replayed: _replayed, ...durableValue } = value;
  return (
    isJsonSafe(durableValue, new Set(), true) &&
    value.status === "completed" &&
    value.id === step.id &&
    value.agentName === step.agentName &&
    typeof value.output === "string" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts === step.attempts &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.completedAt) &&
    value.completedAt >= value.startedAt &&
    (value.replayed === undefined || typeof value.replayed === "boolean") &&
    (value.events === undefined || Array.isArray(value.events)) &&
    isWorkflowContent(value.content) &&
    (value.stateDelta === undefined ||
      (isPlainRecord(value.stateDelta) && isJsonSafe(value.stateDelta)))
  );
}

function isSerializedError(value: unknown): value is WorkflowSerializedError {
  return (
    isPlainRecord(value) &&
    !hasAccessorProperty(value) &&
    isJsonSafe(value) &&
    isWorkflowErrorCode(value.code) &&
    isNonEmptyString(value.message) &&
    (value.details === undefined ||
      (isPlainRecord(value.details) && isJsonSafe(value.details)))
  );
}

function isWorkflowErrorCode(value: unknown): boolean {
  return (
    value === "WORKFLOW_ABORTED" ||
    value === "WORKFLOW_ATTEMPT_MISMATCH" ||
    value === "WORKFLOW_DEFINITION_INVALID" ||
    value === "WORKFLOW_EXECUTION_ERROR" ||
    value === "WORKFLOW_INDETERMINATE_STEP" ||
    value === "WORKFLOW_INPUT_MISMATCH" ||
    value === "WORKFLOW_LIMIT_EXCEEDED" ||
    value === "WORKFLOW_SANDBOX_UNAVAILABLE" ||
    value === "WORKFLOW_SCRIPT_INVALID" ||
    value === "WORKFLOW_SOURCE_MISMATCH" ||
    value === "WORKFLOW_STEP_MISMATCH" ||
    value === "WORKFLOW_UNKNOWN_AGENT" ||
    value === "WORKFLOW_VERSION_MISMATCH" ||
    value === "WORKFLOW_WORKSPACE_LEASE_LOST"
  );
}

function isWorkflowOutput(value: unknown): boolean {
  return value === undefined || isJsonSafe(value, new Set(), true);
}

function isWorkflowContent(value: unknown): boolean {
  return value === undefined || isContent(value);
}

function isContent(value: unknown): value is Content {
  return (
    isPlainRecord(value) &&
    !hasAccessorProperty(value) &&
    Array.isArray(value.parts) &&
    isJsonSafe(value, new Set(), true)
  );
}

function isJsonSafe(
  value: unknown,
  seen = new Set<object>(),
  allowUndefinedProperties = false,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;

  seen.add(value);
  let safe: boolean;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const toJSON = descriptors.toJSON;
    if (
      hasAccessorProperty(value) ||
      (toJSON && typeof toJSON.value === "function")
    ) {
      seen.delete(value);
      return false;
    }
    safe = true;
    for (let index = 0; index < value.length; index++) {
      if (
        !Object.hasOwn(value, index) ||
        !isJsonSafe(value[index], seen, allowUndefinedProperties)
      ) {
        safe = false;
        break;
      }
    }
  } else {
    if (hasAccessorProperty(value)) {
      seen.delete(value);
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const toJSON = descriptors.toJSON;
    if (toJSON && (toJSON.get || typeof toJSON.value === "function")) {
      seen.delete(value);
      return false;
    }
    safe = Object.values(descriptors).every(
      (descriptor) =>
        !descriptor.enumerable ||
        (descriptor.value === undefined
          ? allowUndefinedProperties
          : isJsonSafe(descriptor.value, seen, allowUndefinedProperties)),
    );
  }
  seen.delete(value);
  return safe;
}

function hasAccessorProperty(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) =>
      descriptor.get !== undefined || descriptor.set !== undefined,
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
