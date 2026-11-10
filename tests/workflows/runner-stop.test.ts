import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BaseAgent,
  createEvent,
  type Event,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  logger,
  PluginManager,
  Workflow,
} from "@google/adk";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  isWorkflowCheckpointV1,
  type WorkflowCheckpointV1,
} from "../../src/workflows/checkpoint/schema.js";
import {
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  WORKFLOW_CHECKPOINT_STATE_PREFIX,
  type WorkflowCheckpointStore,
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

/**
 * Holds the one timer armed with `delayMs` so a test fires it at a chosen
 * point instead of racing the wall clock. Other timers run normally.
 */
function holdTimer(delayMs: number) {
  let callback: (() => void) | undefined;
  const realSetTimeout = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler: () => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === delayMs && callback === undefined) {
      callback = handler;
      return realSetTimeout(() => {}, 0);
    }
    return realSetTimeout(handler, delay, ...args);
  }) as unknown as typeof setTimeout);
  return {
    fire() {
      if (!callback) throw new Error(`no ${delayMs}ms timer was armed`);
      callback();
    },
    restore: () => spy.mockRestore(),
  };
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

  test("with the default session store the abort record reaches session state", async () => {
    // The runner stops reading events once the signal aborts; the workflow
    // appends the final checkpoint to the session itself.
    const worker = new BlockingAgent("worker");
    const runner = new InMemoryRunner({ agent: blockingWorkflow(worker) });
    const session = await newSession(runner);
    const controller = new AbortController();

    const running = drain(runner, session.id, controller.signal);
    await withDeadline(worker.started, 5_000, "step never started");
    controller.abort(new Error("budget exceeded"));
    const { error } = await withDeadline(running, 5_000, "runAsync hung");

    expect(error).toBeUndefined();
    expectAborted(await sessionCheckpoint(runner, session.id));
    // The runner still seals the invocation after the checkpoint event.
    const stored = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: "user",
      sessionId: session.id,
    });
    const checkpointEvent = stored?.events.findLastIndex((event) =>
      Object.keys(event.actions?.stateDelta ?? {}).some((key) =>
        key.startsWith(WORKFLOW_CHECKPOINT_STATE_PREFIX),
      ),
    );
    expect(checkpointEvent).toBeLessThan((stored?.events.length ?? 0) - 1);
  });

  test("an abort does not wait long for a delegated workflow that ignores the signal", async () => {
    let releaseInner: () => void = () => {};
    const innerReleased = new Promise<void>((resolve) => {
      releaseInner = resolve;
    });
    const quick = new BlockingAgent("quick");
    const inner = new WorkflowAgent({
      name: "inner",
      subAgents: [quick],
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: async (ctx) => {
          try {
            await ctx.run({ id: "slow", agentName: quick.name, input: "x" });
          } catch {
            // The abort stops the step; the handler goes on regardless.
          }
          // Ignores the signal: only the test releases it.
          await innerReleased;
          return "late";
        },
      }),
    });
    const outer = new WorkflowAgent({
      name: "outer",
      subAgents: [inner],
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "delegate", agentName: inner.name, input: "x" });
          return "done";
        },
      }),
    });
    const runner = new InMemoryRunner({ agent: outer });
    const session = await newSession(runner);
    const controller = new AbortController();

    try {
      const running = drain(runner, session.id, controller.signal);
      await withDeadline(quick.started, 5_000, "inner step never started");
      const abortedAt = Date.now();
      controller.abort(new Error("budget exceeded"));
      const { error } = await withDeadline(running, 3_000, "runAsync hung");

      expect(error).toBeUndefined();
      expect(Date.now() - abortedAt).toBeLessThan(2_000);
      const stored = await runner.sessionService.getSession({
        appName: runner.appName,
        userId: "user",
        sessionId: session.id,
      });
      const byWorkflow = new Map(
        Object.values(stored?.state ?? {})
          .filter(isWorkflowCheckpointV1)
          .map((checkpoint) => [checkpoint.workflowId, checkpoint]),
      );
      // The root records its own abort. The delegated run, still in its
      // handler when the grace period ended, contributes what it had recorded
      // by then: its step `interrupted`, the run itself still `running`.
      expect(byWorkflow.get("outer")?.status).toBe("cancelled");
      expect(byWorkflow.get("outer")?.steps.delegate?.status).toBe(
        "interrupted",
      );
      expect(byWorkflow.get("inner")?.status).toBe("running");
      expect(byWorkflow.get("inner")?.steps.slow?.status).toBe("interrupted");
    } finally {
      releaseInner();
    }
  });

  test("a consumer that keeps appending after an abort gets no extra checkpoint event", async () => {
    const worker = new BlockingAgent("worker");
    const agent = blockingWorkflow(worker);
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    const controller = new AbortController();
    const context = new InvocationContext({
      invocationId: "inv-1",
      agent,
      session,
      sessionService,
      userContent: { role: "user", parts: [{ text: "go" }] },
      pluginManager: new PluginManager(),
      abortSignal: controller.signal,
    });

    // Unlike the Runner, this consumer appends every event, also after the
    // abort, so the session already holds the final checkpoint.
    const consuming = (async () => {
      try {
        for await (const event of agent.runAsync(context)) {
          if (!event.partial)
            await sessionService.appendEvent({ session, event });
        }
      } catch {
        // The terminal error is expected after an abort.
      }
    })();
    await withDeadline(worker.started, 5_000, "step never started");
    controller.abort(new Error("budget exceeded"));
    await withDeadline(consuming, 5_000, "runAsync hung");

    const stored = await sessionService.getSession({
      appName: "app",
      userId: "user",
      sessionId: session.id,
    });
    expectAborted(
      Object.values(stored?.state ?? {}).find(
        isWorkflowCheckpointV1,
      ) as WorkflowCheckpointV1,
    );
    const bareCheckpointEvents = (stored?.events ?? []).filter(
      (event) =>
        event.customMetadata === undefined &&
        Object.keys(event.actions?.stateDelta ?? {}).some((key) =>
          key.startsWith(WORKFLOW_CHECKPOINT_STATE_PREFIX),
        ),
    );
    expect(bareCheckpointEvents).toEqual([]);
  });

  test("a session service that rejects the abort record leaves runAsync ending normally and logs a warning", async () => {
    const worker = new BlockingAgent("worker");
    const runner = new InMemoryRunner({ agent: blockingWorkflow(worker) });
    const session = await newSession(runner);
    const controller = new AbortController();
    const append = runner.sessionService.appendEvent.bind(
      runner.sessionService,
    );
    const appendSpy = spyOn(
      runner.sessionService,
      "appendEvent",
    ).mockImplementation(async (request) => {
      if (controller.signal.aborted && !request.event.customMetadata) {
        const keys = Object.keys(request.event.actions?.stateDelta ?? {});
        if (
          keys.some((key) => key.startsWith(WORKFLOW_CHECKPOINT_STATE_PREFIX))
        ) {
          throw new Error("session store offline");
        }
      }
      return append(request);
    });
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const running = drain(runner, session.id, controller.signal);
      await withDeadline(worker.started, 5_000, "step never started");
      controller.abort(new Error("budget exceeded"));
      const { error } = await withDeadline(running, 5_000, "runAsync hung");

      expect(error).toBeUndefined();
      expect(
        warnSpy.mock.calls.some((call) =>
          String(call[0]).includes("[WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED]"),
        ),
      ).toBe(true);
      expect((await sessionCheckpoint(runner, session.id)).status).toBe(
        "running",
      );
    } finally {
      appendSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("after an abort with the default session store the next turn re-runs the interrupted step", async () => {
    let calls = 0;
    class BlockOnceAgent extends BlockingAgent {
      protected override async *runAsyncImpl(context: InvocationContext) {
        calls += 1;
        if (calls === 1) {
          yield* super.runAsyncImpl(context);
          return;
        }
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "second" }] },
        });
      }
    }
    const worker = new BlockOnceAgent("worker");
    const runner = new InMemoryRunner({
      agent: blockingWorkflow(worker, {
        resolveExecutionId: () => "stable",
        retryFailedSteps: true,
      }),
    });
    const session = await newSession(runner);
    const controller = new AbortController();

    const first = drain(runner, session.id, controller.signal);
    await withDeadline(worker.started, 5_000, "step never started");
    controller.abort(new Error("budget exceeded"));
    await withDeadline(first, 5_000, "runAsync hung");

    // A step left `running` would be indeterminate here; an `interrupted`
    // one runs again as the next attempt.
    const second = await withDeadline(
      drain(runner, session.id),
      5_000,
      "second turn hung",
    );
    expect(second.error).toBeUndefined();
    expect(calls).toBe(2);
    const checkpoint = await sessionCheckpoint(runner, session.id);
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.steps.slow?.status).toBe("completed");
    expect(checkpoint.steps.slow?.attempts).toBe(2);
  });

  test("an abort records the delegated workflow's checkpoint through the root workflow", async () => {
    const worker = new BlockingAgent("worker");
    const inner = new WorkflowAgent({
      name: "inner",
      subAgents: [worker],
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "slow", agentName: worker.name, input: "x" });
          return "done";
        },
      }),
    });
    const outer = new WorkflowAgent({
      name: "outer",
      subAgents: [inner],
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "delegate", agentName: inner.name, input: "x" });
          return "done";
        },
      }),
    });
    const runner = new InMemoryRunner({ agent: outer });
    const session = await newSession(runner);
    const controller = new AbortController();

    const running = drain(runner, session.id, controller.signal);
    await withDeadline(worker.started, 5_000, "step never started");
    controller.abort(new Error("budget exceeded"));
    await withDeadline(running, 5_000, "runAsync hung");

    // The delegated workflow's checkpoint reaches the session forwarded by the
    // root, as on a normal turn; both record the abort.
    const stored = await runner.sessionService.getSession({
      appName: runner.appName,
      userId: "user",
      sessionId: session.id,
    });
    const checkpoints = Object.values(stored?.state ?? {}).filter(
      isWorkflowCheckpointV1,
    );
    const byWorkflow = new Map(
      checkpoints.map((checkpoint) => [checkpoint.workflowId, checkpoint]),
    );
    expect([...byWorkflow.keys()].sort()).toEqual(["inner", "outer"]);
    expect(byWorkflow.get("outer")?.status).toBe("cancelled");
    expect(byWorkflow.get("outer")?.steps.delegate?.status).toBe("interrupted");
    expectAborted(byWorkflow.get("inner") as WorkflowCheckpointV1);
    // One append after the abort, by the root: the child session is never
    // written through the parent's session service.
    const lateAppends = (stored?.events ?? []).filter(
      (event) =>
        event.customMetadata === undefined &&
        Object.keys(event.actions?.stateDelta ?? {}).some((key) =>
          key.startsWith(WORKFLOW_CHECKPOINT_STATE_PREFIX),
        ),
    );
    expect(lateAppends.map((event) => event.author)).toEqual(["outer"]);
  });

  test("a workflow execution timeout records the run cancelled and the step interrupted", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const timer = holdTimer(60_000);
      try {
        const runner = new InMemoryRunner({
          agent: blockingWorkflow(
            worker,
            { checkpointStore: store },
            { timeoutMs: 60_000 },
          ),
        });
        const session = await newSession(runner);

        const running = drain(runner, session.id);
        // The worker only returns once aborted, so only the timeout ends it,
        // and it fires once the step is in flight.
        await withDeadline(worker.started, 5_000, "step never started");
        timer.fire();
        const { error } = await withDeadline(running, 5_000, "runAsync hung");

        // Unlike a caller abort, the timeout is reported to the caller.
        expect(error).toMatchObject({ code: "WORKFLOW_ABORTED" });
        expectAborted(store.last as WorkflowCheckpointV1);
      } finally {
        timer.restore();
      }
    });
  });

  test("a timeout that fires before the step starts records the run cancelled with no step", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const timer = holdTimer(60_000);
      try {
        // The first load holds the run before its step, so the timeout fires
        // while no step is in flight: the case the wall-clock timeout hit
        // when a loaded machine delayed the step by more than its timeout.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const loading = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const gated: WorkflowCheckpointStore = {
          load: async (input) => {
            reached();
            await gate;
            return await store.load(input);
          },
          save: (input) => store.save(input),
        };
        const runner = new InMemoryRunner({
          agent: blockingWorkflow(
            worker,
            { checkpointStore: gated },
            { timeoutMs: 60_000 },
          ),
        });
        const session = await newSession(runner);

        const running = drain(runner, session.id);
        await withDeadline(loading, 5_000, "run never loaded its checkpoint");
        timer.fire();
        release();
        const { error } = await withDeadline(running, 5_000, "runAsync hung");

        expect(error).toMatchObject({ code: "WORKFLOW_ABORTED" });
        const checkpoint = store.last as WorkflowCheckpointV1;
        expect(checkpoint.status).toBe("cancelled");
        expect(checkpoint.completedAt).toBeNumber();
        expect(checkpoint.error?.code).toBe("WORKFLOW_ABORTED");
        expect(Object.keys(checkpoint.steps)).toEqual([]);
      } finally {
        timer.restore();
      }
    });
  });

  test("a timeout while the step's running record is being saved records the step interrupted and never starts the worker", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const timer = holdTimer(60_000);
      try {
        // The save that records the step `running` is held, so the timeout
        // fires after the step exists but before its worker is called.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const saving = new Promise<void>((resolve) => {
          reached = resolve;
        });
        let held = false;
        const gated: WorkflowCheckpointStore = {
          load: (input) => store.load(input),
          save: async (input) => {
            if (!held && input.checkpoint.steps.slow?.status === "running") {
              held = true;
              reached();
              await gate;
            }
            return await store.save(input);
          },
        };
        const runner = new InMemoryRunner({
          agent: blockingWorkflow(
            worker,
            { checkpointStore: gated },
            { timeoutMs: 60_000 },
          ),
        });
        const session = await newSession(runner);

        const running = drain(runner, session.id);
        await withDeadline(saving, 5_000, "step was never saved running");
        timer.fire();
        release();
        const { error } = await withDeadline(running, 5_000, "runAsync hung");

        expect(error).toMatchObject({ code: "WORKFLOW_ABORTED" });
        expectAborted(store.last as WorkflowCheckpointV1);
        const started = await Promise.race([
          worker.started.then(() => true),
          Promise.resolve(false),
        ]);
        expect(started).toBe(false);
      } finally {
        timer.restore();
      }
    });
  });

  test("a node timeout records the step interrupted once the workflow settles", async () => {
    await withStore(async (store) => {
      const worker = new BlockingAgent("worker");
      const timer = holdTimer(61_000);
      try {
        const graph = new Workflow({
          name: "graph",
          edges: [
            [
              "START",
              blockingWorkflow(worker, {
                checkpointStore: store,
                timeout: 61,
              }),
            ],
          ],
        });
        const runner = new InMemoryRunner({ agent: graph });
        const session = await newSession(runner);

        const running = drain(runner, session.id);
        // The worker only returns once aborted, so only the timeout ends it,
        // and it fires once the step is in flight.
        await withDeadline(worker.started, 5_000, "step never started");
        timer.fire();
        const { error } = await withDeadline(running, 5_000, "runAsync hung");

        // ADK reports the node timeout as an error and does not wait for the
        // workflow to wind down, so the record is written shortly after.
        expect(String(error)).toContain("timed out");
        expectAborted(await settledCheckpoint(store, "cancelled"));
      } finally {
        timer.restore();
      }
    });
  });
});
