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
import type {
  WorkflowContext,
  WorkflowStep,
} from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type { WorkflowRuntimeHooks } from "../../src/workflows/runtime/workflow-runtime.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class MemoryStore implements WorkflowCheckpointStore {
  checkpoint?: WorkflowCheckpointV1;
  /** Called with each checkpoint before the save returns. */
  onSave?: (checkpoint: WorkflowCheckpointV1) => void;

  async load() {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    this.onSave?.(input.checkpoint);
    return { checkpointKey: "k", stateDelta: { k: input.checkpoint } };
  }
}

/** What the worker does on each call, in order; later calls succeed. */
type CallBehavior = "block" | "block-rethrow" | "fail" | "ok";

class ScriptedAgent extends BaseAgent {
  calls = 0;
  #blocked = 0;
  #waiters: Array<{ count: number; resolve: () => void }> = [];

  constructor(
    private readonly behaviors: readonly CallBehavior[] = [],
    name = "worker",
  ) {
    super({ name });
  }

  /** Resolves once `count` calls are blocked on their abort signal. */
  blocked(count = 1): Promise<void> {
    if (this.#blocked >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiters.push({ count, resolve });
    });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const behavior = this.behaviors[this.calls] ?? "ok";
    this.calls += 1;
    if (behavior === "block" || behavior === "block-rethrow") {
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
        this.#blocked += 1;
        for (const waiter of this.#waiters) {
          if (this.#blocked >= waiter.count) waiter.resolve();
        }
      });
      if (behavior === "block-rethrow") throw context.abortSignal?.reason;
    }
    if (behavior === "fail") {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorCode: "MODEL_ERROR",
        errorMessage: "model_not_found",
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "done" }] },
    });
  }

  protected async *runLiveImpl() {}
}

type WorkflowEventRecord = {
  type?: string;
  stepId?: string;
  attempt?: number;
  resumeReason?: string;
};

const oneStep = (overrides: Partial<WorkflowStep> = {}) =>
  async function handler(ctx: WorkflowContext) {
    return (
      await ctx.run({ id: "s", agentName: "worker", input: "x", ...overrides })
    ).output;
  };

function agentFor(
  worker: BaseAgent,
  store: MemoryStore,
  options: {
    retryFailedSteps?: boolean;
    handler?: (ctx: WorkflowContext) => Promise<string | undefined>;
    others?: BaseAgent[];
    runtimeHooks?: WorkflowRuntimeHooks;
  } = {},
) {
  return new WorkflowAgent({
    name: "workflow",
    subAgents: [worker, ...(options.others ?? [])],
    checkpointStore: store,
    resolveExecutionId: () => "stable",
    retryFailedSteps: options.retryFailedSteps,
    runtimeHooks: options.runtimeHooks,
    definition: defineWorkflow({
      id: "failure-recording",
      version: "1",
      limits: { maxAttemptsPerStep: 2 },
      handler: options.handler ?? oneStep(),
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

async function drain(
  agent: BaseAgent,
  signal?: AbortSignal,
  events: WorkflowEventRecord[] = [],
) {
  try {
    for await (const event of agent.runAsync(invocation(agent, signal))) {
      const workflowEvent = event.customMetadata?.workflowEvent;
      if (workflowEvent) events.push(workflowEvent as WorkflowEventRecord);
    }
  } catch (error) {
    return error as { code?: string };
  }
  return undefined;
}

async function abortFirstRun(
  store: MemoryStore,
  options: {
    retryFailedSteps?: boolean;
    behavior?: CallBehavior;
    reason?: unknown;
    events?: WorkflowEventRecord[];
  } = {},
) {
  const worker = new ScriptedAgent([options.behavior ?? "block"]);
  const agent = agentFor(worker, store, options);
  const controller = new AbortController();
  const running = drain(agent, controller.signal, options.events);
  await worker.blocked();
  controller.abort(options.reason);
  const error = await running;
  return { worker, error };
}

const types = (events: WorkflowEventRecord[]) =>
  events.map((event) => event.type);

describe("step failure recording", () => {
  test("an aborted attempt is recorded as interrupted, not left running", async () => {
    const store = new MemoryStore();
    const events: WorkflowEventRecord[] = [];
    const { error } = await abortFirstRun(store, { events });

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.completedAt).toBeDefined();
    expect(store.checkpoint?.steps.s?.status).toBe("interrupted");
    expect(store.checkpoint?.steps.s?.attempts).toBe(1);
    expect(store.checkpoint?.steps.s?.error?.code).toBe("WORKFLOW_ABORTED");
    const interrupted = events.filter((e) => e.type === "step_interrupted");
    expect(interrupted).toEqual([
      expect.objectContaining({ stepId: "s", attempt: 1 }),
    ]);
    expect(types(events).indexOf("step_interrupted")).toBeLessThan(
      types(events).indexOf("error"),
    );
  });

  test("a step that rethrows a custom abort reason is still interrupted", async () => {
    const store = new MemoryStore();
    const { error } = await abortFirstRun(store, {
      behavior: "block-rethrow",
      reason: new Error("budget"),
    });
    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.steps.s?.status).toBe("interrupted");
  });

  test("re-entering an interrupted step without opt-in is indeterminate", async () => {
    const store = new MemoryStore();
    await abortFirstRun(store);

    const worker = new ScriptedAgent();
    const error = await drain(agentFor(worker, store));

    // Without opt-in an interrupted step may have had side effects.
    expect(error?.code).toBe("WORKFLOW_INDETERMINATE_STEP");
    expect(worker.calls).toBe(0);
    expect(store.checkpoint?.status).toBe("failed");
  });

  test("retryFailedSteps re-runs the interrupted step as the next attempt", async () => {
    const store = new MemoryStore();
    await abortFirstRun(store, { retryFailedSteps: true });

    const worker = new ScriptedAgent();
    const events: WorkflowEventRecord[] = [];
    const error = await drain(
      agentFor(worker, store, { retryFailedSteps: true }),
      undefined,
      events,
    );

    expect(error).toBeUndefined();
    expect(worker.calls).toBe(1);
    expect(events.find((e) => e.type === "step_started")).toEqual(
      expect.objectContaining({ attempt: 2, resumeReason: "interrupted" }),
    );
    expect(store.checkpoint?.status).toBe("completed");
    expect(store.checkpoint?.steps.s?.status).toBe("completed");
    expect(store.checkpoint?.steps.s?.attempts).toBe(2);
    expect(store.checkpoint?.steps.s?.resumeReason).toBe("interrupted");
  });

  test('resumePolicy "retry" alone re-runs the interrupted step', async () => {
    const store = new MemoryStore();
    const handler = oneStep({ resumePolicy: "retry" });
    const first = new ScriptedAgent(["block"]);
    const controller = new AbortController();
    const running = drain(
      agentFor(first, store, { handler }),
      controller.signal,
    );
    await first.blocked();
    controller.abort();
    await running;
    expect(store.checkpoint?.steps.s?.status).toBe("interrupted");

    const worker = new ScriptedAgent();
    const error = await drain(agentFor(worker, store, { handler }));
    expect(error).toBeUndefined();
    expect(worker.calls).toBe(1);
    expect(store.checkpoint?.steps.s?.attempts).toBe(2);
    expect(store.checkpoint?.steps.s?.resumeReason).toBe("interrupted");
  });

  test("an ordinary agent failure is recorded failed and emits no step_interrupted", async () => {
    const store = new MemoryStore();
    const events: WorkflowEventRecord[] = [];
    const error = await drain(
      agentFor(new ScriptedAgent(["fail"]), store),
      undefined,
      events,
    );
    expect(error?.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(store.checkpoint?.steps.s?.status).toBe("failed");
    expect(types(events)).toContain("step_failed");
    expect(types(events)).not.toContain("step_interrupted");
  });

  test("an abort while the running record is saved records the step interrupted", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    store.onSave = (checkpoint) => {
      if (checkpoint.steps.s?.status === "running") controller.abort();
    };
    const worker = new ScriptedAgent();
    const events: WorkflowEventRecord[] = [];
    let beforeStepCalls = 0;
    const runtimeHooks: WorkflowRuntimeHooks = {
      beforeStep: async () => {
        beforeStepCalls += 1;
        return undefined;
      },
    };
    const error = await drain(
      agentFor(worker, store, { runtimeHooks }),
      controller.signal,
      events,
    );

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(worker.calls).toBe(0);
    expect(beforeStepCalls).toBe(0);
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.steps.s?.status).toBe("interrupted");
    expect(store.checkpoint?.steps.s?.attempts).toBe(1);
    expect(events.filter((e) => e.type === "step_interrupted")).toEqual([
      expect.objectContaining({ stepId: "s", attempt: 1 }),
    ]);
  });

  test("an abort during the retry delay keeps the failed attempt and records no new one", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    store.onSave = (checkpoint) => {
      if (checkpoint.steps.s?.status === "failed") controller.abort();
    };
    const handler = oneStep({ retry: { maxAttempts: 2, delayMs: 60_000 } });
    const worker = new ScriptedAgent(["fail"]);
    const events: WorkflowEventRecord[] = [];
    const error = await drain(
      agentFor(worker, store, { handler }),
      controller.signal,
      events,
    );

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(worker.calls).toBe(1);
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.steps.s?.status).toBe("failed");
    expect(store.checkpoint?.steps.s?.attempts).toBe(1);
    expect(store.checkpoint?.steps.s?.error?.code).toBe(
      "WORKFLOW_EXECUTION_ERROR",
    );
    expect(types(events)).not.toContain("step_interrupted");
    expect(
      events.filter((e) => e.type === "step_started").map((e) => e.attempt),
    ).toEqual([1]);

    // A resume without opt-in replays the real failure.
    store.onSave = undefined;
    const resumed = await drain(
      agentFor(new ScriptedAgent(), store, { handler }),
    );
    expect(resumed?.code).toBe("WORKFLOW_EXECUTION_ERROR");
  });

  test("two parallel steps in flight are both interrupted", async () => {
    const store = new MemoryStore();
    const worker = new ScriptedAgent(["block"]);
    const other = new ScriptedAgent(["block"], "other");
    const handler = async (ctx: WorkflowContext) => {
      await ctx.parallel([
        { id: "a", agentName: "worker", input: "a" },
        { id: "b", agentName: "other", input: "b" },
      ]);
      return "done";
    };
    const controller = new AbortController();
    const events: WorkflowEventRecord[] = [];
    const running = drain(
      agentFor(worker, store, { handler, others: [other] }),
      controller.signal,
      events,
    );
    await Promise.all([worker.blocked(), other.blocked()]);
    controller.abort();
    const error = await running;

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.steps.a?.status).toBe("interrupted");
    expect(store.checkpoint?.steps.b?.status).toBe("interrupted");
    const interrupted = events
      .filter((e) => e.type === "step_interrupted")
      .map((e) => e.stepId)
      .sort();
    expect(interrupted).toEqual(["a", "b"]);
    const lastInterrupted = types(events).lastIndexOf("step_interrupted");
    expect(lastInterrupted).toBeLessThan(types(events).indexOf("error"));
  });

  test("an abort between steps leaves the next step unrecorded", async () => {
    const store = new MemoryStore();
    const controller = new AbortController();
    store.onSave = (checkpoint) => {
      if (checkpoint.steps.s1?.status === "completed") controller.abort();
    };
    const worker = new ScriptedAgent();
    const handler = async (ctx: WorkflowContext) => {
      await ctx.run({ id: "s1", agentName: "worker", input: "1" });
      return (await ctx.run({ id: "s2", agentName: "worker", input: "2" }))
        .output;
    };
    const events: WorkflowEventRecord[] = [];
    const error = await drain(
      agentFor(worker, store, { handler }),
      controller.signal,
      events,
    );

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(worker.calls).toBe(1);
    expect(store.checkpoint?.status).toBe("cancelled");
    expect(store.checkpoint?.steps.s1?.status).toBe("completed");
    expect(store.checkpoint?.steps.s2).toBeUndefined();
    expect(types(events)).not.toContain("step_interrupted");
  });

  test("an abort during a retry attempt records that attempt as interrupted", async () => {
    const store = new MemoryStore();
    const handler = oneStep({ retry: { maxAttempts: 2 } });
    const worker = new ScriptedAgent(["fail", "block"]);
    const controller = new AbortController();
    const events: WorkflowEventRecord[] = [];
    const running = drain(
      agentFor(worker, store, { handler }),
      controller.signal,
      events,
    );
    await worker.blocked();
    controller.abort();
    const error = await running;

    expect(error?.code).toBe("WORKFLOW_ABORTED");
    expect(store.checkpoint?.steps.s?.status).toBe("interrupted");
    expect(store.checkpoint?.steps.s?.attempts).toBe(2);
    expect(events.filter((e) => e.type === "step_interrupted")).toEqual([
      expect.objectContaining({ stepId: "s", attempt: 2 }),
    ]);
  });

  test("a hook that throws records the step failed without step_interrupted", async () => {
    const store = new MemoryStore();
    const runtimeHooks: WorkflowRuntimeHooks = {
      beforeAttempt: async () => {
        throw new Error("hook failed");
      },
    };
    const events: WorkflowEventRecord[] = [];
    const error = await drain(
      agentFor(new ScriptedAgent(), store, { runtimeHooks }),
      undefined,
      events,
    );

    expect(error).toBeDefined();
    expect(store.checkpoint?.steps.s?.status).toBe("failed");
    expect(types(events)).not.toContain("step_interrupted");
  });
});
