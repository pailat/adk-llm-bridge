/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  checkpointExpectation,
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  validateWorkflowCheckpoint,
  withWorkflowCompleted,
  withWorkflowStepCompleted,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
} from "../../src/workflows/checkpoint/checkpoint.js";
import {
  hashWorkflowInput,
  hashWorkflowSource,
  stableSerializeWorkflowValue,
} from "../../src/workflows/checkpoint/hash.js";
import type {
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "../../src/workflows/contracts.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineScriptWorkflow } from "../../src/workflows/definition.js";

const definition = defineScriptWorkflow({
  id: "implementation",
  version: "1",
  source: 'yield { type: "run", step: ctx.input };',
});

const step: WorkflowStep = {
  id: "plan",
  agentName: "planner",
  input: "make a plan",
};

describe("workflow checkpoints", () => {
  test("hashes semantically identical JSON values deterministically", async () => {
    expect(stableSerializeWorkflowValue({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(await hashWorkflowInput({ b: 2, a: 1 })).toBe(
      await hashWorkflowInput({ a: 1, b: 2 }),
    );
    expect(await hashWorkflowSource("return 1")).not.toBe(
      await hashWorkflowSource("return 2"),
    );
  });

  test("creates a v1 checkpoint with input and script source hashes", async () => {
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: { role: "user", parts: [{ text: "build it" }] },
      now: 10,
    });

    expect(checkpoint).toMatchObject({
      schemaVersion: 1,
      workflowId: "implementation",
      workflowVersion: "1",
      executionId: "inv-1",
      status: "running",
      steps: {},
      startedAt: 10,
      updatedAt: 10,
      inputHash: expect.stringMatching(/^sha256:/),
      sourceHash: expect.stringMatching(/^sha256:/),
    });
  });

  test("rejects incompatible workflow, input, and source resumes", async () => {
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "original",
    });
    const expected = checkpointExpectation(checkpoint);

    expect(() =>
      validateWorkflowCheckpoint(checkpoint, expected),
    ).not.toThrow();
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          workflowVersion: "2",
        }),
      "WORKFLOW_VERSION_MISMATCH",
    );
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          inputHash: "sha256:changed",
        }),
      "WORKFLOW_INPUT_MISMATCH",
    );
    expectWorkflowCode(
      () =>
        validateWorkflowCheckpoint(checkpoint, {
          ...expected,
          sourceHash: "sha256:changed",
        }),
      "WORKFLOW_SOURCE_MISMATCH",
    );
  });

  test("replays completed steps and rejects mismatched step reuse", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
    const result = completedResult();
    checkpoint = withWorkflowStepCompleted(checkpoint, result, 20);

    expect(resolveWorkflowStep(checkpoint, step, inputHash)).toEqual({
      action: "replay",
      result: { ...result, replayed: true },
    });
    expectWorkflowCode(
      () => resolveWorkflowStep(checkpoint, step, "sha256:different"),
      "WORKFLOW_STEP_MISMATCH",
    );
    expect(checkpoint.steps.plan.result).not.toHaveProperty("replayed");
  });

  test("treats a running step as indeterminate unless retry is explicit", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);

    expectWorkflowCode(
      () => resolveWorkflowStep(checkpoint, step, inputHash),
      "WORKFLOW_INDETERMINATE_STEP",
    );
    expect(
      resolveWorkflowStep(
        checkpoint,
        { ...step, resumePolicy: "retry" },
        inputHash,
      ),
    ).toEqual({ action: "execute", attempt: 2 });
  });

  test("records failed steps and terminal workflow output immutably", async () => {
    const inputHash = await hashWorkflowInput(step.input);
    const original = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "workflow input",
    });
    const running = withWorkflowStepRunning(original, step, inputHash, 1, 10);
    const failure: WorkflowStepFailure = {
      status: "failed",
      id: step.id,
      agentName: step.agentName,
      error: { code: "WORKFLOW_EXECUTION_ERROR", message: "agent failed" },
      attempts: 1,
      startedAt: 10,
      completedAt: 20,
    };
    const failed = withWorkflowStepFailed(running, failure, 20);
    const completed = withWorkflowCompleted(running, "done", 30);

    expect(original.steps).toEqual({});
    expect(failed.steps.plan).toMatchObject({
      status: "failed",
      error: failure.error,
      completedAt: 20,
    });
    expect(completed).toMatchObject({
      status: "completed",
      output: "done",
      completedAt: 30,
    });
  });
});

function completedResult(): WorkflowStepResult {
  return {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output: "plan complete",
    attempts: 1,
    startedAt: 10,
    completedAt: 20,
  };
}

function expectWorkflowCode(
  action: () => unknown,
  code: WorkflowError["code"],
): void {
  try {
    action();
    throw new Error(`Expected workflow error: ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe(code);
  }
}
