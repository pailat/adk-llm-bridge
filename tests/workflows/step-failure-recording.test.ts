import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
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

class BlockingAgent extends BaseAgent {
  calls = 0;

  constructor(private readonly blockFirst: boolean) {
    super({ name: "worker" });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    if (this.blockFirst && this.calls === 1) {
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "done" }] },
    });
  }

  protected async *runLiveImpl() {}
}

function agentFor(
  worker: BaseAgent,
  store: MemoryStore,
  retryFailedSteps?: boolean,
) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [worker],
    checkpointStore: store,
    resolveExecutionId: () => "stable",
    retryFailedSteps,
    definition: defineWorkflow({
      id: "failure-recording",
      version: "1",
      handler: async (ctx) =>
        (await ctx.run({ id: "s", agentName: "worker", input: "x" })).output,
    }),
  });
}

function invocation(agent: BaseAgent, signal?: AbortSignal) {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv",
    agent,
    abortSignal: signal,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "a",
      userId: "u",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function drain(agent: BaseAgent, signal?: AbortSignal) {
  try {
    for await (const _ of agent.runAsync(invocation(agent, signal))) {
      // drain
    }
  } catch (error) {
    return error as { code?: string };
  }
  return undefined;
}

async function abortFirstRun(store: MemoryStore, retryFailedSteps?: boolean) {
  const worker = new BlockingAgent(true);
  const agent = agentFor(worker, store, retryFailedSteps);
  const controller = new AbortController();
  const running = drain(agent, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  const error = await running;
  return { worker, error };
}

describe("step failure recording", () => {
  test("an aborted attempt is recorded as failed, not left running", async () => {
    const store = new MemoryStore();
    const { error } = await abortFirstRun(store);

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(store.checkpoint?.steps.s?.status).toBe("failed");
    expect(store.checkpoint?.steps.s?.attempts).toBe(1);
  });

  test("re-entering a failed step requires opt-in, never reports it indeterminate", async () => {
    const store = new MemoryStore();
    await abortFirstRun(store);

    const worker = new BlockingAgent(false);
    const error = await drain(agentFor(worker, store));

    expect(error?.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(worker.calls).toBe(0);
  });

  test("retryFailedSteps re-runs the failed step as the next attempt", async () => {
    const store = new MemoryStore();
    await abortFirstRun(store, true);

    const worker = new BlockingAgent(false);
    const error = await drain(agentFor(worker, store, true));

    expect(error).toBeUndefined();
    expect(worker.calls).toBe(1);
    expect(store.checkpoint?.steps.s?.status).toBe("completed");
    expect(store.checkpoint?.steps.s?.attempts).toBe(2);
  });
});
