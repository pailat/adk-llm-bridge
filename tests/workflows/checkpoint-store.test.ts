/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import type { InvocationContext } from "@google/adk";
import { createWorkflowCheckpoint } from "../../src/workflows/checkpoint/checkpoint.js";
import {
  ADKSessionCheckpointStore,
  workflowCheckpointKey,
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
});

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
