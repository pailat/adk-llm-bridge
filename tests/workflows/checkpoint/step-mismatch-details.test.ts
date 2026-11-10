import { describe, expect, test } from "bun:test";
import {
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import { hashWorkflowInput } from "../../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowError,
  type WorkflowStepFailure,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";

const definition = defineWorkflow({
  id: "mismatch-details",
  version: "1",
  handler: async () => "unused",
});

const step = { id: "review", agentName: "worker", input: "original" };

async function base(): Promise<WorkflowCheckpointV1> {
  return createWorkflowCheckpoint({
    definition,
    executionId: "inv-mismatch",
    input: { role: "user", parts: [{ text: "go" }] },
    now: 1,
  });
}

function failure(
  code: WorkflowStepFailure["error"]["code"],
  attempts: number,
): WorkflowStepFailure {
  return {
    status: "failed",
    id: step.id,
    agentName: step.agentName,
    error: { code, message: code },
    attempts,
    startedAt: 2,
    completedAt: 3,
  };
}

function mismatch(checkpoint: WorkflowCheckpointV1): WorkflowError {
  try {
    resolveWorkflowStep(checkpoint, step, "sha256:changed");
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected WORKFLOW_STEP_MISMATCH");
}

describe("WORKFLOW_STEP_MISMATCH details", () => {
  test("name the saved step's status and attempts for a step left running", async () => {
    const hash = await hashWorkflowInput(step.input);
    const checkpoint = withWorkflowStepRunning(await base(), step, hash, 1, 2);
    const error = mismatch(checkpoint);
    expect(error.code).toBe("WORKFLOW_STEP_MISMATCH");
    expect(error.details).toMatchObject({
      stepId: "review",
      savedStatus: "running",
      savedAttempts: 1,
    });
  });

  test("name an interrupted step on its second attempt", async () => {
    const hash = await hashWorkflowInput(step.input);
    let checkpoint = withWorkflowStepRunning(await base(), step, hash, 1, 2);
    checkpoint = withWorkflowStepFailed(
      checkpoint,
      failure("WORKFLOW_EXECUTION_ERROR", 1),
    );
    checkpoint = withWorkflowStepRunning(checkpoint, step, hash, 2, 3);
    checkpoint = withWorkflowStepFailed(
      checkpoint,
      failure("WORKFLOW_ABORTED", 2),
    );
    const error = mismatch(checkpoint);
    expect(error.details).toMatchObject({
      savedStatus: "interrupted",
      savedAttempts: 2,
    });
    expect(error.toJSON()).toEqual(JSON.parse(JSON.stringify(error.toJSON())));
  });
});
