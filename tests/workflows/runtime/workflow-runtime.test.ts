import { describe, expect, spyOn, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";
import { InMemoryWorkspaceAdapter } from "../../../src/workflows/workspace/in-memory-workspace-adapter.js";

interface Activity {
  active: number;
  maxActive: number;
}

/** Workflow timeout armed by the timeout tests; the test fires it, so it never races the clock. */
const TIMEOUT_MS = 60_000;

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

class DelayedAgent extends BaseAgent {
  readonly #delayMs: number;
  readonly #output: string;
  readonly #activity: Activity;
  aborted = false;
  entered = false;
  readonly started = deferred<void>();

  constructor(
    name: string,
    delayMs: number,
    output: string,
    activity: Activity = { active: 0, maxActive: 0 },
  ) {
    super({ name });
    this.#delayMs = delayMs;
    this.#output = output;
    this.#activity = activity;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.entered = true;
    this.started.resolve();
    this.#activity.active++;
    this.#activity.maxActive = Math.max(
      this.#activity.maxActive,
      this.#activity.active,
    );
    try {
      await wait(this.#delayMs, context.abortSignal, () => {
        this.aborted = true;
      });
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: { role: "model", parts: [{ text: this.#output }] },
      });
    } finally {
      this.#activity.active--;
    }
  }

  protected async *runLiveImpl() {}
}

class FailingAgent extends BaseAgent {
  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("planned failure");
  }

  protected async *runLiveImpl() {}
}

class ControlledAgent extends BaseAgent {
  readonly started = deferred<void>();
  readonly proceed = deferred<void>();
  hasStarted = false;

  constructor(name: string) {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.hasStarted = true;
    this.started.resolve();
    await waitFor(this.proceed.promise, context.abortSignal);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: `${this.name}-done` }] },
    });
  }

  protected async *runLiveImpl() {}
}

function invocation(
  agent: BaseAgent,
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-parallel",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "task" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
    abortSignal,
  });
}

async function collect(agent: BaseAgent, context = invocation(agent)) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

describe("WorkflowRuntime parallel execution", () => {
  test("runs different agents concurrently and preserves result order", async () => {
    const slow = new ControlledAgent("slow");
    const fast = new ControlledAgent("fast");
    const queued = new ControlledAgent("queued");
    let outputs: string[] = [];
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "parallel",
        version: "1",
        limits: { maxConcurrency: 2 },
        handler: async (ctx) => {
          const results = await ctx.parallel([
            { id: "slow", agentName: "slow", input: "one" },
            { id: "fast", agentName: "fast", input: "two" },
            { id: "queued", agentName: "queued", input: "three" },
          ]);
          outputs = results.map((result) =>
            result.status === "completed" ? result.output : "failed",
          );
        },
      }),
      subAgents: [slow, fast, queued],
    });

    const running = collect(workflow);
    // Both permits are taken at once, and the third step waits for one.
    await Promise.all([slow.started.promise, fast.started.promise]);
    // A negative check needs a window: a broken cap starts the third step on a
    // later timer turn, so checking at once would miss it. Correct code cannot
    // fail this wait, because the third step cannot start before a permit is
    // released, however long the window is. The runtime exposes no "blocked on
    // the permit" signal to wait on instead.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queued.hasStarted).toBe(false);
    fast.proceed.resolve();
    await queued.started.promise;
    slow.proceed.resolve();
    queued.proceed.resolve();
    await running;
    expect(outputs).toEqual(["slow-done", "fast-done", "queued-done"]);
  });

  test("honors per-call concurrency and serializes the same BaseAgent", async () => {
    const sharedActivity = { active: 0, maxActive: 0 };
    const shared = new DelayedAgent("shared", 8, "done", sharedActivity);
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "serialized",
        version: "1",
        limits: { maxConcurrency: 3 },
        handler: async (ctx) => {
          await ctx.parallel(
            [
              { id: "one", agentName: "shared", input: "1" },
              { id: "two", agentName: "shared", input: "2" },
              { id: "three", agentName: "shared", input: "3" },
            ],
            { concurrency: 2 },
          );
        },
      }),
      subAgents: [shared],
    });

    await collect(workflow);
    expect(sharedActivity.maxActive).toBe(1);
  });

  test("returns ordered failures in all-settled mode", async () => {
    const failing = new FailingAgent("failing");
    const good = new DelayedAgent("good", 1, "ok");
    let statuses: string[] = [];
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "settled",
        version: "1",
        limits: { maxConcurrency: 2 },
        handler: async (ctx) => {
          const results = await ctx.parallel(
            [
              { id: "bad", agentName: "failing", input: "bad" },
              { id: "good", agentName: "good", input: "good" },
            ],
            { failureMode: "all-settled" },
          );
          statuses = results.map((result) => result.status);
        },
      }),
      subAgents: [failing, good],
    });

    await collect(workflow);
    expect(statuses).toEqual(["failed", "completed"]);
  });

  test("fail-fast aborts sibling steps", async () => {
    const failing = new FailingAgent("failing");
    const slow = new DelayedAgent("slow", 1_000, "late");
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "fail-fast",
        version: "1",
        limits: { maxConcurrency: 2 },
        handler: async (ctx) => {
          await ctx.parallel([
            { id: "bad", agentName: "failing", input: "bad" },
            { id: "slow", agentName: "slow", input: "slow" },
          ]);
        },
      }),
      subAgents: [failing, slow],
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_EXECUTION_ERROR",
    });
    expect(slow.aborted).toBe(true);
  });

  test("propagates parent cancellation and the workflow timeout", async () => {
    const parentAbort = new AbortController();
    const parentSlow = new DelayedAgent("parent_slow", 1_000, "late");
    const parentWorkflow = new WorkflowAgent({
      name: "parent_workflow",
      definition: defineWorkflow({
        id: "parent-abort",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "slow",
              agentName: "parent_slow",
              input: "slow",
            })
          ).output,
      }),
      subAgents: [parentSlow],
    });
    const parentRun = collect(
      parentWorkflow,
      invocation(parentWorkflow, parentAbort.signal),
    );
    await parentSlow.started.promise;
    parentAbort.abort("cancelled by parent");
    await expect(parentRun).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
      message: "cancelled by parent",
    });
    expect(parentSlow.aborted).toBe(true);
  });

  test("a workflow timeout aborts the step in flight", async () => {
    const timer = holdTimer(TIMEOUT_MS);
    try {
      const timeoutSlow = new DelayedAgent("timeout_slow", 61_000, "late");
      const timeoutWorkflow = new WorkflowAgent({
        name: "timeout_workflow",
        definition: defineWorkflow({
          id: "timeout",
          version: "1",
          limits: { timeoutMs: TIMEOUT_MS },
          handler: async (ctx) =>
            (
              await ctx.run({
                id: "slow",
                agentName: "timeout_slow",
                input: "slow",
              })
            ).output,
        }),
        subAgents: [timeoutSlow],
      });
      const running = collect(timeoutWorkflow).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      // The timeout only fires once the step is in flight, never before it.
      await timeoutSlow.started.promise;
      timer.fire();
      expect(await running).toMatchObject({
        code: "WORKFLOW_ABORTED",
        message: `Workflow execution timed out after ${TIMEOUT_MS}ms`,
      });
      expect(timeoutSlow.aborted).toBe(true);
    } finally {
      timer.restore();
    }
  });

  test("a step that has not started when the workflow times out never runs", async () => {
    const timer = holdTimer(TIMEOUT_MS);
    try {
      const idle = new DelayedAgent("idle", 61_000, "late");
      const reached = deferred<void>();
      const release = deferred<void>();
      const workflow = new WorkflowAgent({
        name: "idle_workflow",
        definition: defineWorkflow({
          id: "timeout-before-step",
          version: "1",
          limits: { timeoutMs: TIMEOUT_MS },
          handler: async (ctx) => {
            reached.resolve();
            await release.promise;
            return (
              await ctx.run({ id: "idle", agentName: "idle", input: "idle" })
            ).output;
          },
        }),
        subAgents: [idle],
      });
      const running = collect(workflow).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      await reached.promise;
      timer.fire();
      release.resolve();
      expect(await running).toMatchObject({
        code: "WORKFLOW_ABORTED",
        message: `Workflow execution timed out after ${TIMEOUT_MS}ms`,
      });
      // The step was requested after the timeout, so it is refused before the
      // agent is called: nothing runs on after the workflow timed out.
      expect(idle.entered).toBe(false);
      expect(idle.aborted).toBe(false);
    } finally {
      timer.restore();
    }
  });

  test("a step held in beforeAttempt when the workflow times out never runs", async () => {
    const timer = holdTimer(TIMEOUT_MS);
    try {
      const idle = new DelayedAgent("idle", 61_000, "late");
      const reached = deferred<void>();
      const release = deferred<void>();
      const workflow = new WorkflowAgent({
        name: "attempt_workflow",
        definition: defineWorkflow({
          id: "timeout-before-attempt",
          version: "1",
          limits: { timeoutMs: TIMEOUT_MS },
          handler: async (ctx) =>
            (await ctx.run({ id: "idle", agentName: "idle", input: "idle" }))
              .output,
        }),
        subAgents: [idle],
        runtimeHooks: {
          beforeAttempt: async () => {
            reached.resolve();
            await release.promise;
            return undefined;
          },
        },
      });
      const running = collect(workflow).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      // The step is already saved running and its signal exists, but the
      // agent has not been called when the timeout fires.
      await reached.promise;
      timer.fire();
      release.resolve();
      expect(await running).toMatchObject({
        code: "WORKFLOW_ABORTED",
        message: `Workflow execution timed out after ${TIMEOUT_MS}ms`,
      });
      expect(idle.entered).toBe(false);
    } finally {
      timer.restore();
    }
  });

  test("serializes overlapping write paths while disjoint paths remain concurrent", async () => {
    const workspace = new InMemoryWorkspaceAdapter();
    const first = new ControlledAgent("first");
    const overlapping = new ControlledAgent("overlapping");
    const disjoint = new ControlledAgent("disjoint");
    const workflow = new WorkflowAgent({
      name: "workspace_workflow",
      definition: defineWorkflow({
        id: "workspace-parallel",
        version: "1",
        limits: { maxConcurrency: 3 },
        handler: async (ctx) => {
          await ctx.parallel([
            {
              id: "first",
              agentName: "first",
              input: "first",
              writePaths: ["src/shared"],
            },
            {
              id: "overlapping",
              agentName: "overlapping",
              input: "overlapping",
              writePaths: ["src/shared/file.ts"],
            },
            {
              id: "disjoint",
              agentName: "disjoint",
              input: "disjoint",
              writePaths: ["docs"],
            },
          ]);
        },
      }),
      subAgents: [first, overlapping, disjoint],
      workspace: { workspaceId: "repo", adapter: workspace },
    });

    const execution = collect(workflow);
    await Promise.all([first.started.promise, disjoint.started.promise]);
    expect(overlapping.hasStarted).toBe(false);

    disjoint.proceed.resolve();
    first.proceed.resolve();
    await overlapping.started.promise;
    overlapping.proceed.resolve();
    await execution;

    const lease = await workspace.acquire({
      workspaceId: "repo",
      ownerId: "verification",
      writePaths: ["src/shared", "docs"],
    });
    expect(await lease.release()).toBe(true);
  });

  test("releases write ownership after step failure", async () => {
    const workspace = new InMemoryWorkspaceAdapter();
    const failing = new FailingAgent("failing");
    const recovery = new DelayedAgent("recovery", 1, "recovered");
    let output: string | undefined;
    const workflow = new WorkflowAgent({
      name: "workspace_workflow",
      definition: defineWorkflow({
        id: "workspace-failure",
        version: "1",
        handler: async (ctx) => {
          try {
            await ctx.run({
              id: "failing",
              agentName: "failing",
              input: "fail",
              writePaths: ["src/shared"],
            });
          } catch {
            const result = await ctx.run({
              id: "recovery",
              agentName: "recovery",
              input: "recover",
              writePaths: ["src/shared"],
            });
            output = result.output;
          }
        },
      }),
      subAgents: [failing, recovery],
      workspace: { workspaceId: "repo", adapter: workspace },
    });

    await collect(workflow);
    expect(output).toBe("recovered");
  });

  test("releases write ownership when execution is aborted", async () => {
    const workspace = new InMemoryWorkspaceAdapter();
    const waiting = new ControlledAgent("waiting");
    const controller = new AbortController();
    const workflow = new WorkflowAgent({
      name: "workspace_workflow",
      definition: defineWorkflow({
        id: "workspace-abort",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "waiting",
              agentName: "waiting",
              input: "wait",
              writePaths: ["src/shared"],
            })
          ).output,
      }),
      subAgents: [waiting],
      workspace: { workspaceId: "repo", adapter: workspace },
    });

    const execution = collect(
      workflow,
      invocation(workflow, controller.signal),
    );
    await waiting.started.promise;
    controller.abort(new Error("stop workspace step"));
    await expect(execution).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" });

    const lease = await workspace.acquire(
      {
        workspaceId: "repo",
        ownerId: "verification",
        writePaths: ["src/shared"],
      },
      { signal: AbortSignal.timeout(250) },
    );
    expect(await lease.release()).toBe(true);
  });

  test("requires workspace configuration when a step declares write paths", async () => {
    const worker = new DelayedAgent("worker", 1, "never");
    const workflow = new WorkflowAgent({
      name: "workspace_workflow",
      definition: defineWorkflow({
        id: "workspace-required",
        version: "1",
        handler: async (ctx) =>
          (
            await ctx.run({
              id: "writer",
              agentName: "worker",
              input: "write",
              writePaths: ["src"],
            })
          ).output,
      }),
      subAgents: [worker],
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_INVALID",
      message:
        "Workflow step writer declares writePaths without a workspace adapter",
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function wait(
  delayMs: number,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      onAbort();
      reject(signal?.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
