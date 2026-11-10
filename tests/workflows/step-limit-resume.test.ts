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

/** Gate in the middle of the run, then one more step after the answer. */
function gated(maxSteps: number, store: WorkflowCheckpointStore) {
  return new WorkflowAgent({
    name: "wf",
    subAgents: [
      new StepAgent("pre"),
      new StepAgent("gate", true),
      new StepAgent("post"),
    ],
    checkpointStore: store,
    definition: defineWorkflow({
      id: "limited",
      version: "1",
      limits: { maxSteps },
      handler: async (ctx) => {
        await ctx.run({ id: "pre", agentName: "pre", input: "x" });
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
  test("steps replayed from the checkpoint count toward the limit, and the error says how many were replays", async () => {
    const store = new KeyedStore();
    const first = await turn(gated(2, store), "run-1", START);
    expect(first.error).toBeUndefined();
    expect(first.types.at(-1)).toBe("workflow_waiting");

    const resumed = await turn(gated(2, store), "run-1", ANSWER);

    expect(resumed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect(resumed.error?.details).toMatchObject({
      limit: 2,
      stepId: "post",
      replayedSteps: 1,
    });
  });

  test("raising the limit and resuming the same run in place completes it", async () => {
    const store = new KeyedStore();
    await turn(gated(2, store), "run-2", START);
    const failed = await turn(gated(2, store), "run-2", ANSWER);
    expect(failed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");

    const raised = gated(3, store);
    // The answer was already consumed before the limit stopped the run.
    const done = await turn(raised, "run-2", START);

    expect(done.error).toBeUndefined();
    expect(done.types).toContain("workflow_completed");
  });
});

const STEP = (id: string, agent: string) =>
  `ctx.run({ id: "${id}", agentName: "${agent}", input: "x" })`;

function gatedScript(maxSteps: number, store: WorkflowCheckpointStore) {
  return new ScriptWorkflowAgent({
    name: "script",
    subAgents: [
      new StepAgent("pre"),
      new StepAgent("gate", true),
      new StepAgent("post"),
    ],
    checkpointStore: store,
    limits: { maxSteps },
    definition: defineScriptWorkflow({
      id: "limited-script",
      version: "1",
      source: `yield ${STEP("pre", "pre")}; yield ${STEP("gate", "gate")}; yield ${STEP("post", "post")}; return "done";`,
    }),
  });
}

describe("maxSteps in a script workflow", () => {
  const MESSAGE = /steps replayed from the checkpoint .* count too/;

  test("the error carries the limit, the step id and the replay count, like a handler workflow", async () => {
    const store = new KeyedStore();
    const first = await turn(gatedScript(2, store), "script-1", START);
    expect(first.types.at(-1)).toBe("workflow_waiting");

    const resumed = await turn(gatedScript(2, store), "script-1", ANSWER);

    expect(resumed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");
    expect((resumed.error as { message?: string }).message).toMatch(MESSAGE);
    expect(resumed.error?.details).toMatchObject({
      limit: 2,
      stepId: "post",
      replayedSteps: 1,
    });
  });

  test("a fresh run over the limit reports no replays", async () => {
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
    expect(run.error?.details).toMatchObject({
      limit: 1,
      stepId: "two",
      replayedSteps: 0,
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
    expect(run.error?.details).toMatchObject({ limit: 2, stepId: "p3" });
  });

  test("raising the limit and resuming a script run in place completes it", async () => {
    const store = new KeyedStore();
    await turn(gatedScript(2, store), "script-4", START);
    const failed = await turn(gatedScript(2, store), "script-4", ANSWER);
    expect(failed.error?.code).toBe("WORKFLOW_LIMIT_EXCEEDED");

    const done = await turn(gatedScript(3, store), "script-4", START);

    expect(done.error).toBeUndefined();
    expect(done.types).toContain("workflow_completed");
  });
});
