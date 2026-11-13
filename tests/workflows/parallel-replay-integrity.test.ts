import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type { WorkflowParallelOptions } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepFailedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class MemoryStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;

  async load() {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return { checkpointKey: "k", stateDelta: { k: input.checkpoint } };
  }
}

class DoneAgent extends BaseAgent {
  calls = 0;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `${this.name} done` }] },
    });
  }

  protected async *runLiveImpl() {}
}

type Mode = "run" | NonNullable<WorkflowParallelOptions["failureMode"]>;

function workflowFor(store: MemoryStore, mode: Mode, input: string) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [new DoneAgent("a"), new DoneAgent("b")],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    definition: defineWorkflow({
      id: "parallel-integrity",
      version: "1",
      handler: async (ctx) => {
        if (mode === "run") {
          await ctx.run({ id: "a", agentName: "a", input });
          return "after";
        }
        const outcomes = await ctx.parallel(
          [
            { id: "a", agentName: "a", input },
            { id: "b", agentName: "b", input: "same" },
          ],
          { failureMode: mode },
        );
        await ctx.run({ id: "later", agentName: "b", input: "later" });
        return outcomes.map((outcome) => outcome.status).join(",");
      },
    }),
  });
}

async function drain(agent: BaseAgent, invocationId: string) {
  const events: Event[] = [];
  let error: (Error & { code?: string }) | undefined;
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId,
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  try {
    for await (const event of agent.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  return { events, error };
}

const stepFailures = (events: readonly Event[]) =>
  events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(
      (event): event is WorkflowStepFailedEvent =>
        event?.type === "step_failed",
    );

describe("replay integrity inside ctx.parallel", () => {
  for (const mode of ["run", "fail-fast", "all-settled"] as const) {
    test(`a changed step input fails the run at that step (${mode})`, async () => {
      const store = new MemoryStore();
      const first = await drain(workflowFor(store, mode, "v1"), "inv-1");
      expect(first.error).toBeUndefined();

      const second = await drain(workflowFor(store, mode, "v2"), "inv-2");
      expect(second.error?.code).toBe("WORKFLOW_STEP_MISMATCH");
      expect(second.error).toMatchObject({ details: { stepId: "a" } });
      expect(store.checkpoint?.status).toBe("failed");
      expect(store.checkpoint?.error?.code).toBe("WORKFLOW_STEP_MISMATCH");
      const failures = stepFailures(second.events);
      expect(failures.map((event) => event.failure.id)).toEqual(["a"]);
      expect(failures[0]?.failure.error.code).toBe("WORKFLOW_STEP_MISMATCH");
    });
  }

  test("a step failure that is not a replay mismatch still settles in all-settled mode", async () => {
    const store = new MemoryStore();
    const workflow = new WorkflowAgent({
      name: "workflow",
      subAgents: [new DoneAgent("a")],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      definition: defineWorkflow({
        id: "parallel-settled",
        version: "1",
        handler: async (ctx) => {
          const outcomes = await ctx.parallel(
            [{ id: "x", agentName: "missing", input: "x" }],
            { failureMode: "all-settled" },
          );
          return outcomes.map((outcome) => outcome.status).join(",");
        },
      }),
    });
    const result = await drain(workflow, "inv-1");
    expect(result.error).toBeUndefined();
    expect(store.checkpoint?.status).toBe("completed");
  });

  for (const mode of ["run", "all-settled"] as const) {
    test(`a durable attempt replay that does not match fails the run at that step (${mode})`, async () => {
      const worker = new DoneAgent("a");
      const workflow = new WorkflowAgent({
        name: "workflow",
        subAgents: [worker, new DoneAgent("b")],
        resolveExecutionId: () => "run-1",
        runtimeHooks: {
          beforeAttempt: (attempt) =>
            attempt.stepId === "a"
              ? {
                  idempotencyKey: `${attempt.idempotencyKey}-other`,
                  result: {
                    status: "completed",
                    id: attempt.stepId,
                    agentName: attempt.agentName,
                    output: "x",
                    attempts: attempt.attempt,
                    startedAt: 1,
                    completedAt: 2,
                  },
                }
              : undefined,
        },
        definition: defineWorkflow({
          id: "attempt-integrity",
          version: "1",
          handler: async (ctx) => {
            if (mode === "run") {
              await ctx.run({ id: "a", agentName: "a", input: "i" });
              return "after";
            }
            const outcomes = await ctx.parallel(
              [
                { id: "a", agentName: "a", input: "i" },
                { id: "b", agentName: "b", input: "i" },
              ],
              { failureMode: "all-settled" },
            );
            return outcomes.map((outcome) => outcome.status).join(",");
          },
        }),
      });

      const result = await drain(workflow, "inv-1");
      expect(result.error?.code).toBe("WORKFLOW_ATTEMPT_MISMATCH");
      expect(worker.calls).toBe(0);
      const failures = stepFailures(result.events);
      expect(failures.map((event) => event.failure.id)).toEqual(["a"]);
      expect(failures[0]?.failure.error.code).toBe("WORKFLOW_ATTEMPT_MISMATCH");
    });
  }
});
