import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { Content } from "@google/genai";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import {
  defineScriptWorkflow,
  defineWorkflow,
} from "../../src/workflows/definition.js";
import type { WorkflowEvent } from "../../src/workflows/events.js";
import { ScriptWorkflowAgent } from "../../src/workflows/script-workflow-agent.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class KeyedStore implements WorkflowCheckpointStore {
  readonly checkpoints = new Map<string, WorkflowCheckpointV1>();

  async load(input: LoadWorkflowCheckpointInput) {
    return this.checkpoints.get(`${input.workflowId}:${input.executionId}`);
  }

  async save(input: SaveWorkflowCheckpointInput) {
    const key = `${input.checkpoint.workflowId}:${input.checkpoint.executionId}`;
    this.checkpoints.set(key, input.checkpoint);
    return { checkpointKey: key, stateDelta: {} };
  }
}

/** Replies with text, or asks for input until the turn answers it. */
class StepAgent extends BaseAgent {
  calls = 0;

  constructor(
    name: string,
    private readonly asks = false,
  ) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    const answered = context.userContent?.parts?.some(
      (part) => part.functionResponse,
    );
    if (this.asks && !answered) {
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
                args: { message: "?" },
              },
            },
          ],
        },
        longRunningToolIds: ["ask-1"],
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: this.name }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** Fails every run. */
class FailAgent extends BaseAgent {
  calls = 0;

  protected async *runAsyncImpl(): AsyncGenerator<Event, void, void> {
    this.calls += 1;
    if (this.calls > 0) throw new Error("boom");
    yield* [];
  }

  protected async *runLiveImpl() {}
}

const START: Content = { role: "user", parts: [{ text: "start" }] };
const ANSWER: Content = {
  role: "user",
  parts: [
    {
      functionResponse: {
        id: "ask-1",
        name: REQUEST_INPUT_FUNCTION_CALL_NAME,
        response: { value: 1 },
      },
    },
  ],
};

/** Steps before a gate in the middle of the run, then one more step after the answer. */
function gated(
  limits: { maxSteps?: number; maxReplayedSteps?: number },
  store: WorkflowCheckpointStore,
  pre = ["pre"],
) {
  return new WorkflowAgent({
    name: "wf",
    subAgents: [
      ...pre.map((name) => new StepAgent(name)),
      new StepAgent("gate", true),
      new StepAgent("post"),
    ],
    checkpointStore: store,
    definition: defineWorkflow({
      id: "limited",
      version: "1",
      limits,
      handler: async (ctx) => {
        for (const name of pre) {
          await ctx.run({ id: name, agentName: name, input: "x" });
        }
        await ctx.run({ id: "gate", agentName: "gate", input: "x" });
        await ctx.run({ id: "post", agentName: "post", input: "x" });
      },
    }),
  });
}

async function turn(
  workflow: WorkflowAgent | ScriptWorkflowAgent,
  id: string,
  message: Content,
) {
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: id,
    agent: workflow,
    userContent: message,
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
  const events: Event[] = [];
  let error: { code?: string; details?: Record<string, unknown> } | undefined;
  try {
    for await (const event of workflow.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  const types = events
    .map((event) => event.customMetadata?.workflowEvent as WorkflowEvent)
    .filter(Boolean)
    .map((event) => event.type);
  return { events, error, types };
}

describe("maxSteps across a resume", () => {
  test("steps replayed from the checkpoint do not count toward maxSteps", async () => {
    const store = new KeyedStore();
    const first = await turn(gated({ maxSteps: 2 }, store), "run-1", START);
    expect(first.error).toBeUndefined();
    expect(first.types.at(-1)).toBe("workflow_waiting");

    // pre replays; gate (answered) and post execute: two executed steps.
    const resumed = await turn(gated({ maxSteps: 2 }, store), "run-1", ANSWER);

    expect(resumed.error).toBeUndefined();
    expect(resumed.types).toContain("workflow_completed");
  });

  test("a turn that executes more than maxSteps steps stops before running the next agent", async () => {
    const agents = ["a", "b", "c"].map((name) => new StepAgent(name));
    const store = new KeyedStore();
    const workflow = new WorkflowAgent({
      name: "wf",
      subAgents: agents,
      checkpointStore: store,
      definition: defineWorkflow({
        id: "fresh",
        version: "1",
        limits: { maxSteps: 2 },
        handler: async (ctx) => {
          for (const agent of agents) {
            await ctx.run({
              id: agent.name,
              agentName: agent.name,
              input: "x",
            });
          }
        },
      }),
    });

    const run = await turn(workflow, "run-fresh", START);

    expect(run.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(run.error?.details).toEqual({
      limit: 2,
      limitName: "maxSteps",
      stepId: "c",
      executedSteps: 2,
      replayedSteps: 0,
      maxSteps: 2,
      maxReplayedSteps: 20,
    });
    expect(agents.map((agent) => agent.calls)).toEqual([1, 1, 0]);
    // The refused step was never saved `running`.
    const saved = [...store.checkpoints.values()][0];
    expect(Object.keys(saved?.steps ?? {}).sort()).toEqual(["a", "b"]);
  });

  test("a parallel batch admits exactly maxSteps executed steps", async () => {
    const agents = ["p1", "p2", "p3"].map((name) => new StepAgent(name));
    const workflow = new WorkflowAgent({
      name: "wf",
      subAgents: agents,
      definition: defineWorkflow({
        id: "parallel",
        version: "1",
        limits: { maxSteps: 2, maxConcurrency: 3 },
        handler: async (ctx) => {
          await ctx.parallel(
            agents.map((agent) => ({
              id: agent.name,
              agentName: agent.name,
              input: "x",
            })),
          );
        },
      }),
    });

    const run = await turn(workflow, "run-parallel", START);

    expect(run.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(run.error?.details).toMatchObject({ executedSteps: 2 });
    // Fail-fast may stop an admitted sibling before its agent runs.
    expect(
      agents.reduce((sum, agent) => sum + agent.calls, 0),
    ).toBeLessThanOrEqual(2);
    expect(agents[2]?.calls).toBe(0);
  });

  test("replayed steps have their own bound, maxReplayedSteps", async () => {
    const store = new KeyedStore();
    const limits = { maxSteps: 3, maxReplayedSteps: 1 };
    const first = await turn(
      gated(limits, store, ["p1", "p2"]),
      "run-r",
      START,
    );
    expect(first.types.at(-1)).toBe("workflow_waiting");

    const resumed = await turn(
      gated(limits, store, ["p1", "p2"]),
      "run-r",
      ANSWER,
    );

    expect(resumed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(resumed.error?.details).toEqual({
      limit: 1,
      limitName: "maxReplayedSteps",
      stepId: "p2",
      executedSteps: 0,
      replayedSteps: 1,
      maxSteps: 3,
      maxReplayedSteps: 1,
    });
    expect((resumed.error as { message?: string }).message).toMatch(
      /maxReplayedSteps/,
    );
  });

  test("raising maxReplayedSteps and resuming the same run in place completes it", async () => {
    const store = new KeyedStore();
    const low = { maxSteps: 3, maxReplayedSteps: 1 };
    await turn(gated(low, store, ["p1", "p2"]), "run-r2", START);
    const failed = await turn(
      gated(low, store, ["p1", "p2"]),
      "run-r2",
      ANSWER,
    );
    expect(failed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");

    const raised = gated({ maxSteps: 3, maxReplayedSteps: 2 }, store, [
      "p1",
      "p2",
    ]);
    // The replay limit stopped the run before the gate consumed the answer.
    const done = await turn(raised, "run-r2", ANSWER);

    expect(done.error).toBeUndefined();
    expect(done.types).toContain("workflow_completed");
  });

  test("a recorded failure replayed on a resume counts toward maxReplayedSteps", async () => {
    const store = new KeyedStore();
    const build = (maxReplayedSteps: number) =>
      new WorkflowAgent({
        name: "wf",
        subAgents: [
          new StepAgent("p1"),
          new FailAgent({ name: "bad" }),
          new StepAgent("gate", true),
        ],
        checkpointStore: store,
        definition: defineWorkflow({
          id: "replayed-failure",
          version: "1",
          limits: { maxSteps: 3, maxReplayedSteps },
          handler: async (ctx) => {
            await ctx.run({ id: "p1", agentName: "p1", input: "x" });
            await ctx
              .run({ id: "bad", agentName: "bad", input: "x" })
              .catch((error: { code?: string }) => {
                // Only the step's own failure is expected here.
                if (error.code === "WORKFLOW_LIMIT_EXCEEDED") throw error;
              });
            await ctx.run({ id: "gate", agentName: "gate", input: "x" });
          },
        }),
      });
    const first = await turn(build(1), "run-f", START);
    expect(first.types.at(-1)).toBe("workflow_waiting");

    const resumed = await turn(build(1), "run-f", ANSWER);

    expect(resumed.error?.details).toMatchObject({
      limitName: "maxReplayedSteps",
      stepId: "bad",
      replayedSteps: 1,
    });
    const raised = await turn(build(2), "run-f", ANSWER);
    expect(raised.error).toBeUndefined();
    expect(raised.types).toContain("workflow_completed");
  });

  test("maxReplayedSteps defaults to ten times maxSteps", async () => {
    const store = new KeyedStore();
    const pre = Array.from({ length: 11 }, (_, index) => `p${index}`);
    const first = await turn(
      gated({ maxSteps: 12 }, store, pre),
      "run-d",
      START,
    );
    expect(first.types.at(-1)).toBe("workflow_waiting");
    // With maxSteps 1 the default bound is 10, so the eleventh replay stops.
    const resumed = await turn(
      gated({ maxSteps: 1 }, store, pre),
      "run-d",
      ANSWER,
    );

    expect(resumed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(resumed.error?.details).toMatchObject({
      limitName: "maxReplayedSteps",
      limit: 10,
      replayedSteps: 10,
      maxReplayedSteps: 10,
    });
  });

  test("a step answered by a beforeStep hook counts as executed (admitted before the hook runs)", async () => {
    const agents = ["a", "b"].map((name) => new StepAgent(name));
    const workflow = new WorkflowAgent({
      name: "wf",
      subAgents: agents,
      runtimeHooks: {
        beforeStep: async ({ step }) =>
          step.id === "a"
            ? {
                status: "completed",
                id: step.id,
                agentName: step.agentName,
                output: "cached",
                attempts: 1,
                startedAt: 1,
                completedAt: 2,
              }
            : undefined,
      },
      definition: defineWorkflow({
        id: "hooked",
        version: "1",
        limits: { maxSteps: 1 },
        handler: async (ctx) => {
          await ctx.run({ id: "a", agentName: "a", input: "x" });
          await ctx.run({ id: "b", agentName: "b", input: "x" });
        },
      }),
    });

    const run = await turn(workflow, "run-hook", START);

    expect(run.error?.details).toMatchObject({
      limitName: "maxSteps",
      stepId: "b",
      executedSteps: 1,
      replayedSteps: 0,
    });
    expect(agents.map((agent) => agent.calls)).toEqual([0, 0]);
  });

  test("maxReplayedSteps must be a positive integer", async () => {
    for (const maxReplayedSteps of [0, 1.5, -1, Number.NaN]) {
      const run = await turn(
        gated({ maxSteps: 2, maxReplayedSteps }, new KeyedStore()),
        `run-invalid-${maxReplayedSteps}`,
        START,
      );
      expect(run.error?.code).toBe("WORKFLOW_DEFINITION_INVALID");
    }
  });
});

const STEP = (id: string, agent: string) =>
  `ctx.run({ id: "${id}", agentName: "${agent}", input: "x" })`;

function gatedScript(
  limits: { maxSteps?: number; maxReplayedSteps?: number },
  store: WorkflowCheckpointStore,
  pre = ["pre"],
) {
  return new ScriptWorkflowAgent({
    name: "script",
    subAgents: [
      ...pre.map((name) => new StepAgent(name)),
      new StepAgent("gate", true),
      new StepAgent("post"),
    ],
    checkpointStore: store,
    limits,
    definition: defineScriptWorkflow({
      id: "limited-script",
      version: "1",
      source: `${pre.map((name) => `yield ${STEP(name, name)};`).join(" ")} yield ${STEP("gate", "gate")}; yield ${STEP("post", "post")}; return "done";`,
    }),
  });
}

describe("maxSteps in a script workflow", () => {
  test("steps replayed from the checkpoint do not count toward maxSteps", async () => {
    const store = new KeyedStore();
    const first = await turn(
      gatedScript({ maxSteps: 2 }, store),
      "script-1",
      START,
    );
    expect(first.types.at(-1)).toBe("workflow_waiting");

    const resumed = await turn(
      gatedScript({ maxSteps: 2 }, store),
      "script-1",
      ANSWER,
    );

    expect(resumed.error).toBeUndefined();
    expect(resumed.types).toContain("workflow_completed");
  });

  test("a fresh run over maxSteps carries the same details as a handler workflow", async () => {
    const agent = new ScriptWorkflowAgent({
      name: "script",
      subAgents: [new StepAgent("a")],
      limits: { maxSteps: 1 },
      definition: defineScriptWorkflow({
        id: "fresh-script",
        version: "1",
        source: `yield ${STEP("one", "a")}; yield ${STEP("two", "a")}; return "done";`,
      }),
    });

    const run = await turn(agent, "script-2", START);

    expect(run.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(run.error?.details).toEqual({
      limit: 1,
      limitName: "maxSteps",
      stepId: "two",
      executedSteps: 1,
      replayedSteps: 0,
      maxSteps: 1,
      maxReplayedSteps: 10,
    });
  });

  test("a parallel batch that would pass the limit names its first step over it", async () => {
    const agent = new ScriptWorkflowAgent({
      name: "script",
      subAgents: [new StepAgent("a")],
      limits: { maxSteps: 2 },
      definition: defineScriptWorkflow({
        id: "parallel-script",
        version: "1",
        source: `yield ctx.parallel([${["p1", "p2", "p3"].map((id) => `{ id: "${id}", agentName: "a", input: "x" }`).join(", ")}]); return "done";`,
      }),
    });

    const run = await turn(agent, "script-3", START);

    expect(run.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(run.error?.details).toMatchObject({
      limit: 2,
      limitName: "maxSteps",
      stepId: "p3",
    });
  });

  test("replayed steps have their own bound, and raising it resumes the run in place", async () => {
    const store = new KeyedStore();
    const low = { maxSteps: 3, maxReplayedSteps: 1 };
    const pre = ["p1", "p2"];
    await turn(gatedScript(low, store, pre), "script-4", START);
    const failed = await turn(gatedScript(low, store, pre), "script-4", ANSWER);
    expect(failed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(failed.error?.details).toMatchObject({
      limit: 1,
      limitName: "maxReplayedSteps",
      stepId: "p2",
      replayedSteps: 1,
    });

    const done = await turn(
      gatedScript({ maxSteps: 3, maxReplayedSteps: 2 }, store, pre),
      "script-4",
      ANSWER,
    );

    expect(done.error).toBeUndefined();
    expect(done.types).toContain("workflow_completed");
  });

  test("without a checkpoint store the message bound stays twice maxSteps plus one", async () => {
    const agent = new ScriptWorkflowAgent({
      name: "script",
      subAgents: [new StepAgent("a")],
      limits: { maxSteps: 1 },
      definition: defineScriptWorkflow({
        id: "emit-script",
        version: "1",
        source: `for (let i = 0; i < 4; i++) yield ctx.emit({ type: "custom", name: "e", data: i }); return "done";`,
      }),
    });

    const run = await turn(agent, "script-emit", START);

    expect(run.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect((run.error as { message?: string }).message).toMatch(
      /message limit/,
    );
  });

  test("a long resumed script run fits the message bound", async () => {
    const store = new KeyedStore();
    const pre = Array.from({ length: 6 }, (_, index) => `p${index}`);
    await turn(gatedScript({ maxSteps: 7 }, store, pre), "script-5", START);

    // Six replays and two executed steps: more than twice maxSteps plus one messages.
    const done = await turn(
      gatedScript({ maxSteps: 2 }, store, pre),
      "script-5",
      ANSWER,
    );

    expect(done.error).toBeUndefined();
    expect(done.types).toContain("workflow_completed");
  });
});

describe("script workflows count steps the way the runtime does", () => {
  function settledScript(store: WorkflowCheckpointStore, post: StepAgent) {
    return new ScriptWorkflowAgent({
      name: "script",
      subAgents: [
        new FailAgent({ name: "fail" }),
        new StepAgent("gate", true),
        post,
      ],
      checkpointStore: store,
      limits: { maxSteps: 3 },
      definition: defineScriptWorkflow({
        id: "settled-script",
        version: "1",
        source: `yield ctx.parallel([{ id: "f1", agentName: "fail", input: "x" }, { id: "f2", agentName: "fail", input: "x" }], { failureMode: "all-settled" }); yield ${STEP("gate", "gate")}; yield ${STEP("post", "post")}; return "done";`,
      }),
    });
  }

  test("replayed failures of an all-settled parallel count as replayed", async () => {
    const store = new KeyedStore();
    const first = await turn(
      settledScript(store, new StepAgent("post")),
      "settled-1",
      START,
    );
    expect(first.types.at(-1)).toBe("workflow_waiting");

    // Two replayed failures, then gate and post executed: under both bounds.
    const post = new StepAgent("post");
    const second = await turn(settledScript(store, post), "settled-1", ANSWER);

    expect(second.error).toBeUndefined();
    expect(second.types).toContain("workflow_completed");
    expect(post.calls).toBe(1);
  });

  test("a step answered by a beforeStep hook does not use the replay bound", async () => {
    const agents = ["a", "b", "c"].map((name) => new StepAgent(name));
    const agent = new ScriptWorkflowAgent({
      name: "script",
      subAgents: agents,
      checkpointStore: new KeyedStore(),
      limits: { maxSteps: 3, maxReplayedSteps: 1 },
      runtimeHooks: {
        beforeStep: async ({ step }) =>
          step.id === "c"
            ? undefined
            : {
                status: "completed",
                id: step.id,
                agentName: step.agentName,
                output: "cached",
                attempts: 1,
                startedAt: 1,
                completedAt: 2,
              },
      },
      definition: defineScriptWorkflow({
        id: "hooked-script",
        version: "1",
        source: `yield ${STEP("a", "a")}; yield ${STEP("b", "b")}; yield ${STEP("c", "c")}; return "done";`,
      }),
    });

    const run = await turn(agent, "hooked-script-1", START);

    expect(run.error).toBeUndefined();
    expect(run.types).toContain("workflow_completed");
    expect(agents.map((step) => step.calls)).toEqual([0, 0, 1]);
  });
});

describe("a replayed recorded failure in an all-settled parallel", () => {
  test("its outcome is marked replayed", async () => {
    const store = new KeyedStore();
    const outcomes: unknown[] = [];
    const build = () =>
      new WorkflowAgent({
        name: "wf",
        subAgents: [
          new FailAgent({ name: "fail" }),
          new StepAgent("gate", true),
        ],
        checkpointStore: store,
        definition: defineWorkflow({
          id: "settled",
          version: "1",
          handler: async (ctx) => {
            outcomes.push(
              await ctx.parallel(
                [{ id: "f1", agentName: "fail", input: "x" }],
                { failureMode: "all-settled" },
              ),
            );
            await ctx.run({ id: "gate", agentName: "gate", input: "x" });
          },
        }),
      });
    await turn(build(), "settled-h", START);
    const resumed = await turn(build(), "settled-h", ANSWER);

    expect(resumed.error).toBeUndefined();
    expect(outcomes[0]).toEqual([
      expect.not.objectContaining({ replayed: true }),
    ]);
    expect(outcomes[1]).toEqual([
      expect.objectContaining({
        status: "failed",
        id: "f1",
        replayed: true,
        error: expect.objectContaining({ code: "WORKFLOW_EXECUTION_ERROR" }),
      }),
    ]);
  });
});
