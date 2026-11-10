import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BaseAgent,
  BaseSessionService,
  createEvent,
  createEventActions,
  type Event,
  InvocationContext,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import {
  type SaveWorkflowCheckpointInput,
  WORKFLOW_CHECKPOINT_STATE_PREFIX,
  type WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type { WorkflowStepResult } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
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

const TEMP_DELTA = { kept: 1, "temp:scratch": 2 };

/** Writes a kept key and a `temp:` key, then answers. */
class WriterAgent extends BaseAgent {
  constructor() {
    super({ name: "writer" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "written" }] },
      actions: createEventActions({ stateDelta: { ...TEMP_DELTA } }),
    });
  }

  protected async *runLiveImpl() {}
}

/** Writes a `temp:` key on the event that asks for input. */
class AskAgent extends BaseAgent {
  constructor() {
    super({ name: "ask" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "ask-1",
              name: REQUEST_INPUT_FUNCTION_CALL_NAME,
              args: { message: "approve?" },
            },
          },
        ],
      },
      longRunningToolIds: ["ask-1"],
      actions: createEventActions({ stateDelta: { ...TEMP_DELTA } }),
    });
  }

  protected async *runLiveImpl() {}
}

function workflow(store: MemoryStore) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [new WriterAgent(), new AskAgent()],
    checkpointStore: store,
    resolveExecutionId: () => "run-1",
    definition: defineWorkflow({
      id: "temp-state",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "write", agentName: "writer", input: "x" });
        const answer = await ctx.run({
          id: "ask",
          agentName: "ask",
          input: "x",
        });
        return answer.output;
      },
    }),
  });
}

async function drain(agent: BaseAgent) {
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-1",
    agent,
    userContent: { role: "user", parts: [{ text: "start" }] },
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

const tempKeys = (record: object | undefined) =>
  Object.keys(record ?? {}).filter((key) => key.startsWith("temp:"));

for (const variant of [
  "ADK's appendEvent",
  "an appendEvent that keeps temp: keys",
]) {
  describe(`temp: state never reaches the checkpoint (${variant})`, () => {
    let restore: (() => void) | undefined;

    beforeEach(() => {
      if (variant === "ADK's appendEvent") return;
      const append = spyOn(
        BaseSessionService.prototype,
        "appendEvent",
      ).mockImplementation(async ({ session, event }) => {
        if (event.partial) return event;
        Object.assign(session.state, event.actions?.stateDelta ?? {});
        session.events.push(event);
        return event;
      });
      restore = () => append.mockRestore();
    });

    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    test("a completed step's stateDelta and a waiting step's stored events hold no temp: key", async () => {
      const store = new MemoryStore();
      await drain(workflow(store));

      const steps = store.checkpoint?.steps;
      expect(steps?.write?.status).toBe("completed");
      expect(steps?.write?.result?.stateDelta).toEqual({ kept: 1 });
      expect(steps?.ask?.status).toBe("waiting");
      const stored = steps?.ask?.interrupt?.events ?? [];
      expect(stored.length).toBeGreaterThan(0);
      for (const event of stored) {
        const delta = (event as { actions?: { stateDelta?: object } }).actions
          ?.stateDelta;
        expect(tempKeys(delta)).toEqual([]);
      }
      expect(JSON.stringify(store.checkpoint)).not.toContain("temp:scratch");
    });
  });
}

/** Fails if it runs: a durable attempt replay answers for it. */
class NeverAgent extends BaseAgent {
  constructor() {
    super({ name: "never" });
  }

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    yield* [] as Event[];
    throw new Error("must not run");
  }

  protected async *runLiveImpl() {}
}

describe("a durable attempt replay", () => {
  const PREFIX_KEY = `${WORKFLOW_CHECKPOINT_STATE_PREFIX}:other`;

  async function replayWith(stateDelta: Record<string, unknown>) {
    const store = new MemoryStore();
    let seen: WorkflowStepResult | undefined;
    const agent = new WorkflowAgent({
      name: "workflow",
      subAgents: [new NeverAgent()],
      checkpointStore: store,
      resolveExecutionId: () => "run-1",
      runtimeHooks: {
        beforeAttempt: (context) => ({
          idempotencyKey: context.idempotencyKey,
          result: {
            status: "completed",
            id: context.stepId,
            agentName: context.agentName,
            output: "journaled",
            attempts: context.attempt,
            startedAt: 1,
            completedAt: 2,
            stateDelta,
          },
        }),
      },
      definition: defineWorkflow({
        id: "temp-replay",
        version: "1",
        handler: async (ctx) => {
          seen = await ctx.run({ id: "s", agentName: "never", input: "x" });
          return seen.output;
        },
      }),
    });
    await drain(agent);
    return { store, seen };
  }

  test("drops temp: and checkpoint-prefix keys from the replayed stateDelta", async () => {
    const { store, seen } = await replayWith({
      kept: 1,
      "temp:scratch": 2,
      [PREFIX_KEY]: 3,
    });

    expect(seen?.replayed).toBe(true);
    expect(seen?.stateDelta).toEqual({ kept: 1 });
    expect(store.checkpoint?.steps.s?.result?.stateDelta).toEqual({ kept: 1 });
    const stored = JSON.stringify(store.checkpoint);
    expect(stored).not.toContain("temp:scratch");
    expect(stored).not.toContain(PREFIX_KEY);
  });

  test("omits stateDelta when only filtered keys were replayed", async () => {
    const { store, seen } = await replayWith({ "temp:scratch": 2 });

    expect(seen && "stateDelta" in seen).toBe(false);
    expect(store.checkpoint?.steps.s?.result).not.toHaveProperty("stateDelta");
  });
});
