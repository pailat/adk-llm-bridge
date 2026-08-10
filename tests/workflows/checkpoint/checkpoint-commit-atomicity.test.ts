/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointStore,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import type {
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowCheckpointCoordinator } from "../../../src/workflows/runtime/workflow-checkpoint-coordinator.js";

const definition = defineWorkflow({
  id: "checkpoint-commit-atomicity",
  version: "1",
  handler: () => "done",
});

const step = {
  id: "build",
  agentName: "worker",
  input: "build it",
  resumePolicy: "retry",
} satisfies WorkflowStep;

const workflowError = (message: string): WorkflowSerializedError => ({
  code: "WORKFLOW_EXECUTION_ERROR",
  message,
});

describe("workflow checkpoint coordinator commit atomicity", () => {
  test("does not publish an initial checkpoint until its save succeeds", async () => {
    const store = new ControlledCheckpointStore();
    const subject = coordinator(store);
    store.failNextSave();

    await expect(subject.initialize()).rejects.toThrow("injected save failure");
    await expect(subject.prepareStep(step)).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      message: "Workflow checkpoint coordinator is not initialized",
    });
    expect(store.saveCalls).toHaveLength(1);
    expect(store.checkpoint).toBeUndefined();

    await subject.initialize();

    expect(store.saveCalls).toHaveLength(2);
    expect(store.saveCalls.map((call) => call.expectedRevision)).toEqual([
      null,
      null,
    ]);
    expect(store.checkpoint).toMatchObject({ status: "running", steps: {} });
  });

  test("retries prepareStep from the last committed checkpoint after CAS failure", async () => {
    const store = new ControlledCheckpointStore();
    const subject = coordinator(store);
    await subject.initialize();
    const committedRevision = await workflowCheckpointRevision(
      requiredCheckpoint(store),
    );
    store.failNextSave(
      new WorkflowCheckpointConflictError(
        "memory:execution-1",
        committedRevision,
        "concurrent-revision",
      ),
    );

    await expect(subject.prepareStep(step)).rejects.toBeInstanceOf(
      WorkflowCheckpointConflictError,
    );
    const prepared = await subject.prepareStep(step);

    expect(prepared.resolution).toEqual({ action: "execute", attempt: 1 });
    expect(store.saveCalls).toHaveLength(3);
    expect(store.saveCalls[1]?.expectedRevision).toBe(committedRevision);
    expect(store.saveCalls[2]?.expectedRevision).toBe(committedRevision);
    expect(store.checkpoint?.steps.build).toMatchObject({
      status: "running",
      attempts: 1,
    });
  });

  test("retries every step transition against the previous revision", async () => {
    for (const transition of ["start", "complete", "fail"] as const) {
      const store = new ControlledCheckpointStore();
      const subject = coordinator(store);
      await subject.initialize();
      const prepared = await subject.prepareStep(step);
      const committedRevision = await workflowCheckpointRevision(
        requiredCheckpoint(store),
      );
      const saveCount = store.saveCalls.length;
      const operation = () => {
        if (transition === "start") {
          return subject.startAttempt(step, prepared.inputHash, 2);
        }
        if (transition === "complete") {
          return subject.completeStep(completedStep(1));
        }
        return subject.failStep(failedStep(1));
      };
      store.failNextSave();

      await expect(operation()).rejects.toThrow("injected save failure");
      await operation();

      expect(store.saveCalls[saveCount]?.expectedRevision).toBe(
        committedRevision,
      );
      expect(store.saveCalls[saveCount + 1]?.expectedRevision).toBe(
        committedRevision,
      );
      expect(store.checkpoint?.steps.build).toMatchObject(
        transition === "start"
          ? { status: "running", attempts: 2 }
          : { status: transition === "complete" ? "completed" : "failed" },
      );
    }
  });

  test("discards failed workflow transition candidates before a retry", async () => {
    for (const transition of ["complete", "fail"] as const) {
      const store = new ControlledCheckpointStore();
      const subject = coordinator(store);
      await subject.initialize();
      const committedRevision = await workflowCheckpointRevision(
        requiredCheckpoint(store),
      );
      const saveCount = store.saveCalls.length;
      store.failNextSave();

      if (transition === "complete") {
        await expect(subject.completeWorkflow("discarded")).rejects.toThrow(
          "injected save failure",
        );
        await subject.completeWorkflow(undefined);
        expect(store.checkpoint?.output).toBeUndefined();
        expect(store.checkpoint?.status).toBe("completed");
      } else {
        await expect(
          subject.failWorkflow(workflowError("discarded"), "failed"),
        ).rejects.toThrow("injected save failure");
        await subject.failWorkflow(workflowError("committed"), "cancelled");
        expect(store.checkpoint).toMatchObject({
          status: "cancelled",
          error: { message: "committed" },
        });
      }

      expect(store.saveCalls[saveCount]?.expectedRevision).toBe(
        committedRevision,
      );
      expect(store.saveCalls[saveCount + 1]?.expectedRevision).toBe(
        committedRevision,
      );
    }
  });

  test("keeps a successful save committed when onWrite fails", async () => {
    const store = new ControlledCheckpointStore();
    let failNextWrite = false;
    let writeCount = 0;
    const subject = coordinator(store, () => {
      writeCount++;
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("injected onWrite failure");
      }
    });
    await subject.initialize();
    await subject.prepareStep(step);
    failNextWrite = true;

    const completion = subject.completeStep(completedStep(1));
    const terminal = subject.failWorkflow(
      workflowError("workflow failed later"),
      "failed",
    );

    await expect(completion).rejects.toThrow("injected onWrite failure");
    await expect(terminal).resolves.toBeUndefined();

    expect(store.saveCalls).toHaveLength(4);
    expect(store.successfulWrites).toBe(4);
    expect(writeCount).toBe(4);
    const completedRevision = await workflowCheckpointRevision(
      requiredSave(store, 2).checkpoint,
    );
    expect(store.saveCalls[3]?.expectedRevision).toBe(completedRevision);
    expect(store.checkpoint).toMatchObject({
      status: "failed",
      steps: { build: { status: "completed", attempts: 1 } },
    });
  });

  test("commits and hashes only the compact durable step result", async () => {
    const store = new ControlledCheckpointStore();
    const subject = coordinator(store);
    await subject.initialize();
    await subject.prepareStep(step);
    const result: WorkflowStepResult = {
      ...completedStep(1),
      replayed: false,
      events: [{ id: "runtime-only" }] as WorkflowStepResult["events"],
    };

    await subject.completeStep(result);

    const completion = requiredSave(store, 2);
    const savedResult = completion.checkpoint.steps.build?.result;
    expect(result.events).toHaveLength(1);
    expect(savedResult).not.toHaveProperty("events");
    expect(savedResult).not.toHaveProperty("replayed");
    expect(completion.revision).toBe(
      await workflowCheckpointRevision(completion.checkpoint),
    );
  });
});

class ControlledCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;
  readonly saveCalls: SaveWorkflowCheckpointInput[] = [];
  successfulWrites = 0;
  readonly #saveFailures: Error[] = [];

  failNextSave(error: Error = new Error("injected save failure")): void {
    this.#saveFailures.push(error);
  }

  async load(_input: LoadWorkflowCheckpointInput) {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.saveCalls.push(input);
    const failure = this.#saveFailures.shift();
    if (failure) {
      throw failure;
    }

    const actualRevision = this.checkpoint
      ? await workflowCheckpointRevision(this.checkpoint)
      : null;
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== actualRevision
    ) {
      throw new WorkflowCheckpointConflictError(
        workflowCheckpointKey(
          input.checkpoint.workflowId,
          input.checkpoint.executionId,
        ),
        input.expectedRevision,
        actualRevision,
      );
    }
    if (
      input.revision !== undefined &&
      input.revision !== (await workflowCheckpointRevision(input.checkpoint))
    ) {
      throw new Error("coordinator supplied a non-deterministic revision");
    }

    this.checkpoint = input.checkpoint;
    this.successfulWrites++;
    return {
      checkpointKey: `memory:${input.checkpoint.executionId}`,
      stateDelta: { checkpoint: input.checkpoint },
    };
  }
}

function coordinator(
  store: WorkflowCheckpointStore,
  onWrite: () => void | Promise<void> = () => {},
): WorkflowCheckpointCoordinator {
  return new WorkflowCheckpointCoordinator({
    definition,
    executionId: "execution-1",
    input: { role: "user", parts: [{ text: "build it" }] },
    context: invocationContext(),
    store,
    onWrite,
  });
}

function completedStep(attempts: number): WorkflowStepResult {
  return {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output: "done",
    attempts,
    startedAt: 10,
    completedAt: 20,
  };
}

function failedStep(attempts: number): WorkflowStepFailure {
  return {
    status: "failed",
    id: step.id,
    agentName: step.agentName,
    error: workflowError("step failed"),
    attempts,
    startedAt: 10,
    completedAt: 20,
  };
}

function requiredCheckpoint(store: ControlledCheckpointStore) {
  if (!store.checkpoint) throw new Error("checkpoint was not persisted");
  return store.checkpoint;
}

function requiredSave(store: ControlledCheckpointStore, index: number) {
  const save = store.saveCalls[index];
  if (!save) throw new Error(`checkpoint save ${index} was not attempted`);
  return save;
}

function invocationContext(): InvocationContext {
  return {
    invocationId: "execution-1",
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  } as InvocationContext;
}
