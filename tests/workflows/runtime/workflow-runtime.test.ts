/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
} from "@google/adk";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowAgent } from "../../../src/workflows/workflow-agent.js";

interface Activity {
  active: number;
  maxActive: number;
}

class DelayedAgent extends BaseAgent {
  readonly #delayMs: number;
  readonly #output: string;
  readonly #activity: Activity;
  aborted = false;

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

function invocation(
  agent: BaseAgent,
  abortSignal?: AbortSignal,
): InvocationContext {
  return new InvocationContext({
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
    const activity = { active: 0, maxActive: 0 };
    const slow = new DelayedAgent("slow", 30, "slow-result", activity);
    const fast = new DelayedAgent("fast", 5, "fast-result", activity);
    const queued = new DelayedAgent("queued", 5, "queued-result", activity);
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

    await collect(workflow);
    expect(activity.maxActive).toBe(2);
    expect(outputs).toEqual(["slow-result", "fast-result", "queued-result"]);
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
        handler: (ctx) =>
          ctx.parallel(
            [
              { id: "one", agentName: "shared", input: "1" },
              { id: "two", agentName: "shared", input: "2" },
              { id: "three", agentName: "shared", input: "3" },
            ],
            { concurrency: 2 },
          ),
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
        handler: (ctx) =>
          ctx.parallel([
            { id: "bad", agentName: "failing", input: "bad" },
            { id: "slow", agentName: "slow", input: "slow" },
          ]),
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
        handler: (ctx) =>
          ctx.run({ id: "slow", agentName: "parent_slow", input: "slow" }),
      }),
      subAgents: [parentSlow],
    });
    const parentRun = collect(
      parentWorkflow,
      invocation(parentWorkflow, parentAbort.signal),
    );
    setTimeout(() => parentAbort.abort("cancelled by parent"), 5);
    await expect(parentRun).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
      message: "cancelled by parent",
    });
    expect(parentSlow.aborted).toBe(true);

    const timeoutSlow = new DelayedAgent("timeout_slow", 1_000, "late");
    const timeoutWorkflow = new WorkflowAgent({
      name: "timeout_workflow",
      definition: defineWorkflow({
        id: "timeout",
        version: "1",
        limits: { timeoutMs: 10 },
        handler: (ctx) =>
          ctx.run({ id: "slow", agentName: "timeout_slow", input: "slow" }),
      }),
      subAgents: [timeoutSlow],
    });
    await expect(collect(timeoutWorkflow)).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
      message: "Workflow execution timed out after 10ms",
    });
    expect(timeoutSlow.aborted).toBe(true);
  });
});

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
