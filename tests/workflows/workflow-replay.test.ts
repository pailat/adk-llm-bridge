/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
} from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowStepRunning,
} from "../../src/workflows/checkpoint/checkpoint.js";
import { hashWorkflowInput } from "../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  type WorkflowCheckpointStore,
  workflowCheckpointKey,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class CountingAgent extends BaseAgent {
  calls = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: "implemented" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown> = {},
  invocationId = "inv-workflow",
): InvocationContext {
  return new InvocationContext({
    invocationId,
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "build it" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(agent: BaseAgent, context: InvocationContext) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function appliedState(events: readonly Event[]): Record<string, unknown> {
  return Object.assign(
    {},
    ...events.map((event) => event.actions?.stateDelta ?? {}),
  );
}

function workflowEvent(event: Event) {
  return event.customMetadata?.workflowEvent as
    | { type: string; executionId: string; stepId?: string }
    | undefined;
}

describe("WorkflowAgent durable replay", () => {
  test("emits checkpoint state deltas and replays without invoking the agent", async () => {
    const worker = new CountingAgent("worker");
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "durable",
        version: "1",
        handler: async (ctx) => {
          const result = await ctx.run({
            id: "implement",
            agentName: "worker",
            input: "task",
          });
          return result.output;
        },
      }),
      subAgents: [worker],
    });

    const firstContext = invocation(workflow);
    const firstEvents = await collect(workflow, firstContext);
    const checkpointEvents = firstEvents.filter(
      (event) => workflowEvent(event)?.type === "checkpoint_saved",
    );
    const state = appliedState(firstEvents);
    const crashState = checkpointEvents.at(-2)?.actions?.stateDelta ?? {};
    const key = workflowCheckpointKey("durable", "inv-workflow");

    expect(firstContext.session.state).toEqual({});
    expect(checkpointEvents.length).toBe(4);
    expect(checkpointEvents.every((event) => event.actions?.stateDelta)).toBe(
      true,
    );
    expect((state[key] as WorkflowCheckpointV1).status).toBe("completed");
    expect(worker.calls).toBe(1);

    const secondEvents = await collect(
      workflow,
      invocation(workflow, crashState),
    );
    expect(worker.calls).toBe(1);
    expect(
      secondEvents.some(
        (event) => workflowEvent(event)?.type === "step_replayed",
      ),
    ).toBe(true);
    expect(secondEvents.at(-2)?.content?.parts?.[0]?.text).toBe("implemented");
  });

  test("rejects an indeterminate running step unless retry is explicit", async () => {
    const worker = new CountingAgent("worker");
    const definition = defineWorkflow({
      id: "indeterminate",
      version: "1",
      handler: (ctx) =>
        ctx.run({ id: "write", agentName: "worker", input: "side effect" }),
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [worker],
    });
    const step = { id: "write", agentName: "worker", input: "side effect" };
    let checkpoint = await createWorkflowCheckpoint({
      definition,
      executionId: "inv-workflow",
      input: { role: "user", parts: [{ text: "build it" }] },
    });
    checkpoint = withWorkflowStepRunning(
      checkpoint,
      step,
      await hashWorkflowInput(step.input),
      1,
    );
    const key = workflowCheckpointKey("indeterminate", "inv-workflow");

    await expect(
      collect(workflow, invocation(workflow, { [key]: checkpoint })),
    ).rejects.toMatchObject({ code: "WORKFLOW_INDETERMINATE_STEP" });
    expect(worker.calls).toBe(0);
  });

  test("uses an injected checkpoint store and resolved execution id", async () => {
    const store = new MemoryCheckpointStore();
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "custom",
        version: "1",
        handler: () => "done",
      }),
      checkpointStore: store,
      resolveExecutionId: () => "business-operation-42",
    });

    const events = await collect(workflow, invocation(workflow));

    expect(store.loads).toEqual([
      { workflowId: "custom", executionId: "business-operation-42" },
    ]);
    expect(store.checkpoint?.executionId).toBe("business-operation-42");
    expect(
      events
        .map(workflowEvent)
        .filter(Boolean)
        .every((event) => event?.executionId === "business-operation-42"),
    ).toBe(true);
  });
});

class MemoryCheckpointStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;
  readonly loads: Array<{ workflowId: string; executionId: string }> = [];

  async load(input: LoadWorkflowCheckpointInput) {
    this.loads.push({
      workflowId: input.workflowId,
      executionId: input.executionId,
    });
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return {
      checkpointKey: `custom:${input.checkpoint.executionId}`,
      stateDelta: { customCheckpoint: input.checkpoint },
    };
  }
}
