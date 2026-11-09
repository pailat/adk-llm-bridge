import type { Content } from "@google/genai";
import type {
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepInterrupt,
  WorkflowStepResult,
} from "../contracts.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowDefinition } from "../definition.js";
import { hashWorkflowInput, hashWorkflowSource } from "./hash.js";
import {
  WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
  type WorkflowCheckpointV1,
} from "./schema.js";

/** Input to {@link createWorkflowCheckpoint}. */
export interface CreateWorkflowCheckpointInput {
  /** Definition the execution runs; its id, version and (for scripts) source hash are recorded. */
  definition: WorkflowDefinition;
  /** Id of the execution the checkpoint belongs to. */
  executionId: string;
  /** Workflow input; only its hash is stored. */
  input: unknown;
  /**
   * Timestamp in epoch milliseconds for `startedAt` and `updatedAt`.
   *
   * @defaultValue `Date.now()`
   */
  now?: number;
}

/** Identity a stored checkpoint must match before an execution may resume from it. */
export interface WorkflowCheckpointExpectation {
  /** Expected workflow id. */
  workflowId: string;
  /** Expected workflow version. */
  workflowVersion: string;
  /** Expected execution id. */
  executionId: string;
  /** Expected hash of the workflow input. */
  inputHash: string;
  /** Expected hash of the script source; omitted for non-script workflows. */
  sourceHash?: string;
}

/**
 * Creates the initial `running` checkpoint for a workflow execution.
 *
 * @param input - Definition, execution id, workflow input and optional clock.
 * @returns A checkpoint with no steps, carrying the input hash and, for script workflows, the source hash.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the input or source cannot be hashed.
 */
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

/**
 * Derives the expectation that a resume of the same execution must satisfy.
 *
 * @param checkpoint - Checkpoint to copy the identity fields from.
 * @returns The expectation; `sourceHash` is present only when the checkpoint has one.
 */
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

/**
 * Verifies that a stored checkpoint belongs to the execution being resumed.
 *
 * @remarks
 * Resuming against a different definition, version, input or script source
 * would replay results that do not apply, so any difference is rejected.
 *
 * @param checkpoint - Checkpoint loaded from the store.
 * @param expected - Identity the current execution expects.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` for a different workflow id or execution id,
 * or `WORKFLOW_VERSION_MISMATCH`, `WORKFLOW_INPUT_MISMATCH` or `WORKFLOW_SOURCE_MISMATCH`.
 */
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

/** What the runtime does with a step, as decided by {@link resolveWorkflowStep}. */
export type WorkflowStepResolution =
  | { action: "execute"; attempt: number }
  | { action: "replay"; result: WorkflowStepResult }
  /** The step is waiting for input; continue it with the answer. */
  | { action: "resume"; attempt: number; interrupt: WorkflowStepInterrupt };

/**
 * Decides whether a step runs, is replayed from the checkpoint, or resumes after an interrupt.
 *
 * @remarks
 * A `running` step has an unknown outcome and may have had side effects, so it is
 * never re-executed unless its `resumePolicy` is `retry`.
 *
 * @param checkpoint - Checkpoint holding the saved steps.
 * @param step - Step about to run.
 * @param inputHash - Hash of the step input for this run.
 * @param options - `retryFailed` re-runs steps that ended with a recorded failure.
 * @returns The resolution for the step.
 * @throws {@link WorkflowError} with code `WORKFLOW_STEP_MISMATCH` when the saved step used a different agent,
 * agent revision or input; `WORKFLOW_EXECUTION_ERROR` for a completed step without a result or a failed step that
 * cannot be retried; `WORKFLOW_INDETERMINATE_STEP` for a `running` step that cannot be replayed safely.
 */
export function resolveWorkflowStep(
  checkpoint: WorkflowCheckpointV1,
  step: WorkflowStep,
  inputHash: string,
  options: { retryFailed?: boolean } = {},
): WorkflowStepResolution {
  const saved = checkpoint.steps[step.id];
  if (!saved) {
    return { action: "execute", attempt: 1 };
  }
  if (
    saved.agentName !== step.agentName ||
    saved.agentRevision !== step.agentRevision ||
    saved.inputHash !== inputHash
  ) {
    throw new WorkflowError(
      "WORKFLOW_STEP_MISMATCH",
      `Checkpoint step does not match current step: ${step.id}`,
      {
        stepId: step.id,
        savedAgentName: saved.agentName,
        agentName: step.agentName,
        savedAgentRevision: saved.agentRevision,
        agentRevision: step.agentRevision,
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
  if (saved.status === "waiting" && saved.interrupt) {
    return {
      action: "resume",
      attempt: saved.attempts,
      interrupt: saved.interrupt,
    };
  }
  if (step.resumePolicy === "retry") {
    return { action: "execute", attempt: saved.attempts + 1 };
  }
  if (saved.status === "failed" && options.retryFailed === true) {
    // The previous attempt ended with a recorded failure, so re-running it is
    // what the host asked for by enabling retries; `running` steps stay
    // indeterminate because their outcome is unknown.
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

/**
 * Records a step as `running` for the given attempt.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param step - Step being started.
 * @param inputHash - Hash of the step input.
 * @param attempt - Attempt number, starting at 1.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint with the workflow status `running`.
 */
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
      ...(step.agentRevision === undefined
        ? {}
        : { agentRevision: step.agentRevision }),
      inputHash,
      status: "running",
      attempts: attempt,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
    },
  });
}

/**
 * Marks a step as waiting for input.
 *
 * @remarks
 * The original workflow input is kept on the checkpoint until the workflow
 * ends, because the turn that answers the step carries the answer, not the
 * input the checkpoint was created for.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param step - Step that raised the interrupt.
 * @param inputHash - Hash of the step input.
 * @param attempt - Attempt number the interrupt belongs to.
 * @param interrupt - Pending interrupt to persist.
 * @param workflowInput - Original workflow input to keep for the resume turn.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint with the step `waiting`.
 */
export function withWorkflowStepWaiting(
  checkpoint: WorkflowCheckpointV1,
  step: WorkflowStep,
  inputHash: string,
  attempt: number,
  interrupt: WorkflowStepInterrupt,
  workflowInput: Content,
  now = Date.now(),
): WorkflowCheckpointV1 {
  const previous = checkpoint.steps[step.id];
  const updated = updateCheckpoint(checkpoint, now, {
    [step.id]: {
      id: step.id,
      agentName: step.agentName,
      ...(step.agentRevision === undefined
        ? {}
        : { agentRevision: step.agentRevision }),
      inputHash,
      status: "waiting",
      attempts: attempt,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      interrupt,
    },
  });
  return { ...updated, input: workflowInput };
}

/**
 * Records a step as `completed` with its durable result.
 *
 * @remarks
 * Transient `events` and the `replayed` flag are not persisted.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param result - Step result to store.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the step was never started.
 */
export function withWorkflowStepCompleted(
  checkpoint: WorkflowCheckpointV1,
  result: WorkflowStepResult,
  now = Date.now(),
): WorkflowCheckpointV1 {
  const previous = requireStep(checkpoint, result.id);
  const { events: _events, replayed: _replayed, ...durableResult } = result;
  return updateCheckpoint(checkpoint, now, {
    [result.id]: {
      ...previous,
      status: "completed",
      attempts: result.attempts,
      result: durableResult,
      error: undefined,
      interrupt: undefined,
      updatedAt: now,
      completedAt: now,
    },
  });
}

/**
 * Records a step as `failed` with its serialized error.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param failure - Failure to store.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the step was never started.
 */
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
      interrupt: undefined,
      updatedAt: now,
      completedAt: now,
    },
  });
}

/**
 * Marks the whole workflow `completed` and stores its output.
 *
 * @remarks
 * The kept workflow input is dropped because no resume turn can follow.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param output - Final workflow output.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint.
 */
export function withWorkflowCompleted(
  checkpoint: WorkflowCheckpointV1,
  output: string | Content | undefined,
  now = Date.now(),
): WorkflowCheckpointV1 {
  return {
    ...checkpoint,
    status: "completed",
    output,
    input: undefined,
    error: undefined,
    updatedAt: now,
    completedAt: now,
  };
}

/**
 * Marks the whole workflow `failed` or `cancelled` and stores the error.
 *
 * @param checkpoint - Checkpoint to update; it is not mutated.
 * @param error - Serialized error describing the end state.
 * @param status - Terminal status; defaults to `failed`.
 * @param now - Timestamp in epoch milliseconds; defaults to `Date.now()`.
 * @returns A new checkpoint.
 */
export function withWorkflowFailed(
  checkpoint: WorkflowCheckpointV1,
  error: WorkflowSerializedError,
  status: "failed" | "cancelled" = "failed",
  now = Date.now(),
): WorkflowCheckpointV1 {
  return {
    ...checkpoint,
    status,
    output: undefined,
    input: undefined,
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
    output: undefined,
    error: undefined,
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
