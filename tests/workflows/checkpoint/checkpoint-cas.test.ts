/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  ADKSessionCheckpointStore,
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointStore,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowCheckpointCoordinator } from "../../../src/workflows/runtime/workflow-checkpoint-coordinator.js";

const definition = defineWorkflow({
  id: "checkpoint-cas",
  version: "1",
  handler: () => "done",
});

describe("workflow checkpoint optimistic concurrency", () => {
  test("ADK session store rejects stale pending state deltas without mutating state", async () => {
    const initial = await createWorkflowCheckpoint({
      definition,
      executionId: "execution-1",
      input: "build it",
      now: 10,
    });
    const key = workflowCheckpointKey(definition.id, "execution-1");
    const context = invocationContext({ [key]: initial });
    const store = new ADKSessionCheckpointStore();
    const staleStore = new ADKSessionCheckpointStore();
    const expectedRevision = await workflowCheckpointRevision(initial);
    const next = withWorkflowCompleted(initial, "first", 20);
    const nextRevision = await workflowCheckpointRevision(next);

    await store.save({
      context,
      checkpoint: next,
      expectedRevision,
      revision: nextRevision,
    });

    const stale = withWorkflowCompleted(initial, "stale", 30);
    await expect(
      staleStore.save({
        context,
        checkpoint: stale,
        expectedRevision,
        revision: await workflowCheckpointRevision(stale),
      }),
    ).rejects.toMatchObject({
      name: "WorkflowCheckpointConflictError",
      code: "WORKFLOW_EXECUTION_ERROR",
      conflict: {
        reason: "checkpoint_revision_conflict",
        checkpointKey: key,
        expectedRevision,
        actualRevision: nextRevision,
      },
    });
    expect(context.session.state[key]).toBe(initial);
    expect(
      await store.load({
        context,
        workflowId: definition.id,
        executionId: "execution-1",
      }),
    ).toBe(next);
  });

  test("durable CAS stops a stale coordinator before it can execute a step", async () => {
    const context = invocationContext();
    const store = new AtomicMemoryCheckpointStore();
    const first = coordinator(context, store);
    const stale = coordinator(context, store);
    const step = { id: "charge", agentName: "worker", input: "side effect" };

    await first.initialize();
    await stale.initialize();
    const prepared = await first.prepareStep(step);

    expect(prepared.resolution).toEqual({ action: "execute", attempt: 1 });
    await expect(stale.prepareStep(step)).rejects.toBeInstanceOf(
      WorkflowCheckpointConflictError,
    );
    expect(store.checkpoint?.steps.charge).toMatchObject({
      status: "running",
      attempts: 1,
    });

    const resumed = coordinator(context, store);
    await resumed.initialize();
    await expect(resumed.prepareStep(step)).rejects.toMatchObject({
      code: "WORKFLOW_INDETERMINATE_STEP",
    });
  });
});

class AtomicMemoryCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  async load(_input: LoadWorkflowCheckpointInput) {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
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

    const revision = await workflowCheckpointRevision(input.checkpoint);
    if (input.revision !== revision) {
      throw new Error("coordinator supplied a non-deterministic revision");
    }
    this.checkpoint = input.checkpoint;
    return {
      checkpointKey: `memory:${input.checkpoint.executionId}`,
      stateDelta: { checkpoint: input.checkpoint },
    };
  }
}

function coordinator(
  context: InvocationContext,
  store: WorkflowCheckpointStore,
): WorkflowCheckpointCoordinator {
  return new WorkflowCheckpointCoordinator({
    definition,
    executionId: "execution-1",
    input: { role: "user", parts: [{ text: "build it" }] },
    context,
    store,
    onWrite: () => {},
  });
}

function invocationContext(
  state: Record<string, unknown> = {},
): InvocationContext {
  return {
    invocationId: "execution-1",
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  } as InvocationContext;
}
