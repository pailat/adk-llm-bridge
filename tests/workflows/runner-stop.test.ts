import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemoryRunner,
  type InvocationContext,
  Workflow,
} from "@google/adk";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  isWorkflowCheckpointV1,
  type WorkflowCheckpointV1,
} from "../../src/workflows/checkpoint/schema.js";
import type {
  LoadWorkflowCheckpointInput,
  SaveWorkflowCheckpointInput,
  WorkflowCheckpointStore,
} from "../../src/workflows/checkpoint/store.js";
import type { WorkflowExecutionLimits } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";
import { withDeadline } from "../agents/helpers.js";

/**
 * Behavior promised by docs/workflow-durability.md, "Stopping a run", for a
 * workflow driven through an ADK runner.
 */

/** Blocks until the run is aborted, then replies; signals when it started. */
class BlockingAgent extends BaseAgent {
  readonly started: Promise<void>;
  #markStarted!: () => void;

  constructor(name: string) {
    super({ name });
    this.started = new Promise((resolve) => {
      this.#markStarted = resolve;
    });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.#markStarted();
    await new Promise<void>((resolve) => {
      if (context.abortSignal?.aborted) return resolve();
      context.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "late" }] },
    });
  }

  protected async *runLiveImpl() {}
}

/** A file-system store that remembers the last checkpoint it wrote to disk. */
class RecordingFileStore implements WorkflowCheckpointStore {
  last?: WorkflowCheckpointV1;
  readonly #store: FileSystemWorkflowCheckpointStore;

  constructor(root: string) {
    this.#store = new FileSystemWorkflowCheckpointStore({ root });
  }

  load(input: LoadWorkflowCheckpointInput) {
    return this.#store.load(input);
  }

  async save(input: SaveWorkflowCheckpointInput) {
    const write = await this.#store.save(input);
    this.last = input.checkpoint;
    return write;
  }
}

async function withStore(
  operation: (store: RecordingFileStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "adk-runner-stop-"));
  try {
    await operation(new RecordingFileStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function blockingWorkflow(
  worker: BaseAgent,
  options: Record<string, unknown> = {},
  limits?: WorkflowExecutionLimits,
) {
  return new WorkflowAgent({
    name: "durable",
    subAgents: [worker],
    definition: defineWorkflow({
      id: "stop",
      version: "1",
      ...(limits ? { limits } : {}),
      handler: async (ctx) => {
        await ctx.run({ id: "slow", agentName: worker.name, input: "x" });
        return "done";
      },
    }),
    ...options,
  });
}

async function newSession(runner: InMemoryRunner) {
  return await runner.sessionService.createSession({
    appName: runner.appName,
    userId: "user",
  });
}

async function drain(
  runner: InMemoryRunner,
  sessionId: string,
  abortSignal?: AbortSignal,
) {
  const events: Event[] = [];
  let error: unknown;
  try {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId,
      newMessage: { role: "user", parts: [{ text: "go" }] },
      ...(abortSignal ? { abortSignal } : {}),
    })) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

async function sessionCheckpoint(
  runner: InMemoryRunner,
  sessionId: string,
): Promise<WorkflowCheckpointV1> {
  const session = await runner.sessionService.getSession({
    appName: runner.appName,
    userId: "user",
    sessionId,
  });
  const checkpoints = Object.values(session?.state ?? {}).filter(
    isWorkflowCheckpointV1,
  );
  expect(checkpoints).toHaveLength(1);
  return checkpoints[0] as WorkflowCheckpointV1;
}

/** Polls until the store has written a checkpoint with the given status. */
async function settledCheckpoint(
  store: RecordingFileStore,
  status: WorkflowCheckpointV1["status"],
): Promise<WorkflowCheckpointV1> {
  const deadline = Date.now() + 5_000;
  while (store.last?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(
        `checkpoint never became ${status}: ${store.last?.status}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return store.last;
}

function expectAborted(checkpoint: WorkflowCheckpointV1) {
  expect(checkpoint.status).toBe("cancelled");
  expect(checkpoint.completedAt).toBeNumber();
  expect(checkpoint.error?.code).toBe("WORKFLOW_ABORTED");
  expect(checkpoint.steps.slow?.status).toBe("interrupted");
  expect(checkpoint.steps.slow?.error?.code).toBe("WORKFLOW_ABORTED");
}

describe("stopping a workflow run through an ADK runner", () => {
  test("an abort mid-step ends runAsync normally once the run is recorded cancelled and the step interrupted", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const runner = new InMemoryRunner({
        agent: blockingWorkflow(worker, { checkpointStore: store }),
      });
      const session = await newSession(runner);
      const controller = new AbortController();

      const running = drain(runner, session.id, controller.signal);
      await withDeadline(worker.started, 5_000, "step never started");
      controller.abort(new Error("budget exceeded"));
      const { error } = await withDeadline(running, 5_000, "runAsync hung");

      expect(error).toBeUndefined();
      // Already on disk when runAsync ends: exiting the process now is safe.
      expectAborted(store.last as WorkflowCheckpointV1);
    });
  });

  test("with the default session store the abort record does not reach session state", async () => {
    // The runner stops reading events once the signal aborts, so the final
    // checkpoint's stateDelta is never appended to the session.
    const worker = new BlockingAgent("worker");
    const runner = new InMemoryRunner({ agent: blockingWorkflow(worker) });
    const session = await newSession(runner);
    const controller = new AbortController();

    const running = drain(runner, session.id, controller.signal);
    await withDeadline(worker.started, 5_000, "step never started");
    controller.abort(new Error("budget exceeded"));
    const { error } = await withDeadline(running, 5_000, "runAsync hung");

    expect(error).toBeUndefined();
    const checkpoint = await sessionCheckpoint(runner, session.id);
    expect(checkpoint.status).toBe("running");
    expect(checkpoint.steps.slow?.status).toBe("running");
  });

  test("a workflow execution timeout records the run cancelled and the step interrupted", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const runner = new InMemoryRunner({
        agent: blockingWorkflow(
          worker,
          { checkpointStore: store },
          { timeoutMs: 100 },
        ),
      });
      const session = await newSession(runner);

      // The worker only returns once aborted, so only the timeout ends it.
      const { error } = await withDeadline(
        drain(runner, session.id),
        5_000,
        "runAsync hung",
      );

      // Unlike a caller abort, the timeout is reported to the caller.
      expect(error).toMatchObject({ code: "WORKFLOW_ABORTED" });
      expectAborted(store.last as WorkflowCheckpointV1);
    });
  });

  test("a node timeout records the step interrupted once the workflow settles", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const graph = new Workflow({
        name: "graph",
        edges: [
          [
            "START",
            blockingWorkflow(worker, { checkpointStore: store, timeout: 0.1 }),
          ],
        ],
      });
      const runner = new InMemoryRunner({ agent: graph });
      const session = await newSession(runner);

      // The worker only returns once aborted, so only the timeout ends it.
      const { error } = await withDeadline(
        drain(runner, session.id),
        5_000,
        "runAsync hung",
      );

      // ADK reports the node timeout as an error and does not wait for the
      // workflow to wind down, so the record is written shortly after.
      expect(String(error)).toContain("timed out");
      expectAborted(await settledCheckpoint(store, "cancelled"));
    });
  });
});
