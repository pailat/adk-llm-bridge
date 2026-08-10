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
} from "../../src/workflows/checkpoint/checkpoint.js";
import {
  ADKSessionCheckpointStore,
  workflowCheckpointByteLength,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../src/workflows/checkpoint/store.js";
import { WorkflowError } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";

const definition = defineWorkflow({
  id: "implementation",
  version: "1",
  handler: () => "done",
});

describe("ADKSessionCheckpointStore", () => {
  test("returns stateDelta without mutating ADK session state", async () => {
    const context = invocationContext();
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "build it",
      now: 10,
    });
    const store = new ADKSessionCheckpointStore();
    const write = await store.save({ context, checkpoint });
    const key = workflowCheckpointKey("implementation", "inv-1");

    expect(key).toBe("__adk_llm_bridge_workflow_v1:implementation:inv-1");
    expect(write).toEqual({
      checkpointKey: key,
      stateDelta: { [key]: checkpoint },
    });
    expect(context.session.state).toEqual({});
  });

  test("loads a valid checkpoint from session state", async () => {
    const checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-1",
      input: "build it",
    });
    const key = workflowCheckpointKey("implementation", "inv-1");
    const store = new ADKSessionCheckpointStore();

    expect(
      await store.load({
        context: invocationContext({ [key]: checkpoint }),
        workflowId: "implementation",
        executionId: "inv-1",
      }),
    ).toBe(checkpoint);
  });

  test("returns undefined for a missing checkpoint and rejects invalid state", async () => {
    const store = new ADKSessionCheckpointStore();
    expect(
      await store.load({
        context: invocationContext(),
        workflowId: "implementation",
        executionId: "inv-1",
      }),
    ).toBeUndefined();

    const key = workflowCheckpointKey("implementation", "inv-1");
    try {
      await store.load({
        context: invocationContext({ [key]: { schemaVersion: 99 } }),
        workflowId: "implementation",
        executionId: "inv-1",
      });
      throw new Error("Expected invalid checkpoint to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe("WORKFLOW_EXECUTION_ERROR");
    }
  });

  test("compacts legacy runtime fields without mutating visible session state", async () => {
    const checkpoint = await legacyCheckpoint();
    const key = workflowCheckpointKey("implementation", "inv-legacy");
    const context = invocationContext({ [key]: checkpoint });
    const store = new ADKSessionCheckpointStore();

    const loaded = await store.load({
      context,
      workflowId: "implementation",
      executionId: "inv-legacy",
    });

    expect(loaded?.steps.plan?.result).not.toHaveProperty("events");
    expect(loaded?.steps.plan?.result).not.toHaveProperty("replayed");
    expect(checkpoint.steps.plan?.result?.events).toHaveLength(1);
    if (!loaded) throw new Error("missing legacy checkpoint");

    const expectedRevision = await workflowCheckpointRevision(loaded);
    const next = withWorkflowCompleted(loaded, "done", 30);
    const write = await store.save({
      context,
      checkpoint: next,
      expectedRevision,
    });
    expect(
      (write.stateDelta[key] as typeof next).steps.plan?.result,
    ).not.toHaveProperty("events");
  });

  test("rejects oversized load and save before publishing shadow state", async () => {
    const initial = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-size",
      input: "build it",
      now: 10,
    });
    const valid = withWorkflowCompleted(initial, "ok", 20);
    const maxCheckpointBytes = workflowCheckpointByteLength(valid) + 8;
    const oversized = withWorkflowCompleted(initial, "x".repeat(4_096), 20);
    const store = new ADKSessionCheckpointStore({ maxCheckpointBytes });
    const context = invocationContext();
    const initialWrite = await store.save({
      context,
      checkpoint: initial,
      expectedRevision: null,
    });
    const initialRevision = await workflowCheckpointRevision(initial);

    await expect(
      store.save({
        context,
        checkpoint: oversized,
        expectedRevision: initialRevision,
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
      details: {
        reason: "checkpoint_size_limit_exceeded",
        direction: "save",
        maxBytes: maxCheckpointBytes,
      },
    });

    const validWrite = await store.save({
      context,
      checkpoint: valid,
      expectedRevision: initialRevision,
    });
    expect(validWrite.stateDelta).not.toEqual(initialWrite.stateDelta);
    expect(
      await store.load({
        context,
        workflowId: "implementation",
        executionId: "inv-size",
      }),
    ).toEqual(valid);

    const oversizedKey = workflowCheckpointKey("implementation", "inv-size");
    await expect(
      new ADKSessionCheckpointStore({ maxCheckpointBytes }).load({
        context: invocationContext({ [oversizedKey]: oversized }),
        workflowId: "implementation",
        executionId: "inv-size",
      }),
    ).rejects.toMatchObject({
      details: {
        reason: "checkpoint_size_limit_exceeded",
        direction: "load",
      },
    });
  });
});

async function legacyCheckpoint() {
  const checkpoint = await createWorkflowCheckpoint({
    definition,
    executionId: "inv-legacy",
    input: "build it",
    now: 10,
  });
  checkpoint.steps.plan = {
    id: "plan",
    agentName: "planner",
    inputHash: "sha256:input",
    status: "completed",
    attempts: 1,
    startedAt: 10,
    updatedAt: 20,
    completedAt: 20,
    result: {
      status: "completed",
      id: "plan",
      agentName: "planner",
      output: "planned",
      attempts: 1,
      startedAt: 10,
      completedAt: 20,
      replayed: false,
      events: [{ id: "legacy" }] as never,
    },
  };
  return checkpoint;
}

function invocationContext(
  state: Record<string, unknown> = {},
): InvocationContext {
  return {
    invocationId: "inv-1",
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
