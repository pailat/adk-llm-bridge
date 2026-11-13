import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemoryRunner,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import type { WorkflowCheckpointV1 } from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
import { withDeadline } from "../agents/helpers.js";

/**
 * Behavior promised by docs/workflow-durability.md, "Stopping on Ctrl+C": the
 * supported stop procedure for a host that receives SIGINT, and the state a
 * host that dies without unwinding leaves behind.
 */

/** Blocks until aborted (when `stoppable`), then replies; signals its start. */
class BlockingAgent extends BaseAgent {
  readonly started: Promise<void>;
  calls = 0;
  #markStarted!: () => void;

  constructor(
    name: string,
    private readonly stoppable = true,
  ) {
    super({ name });
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls += 1;
    this.#markStarted();
    if (this.stoppable) {
      await new Promise<void>((resolve) => {
        if (context.abortSignal?.aborted) return resolve();
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

/** A store that holds one checkpoint, as a restarted host finds the disk. */
class SeededStore implements WorkflowCheckpointStore {
  constructor(private checkpoint: WorkflowCheckpointV1) {}

  async load() {
    return this.checkpoint;
  }

  async save(input: SaveWorkflowCheckpointInput) {
    this.checkpoint = input.checkpoint;
    return { checkpointKey: "seeded", stateDelta: {} };
  }

  get current() {
    return this.checkpoint;
  }
}

/** Keeps every checkpoint a store receives, in write order. */
class RecordingStore implements WorkflowCheckpointStore {
  readonly written: WorkflowCheckpointV1[] = [];
  readonly #inner: WorkflowCheckpointStore;

  constructor(inner: WorkflowCheckpointStore) {
    this.#inner = inner;
  }

  load(input: LoadWorkflowCheckpointInput) {
    return this.#inner.load(input);
  }

  async save(input: SaveWorkflowCheckpointInput) {
    const write = await this.#inner.save(input);
    this.written.push(input.checkpoint);
    return write;
  }

  get last() {
    return this.written.at(-1);
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fileStore() {
  const root = await mkdtemp(join(tmpdir(), "adk-sigint-stop-"));
  roots.push(root);
  return new RecordingStore(new FileSystemWorkflowCheckpointStore({ root }));
}

function workflowOf(
  worker: BaseAgent,
  store: WorkflowCheckpointStore,
  options: { retrySlowStep?: boolean } = {},
) {
  return new WorkflowAgent({
    name: "durable",
    subAgents: [worker],
    checkpointStore: store,
    definition: defineWorkflow({
      id: "sigint",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({
          id: "slow",
          agentName: worker.name,
          input: "x",
          ...(options.retrySlowStep ? { resumePolicy: "retry" as const } : {}),
        });
        return "done";
      },
    }),
  });
}

async function drainRunner(
  runner: InMemoryRunner,
  sessionId: string,
  abortSignal: AbortSignal,
) {
  try {
    for await (const _ of runner.runAsync({
      userId: "user",
      sessionId,
      newMessage: { role: "user", parts: [{ text: "go" }] },
      abortSignal,
    })) {
      // Drain.
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Runs the workflow directly under one execution id; returns what it threw. */
async function reenter(workflow: WorkflowAgent, executionId: string) {
  const context = new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: executionId,
    agent: workflow,
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
  const events: Event[] = [];
  let error: { code?: string; details?: Record<string, unknown> } | undefined;
  try {
    for await (const event of workflow.runAsync(context)) events.push(event);
  } catch (caught) {
    error = caught as typeof error;
  }
  return { events, error };
}

describe("a host that receives SIGINT", () => {
  test("a SIGINT listener that aborts the run leaves the execution cancelled and the step interrupted before the host exits", async () => {
    const store = await fileStore();
    const worker = new BlockingAgent("worker");
    const runner = new InMemoryRunner({ agent: workflowOf(worker, store) });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: "user",
    });
    const controller = new AbortController();
    // The documented pattern: a persistent listener aborts on the first
    // SIGINT and exits only after the drain; a repeat may exit at once.
    let signals = 0;
    let forcedExit = false;
    const onSigint = () => {
      signals += 1;
      if (signals === 1) controller.abort(new Error("SIGINT"));
      else forcedExit = true;
    };
    process.on("SIGINT", onSigint);
    try {
      const running = drainRunner(runner, session.id, controller.signal);
      await withDeadline(worker.started, 5_000, "step never started");

      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      const error = await withDeadline(running, 5_000, "runAsync hung");

      expect(error).toBeUndefined();
      expect(store.last?.status).toBe("cancelled");
      expect(store.last?.error?.code).toBe("WORKFLOW_ABORTED");
      expect(store.last?.steps.slow?.status).toBe("interrupted");
      // The listener stays registered, so a repeat reaches the host.
      expect(forcedExit).toBe(true);
      expect(process.listeners("SIGINT")).toContain(onSigint);
    } finally {
      process.off("SIGINT", onSigint);
    }
  });
});

describe("a host that dies without unwinding (the process tree is killed)", () => {
  async function killedMidStep() {
    const store = await fileStore();
    const worker = new BlockingAgent("worker");
    const runner = new InMemoryRunner({ agent: workflowOf(worker, store) });
    const session = await runner.sessionService.createSession({
      appName: runner.appName,
      userId: "user",
    });
    const controller = new AbortController();
    const running = drainRunner(runner, session.id, controller.signal);
    await withDeadline(worker.started, 5_000, "step never started");
    // What a killed process leaves on disk: the last write before the kill.
    const survivor = store.last;
    controller.abort(new Error("test cleanup"));
    await withDeadline(running, 5_000, "runAsync hung");
    if (!survivor) throw new Error("no checkpoint written");
    return survivor;
  }

  test("the checkpoint is left running with the step running", async () => {
    const survivor = await killedMidStep();

    expect(survivor.status).toBe("running");
    expect(survivor.steps.slow?.status).toBe("running");
    expect(survivor.steps.slow?.attempts).toBe(1);
  });

  test("a resume reports the step as indeterminate and runs nothing", async () => {
    const survivor = await killedMidStep();
    const worker = new BlockingAgent("worker", false);

    const resumed = await reenter(
      workflowOf(worker, new SeededStore(survivor)),
      survivor.executionId,
    );

    expect(resumed.error?.code).toBe("WORKFLOW_INDETERMINATE_STEP");
    expect(resumed.error?.details).toMatchObject({ stepId: "slow" });
    expect(worker.calls).toBe(0);
  });

  test("a resume of a step declared resumePolicy retry runs it again as the next attempt", async () => {
    const survivor = await killedMidStep();
    const store = new SeededStore(survivor);
    const worker = new BlockingAgent("worker", false);

    const resumed = await reenter(
      workflowOf(worker, store, { retrySlowStep: true }),
      survivor.executionId,
    );

    expect(resumed.error).toBeUndefined();
    expect(worker.calls).toBe(1);
    expect(store.current.status).toBe("completed");
    expect(store.current.steps.slow?.attempts).toBe(2);
  });
});
