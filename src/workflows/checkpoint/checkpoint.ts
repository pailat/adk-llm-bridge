/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content } from "@google/genai";
import type {
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "../contracts.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowDefinition } from "../definition.js";
import { hashWorkflowInput, hashWorkflowSource } from "./hash.js";
import {
  WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
  type WorkflowCheckpointV1,
} from "./schema.js";

export interface CreateWorkflowCheckpointInput {
  definition: WorkflowDefinition;
  executionId: string;
  input: unknown;
  now?: number;
}

export interface WorkflowCheckpointExpectation {
  workflowId: string;
  workflowVersion: string;
  executionId: string;
  inputHash: string;
  sourceHash?: string;
}

export async function createWorkflowCheckpoint(
  input: CreateWorkflowCheckpointInput,
): Promise<WorkflowCheckpointV1> {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    workflowId: input.definition.id,
    workflowVersion: input.definition.version,
    executionId: input.executionId,
    inputHash: await hashWorkflowInput(input.input),
    ...(input.definition.kind === "script"
      ? { sourceHash: await hashWorkflowSource(input.definition.source) }
      : {}),
    status: "running",
    steps: {},
    startedAt: now,
    updatedAt: now,
  };
}

export function checkpointExpectation(
  checkpoint: WorkflowCheckpointV1,
): WorkflowCheckpointExpectation {
  return {
    workflowId: checkpoint.workflowId,
    workflowVersion: checkpoint.workflowVersion,
    executionId: checkpoint.executionId,
    inputHash: checkpoint.inputHash,
    ...(checkpoint.sourceHash ? { sourceHash: checkpoint.sourceHash } : {}),
  };
}

export function validateWorkflowCheckpoint(
  checkpoint: WorkflowCheckpointV1,
  expected: WorkflowCheckpointExpectation,
): void {
  if (checkpoint.workflowId !== expected.workflowId) {
    throw mismatch("WORKFLOW_EXECUTION_ERROR", "Workflow id", {
      actual: checkpoint.workflowId,
      expected: expected.workflowId,
    });
  }
  if (checkpoint.executionId !== expected.executionId) {
    throw mismatch("WORKFLOW_EXECUTION_ERROR", "Workflow execution id", {
      actual: checkpoint.executionId,
      expected: expected.executionId,
    });
  }
  if (checkpoint.workflowVersion !== expected.workflowVersion) {
    throw mismatch("WORKFLOW_VERSION_MISMATCH", "Workflow version", {
      actual: checkpoint.workflowVersion,
      expected: expected.workflowVersion,
    });
  }
  if (checkpoint.inputHash !== expected.inputHash) {
    throw mismatch("WORKFLOW_INPUT_MISMATCH", "Workflow input", {
      actual: checkpoint.inputHash,
      expected: expected.inputHash,
    });
  }
  if (checkpoint.sourceHash !== expected.sourceHash) {
    throw mismatch("WORKFLOW_SOURCE_MISMATCH", "Workflow source", {
      actual: checkpoint.sourceHash,
      expected: expected.sourceHash,
    });
  }
}

export type WorkflowStepResolution =
  | { action: "execute"; attempt: number }
  | { action: "replay"; result: WorkflowStepResult };

export function resolveWorkflowStep(
  checkpoint: WorkflowCheckpointV1,
  step: WorkflowStep,
  inputHash: string,
): WorkflowStepResolution {
  const saved = checkpoint.steps[step.id];
  if (!saved) {
    return { action: "execute", attempt: 1 };
  }
  if (saved.agentName !== step.agentName || saved.inputHash !== inputHash) {
    throw new WorkflowError(
      "WORKFLOW_STEP_MISMATCH",
      `Checkpoint step does not match current step: ${step.id}`,
      {
        stepId: step.id,
        savedAgentName: saved.agentName,
        agentName: step.agentName,
        savedInputHash: saved.inputHash,
        inputHash,
      },
    );
  }
  if (saved.status === "completed") {
    if (!saved.result) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Completed checkpoint step has no result: ${step.id}`,
        { stepId: step.id },
      );
    }
    return {
      action: "replay",
      result: { ...saved.result, replayed: true },
    };
  }
  if (step.resumePolicy === "retry") {
    return { action: "execute", attempt: saved.attempts + 1 };
  }
  if (saved.status === "running") {
    throw new WorkflowError(
      "WORKFLOW_INDETERMINATE_STEP",
      `Workflow step may have side effects and cannot be replayed safely: ${step.id}`,
      { stepId: step.id, attempts: saved.attempts },
    );
  }
  throw new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    `Failed workflow step requires resumePolicy "retry": ${step.id}`,
    { stepId: step.id, attempts: saved.attempts },
  );
}

export function withWorkflowStepRunning(
  checkpoint: WorkflowCheckpointV1,
  step: WorkflowStep,
  inputHash: string,
  attempt: number,
  now = Date.now(),
): WorkflowCheckpointV1 {
  const previous = checkpoint.steps[step.id];
  return updateCheckpoint(checkpoint, now, {
    [step.id]: {
      id: step.id,
      agentName: step.agentName,
      inputHash,
      status: "running",
      attempts: attempt,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    },
  });
}

export function withWorkflowStepCompleted(
  checkpoint: WorkflowCheckpointV1,
  result: WorkflowStepResult,
  now = Date.now(),
): WorkflowCheckpointV1 {
  const previous = requireStep(checkpoint, result.id);
  const { replayed: _replayed, ...durableResult } = result;
  return updateCheckpoint(checkpoint, now, {
    [result.id]: {
      ...previous,
      status: "completed",
      attempts: result.attempts,
      result: durableResult,
      error: undefined,
      updatedAt: now,
      completedAt: now,
    },
  });
}

export function withWorkflowStepFailed(
  checkpoint: WorkflowCheckpointV1,
  failure: WorkflowStepFailure,
  now = Date.now(),
): WorkflowCheckpointV1 {
  const previous = requireStep(checkpoint, failure.id);
  return updateCheckpoint(checkpoint, now, {
    [failure.id]: {
      ...previous,
      status: "failed",
      attempts: failure.attempts,
      result: undefined,
      error: failure.error,
      updatedAt: now,
      completedAt: now,
    },
  });
}

export function withWorkflowCompleted(
  checkpoint: WorkflowCheckpointV1,
  output: string | Content | undefined,
  now = Date.now(),
): WorkflowCheckpointV1 {
  return {
    ...checkpoint,
    status: "completed",
    ...(output === undefined ? {} : { output }),
    error: undefined,
    updatedAt: now,
    completedAt: now,
  };
}

export function withWorkflowFailed(
  checkpoint: WorkflowCheckpointV1,
  error: WorkflowSerializedError,
  status: "failed" | "cancelled" = "failed",
  now = Date.now(),
): WorkflowCheckpointV1 {
  return {
    ...checkpoint,
    status,
    error,
    updatedAt: now,
    completedAt: now,
  };
}

function updateCheckpoint(
  checkpoint: WorkflowCheckpointV1,
  now: number,
  steps: WorkflowCheckpointV1["steps"],
): WorkflowCheckpointV1 {
  return {
    ...checkpoint,
    status: "running",
    steps: { ...checkpoint.steps, ...steps },
    updatedAt: now,
    completedAt: undefined,
  };
}

function requireStep(checkpoint: WorkflowCheckpointV1, stepId: string) {
  const step = checkpoint.steps[stepId];
  if (!step) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      `Workflow step was not started: ${stepId}`,
      { stepId },
    );
  }
  return step;
}

function mismatch(
  code:
    | "WORKFLOW_EXECUTION_ERROR"
    | "WORKFLOW_VERSION_MISMATCH"
    | "WORKFLOW_INPUT_MISMATCH"
    | "WORKFLOW_SOURCE_MISMATCH",
  subject: string,
  details: Record<string, unknown>,
): WorkflowError {
  return new WorkflowError(
    code,
    `${subject} does not match checkpoint`,
    details,
  );
}
