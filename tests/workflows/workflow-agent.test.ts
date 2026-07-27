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
import type { Content } from "@google/genai";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class ReplyAgent extends BaseAgent {
  calls = 0;
  readonly #outputs: Array<string | Error>;

  constructor(name: string, outputs: Array<string | Error>) {
    super({ name });
    this.#outputs = outputs;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const output =
      this.#outputs[Math.min(this.calls, this.#outputs.length - 1)];
    this.calls++;
    if (output instanceof Error) throw output;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: output }] },
    });
  }

  protected async *runLiveImpl() {}
}

function invocation(agent: BaseAgent, input = "build it"): InvocationContext {
  return new InvocationContext({
    invocationId: "inv-workflow",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: input }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
  });
}

async function collect(agent: BaseAgent, context = invocation(agent)) {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function workflowEvents(events: readonly Event[]) {
  return events
    .map((event) => event.customMetadata?.workflowEvent)
    .filter(Boolean) as Array<{ type: string; [key: string]: unknown }>;
}

describe("WorkflowAgent", () => {
  test("executes a trusted workflow as an ADK agent and streams child events", async () => {
    const worker = new ReplyAgent("worker", ["implemented"]);
    const definition = defineWorkflow({
      id: "implementation",
      version: "1",
      handler: async (ctx) => {
        expect(ctx.inputText).toBe("build it");
        ctx.emit({ type: "custom", name: "planning", data: { ready: true } });
        const result = await ctx.run({
          id: "implement",
          agentName: "worker",
          input: ctx.input,
        });
        return `final: ${result.output}`;
      },
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition,
      subAgents: [worker],
    });

    const events = await collect(workflow);
    const lifecycle = workflowEvents(events);

    expect(workflow).toBeInstanceOf(BaseAgent);
    expect(events.some((event) => event.author === "worker")).toBe(true);
    expect(events.find((event) => event.author === "worker")?.branch).toBe(
      "root.worker",
    );
    expect(events.at(-2)?.content).toEqual({
      role: "model",
      parts: [{ text: "final: implemented" }],
    });
    expect(lifecycle.map((event) => event.type)).toEqual([
      "workflow_started",
      "custom",
      "step_started",
      "step_completed",
      "output",
      "workflow_completed",
    ]);
  });

  test("only invokes directly declared sub-agents", async () => {
    const nested = new ReplyAgent("nested", ["no"]);
    const direct = new WorkflowAgent({
      name: "direct",
      definition: defineWorkflow({
        id: "inner",
        version: "1",
        handler: () => undefined,
      }),
      subAgents: [nested],
    });
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "outer",
        version: "1",
        handler: (ctx) =>
          ctx.run({ id: "nested", agentName: "nested", input: "task" }),
      }),
      subAgents: [direct],
    });

    await expect(collect(workflow)).rejects.toMatchObject({
      code: "WORKFLOW_UNKNOWN_AGENT",
    });
    expect(nested.calls).toBe(0);
  });

  test("enforces unique step ids and the execution step limit", async () => {
    const worker = new ReplyAgent("worker", ["one", "two"]);
    const duplicate = new WorkflowAgent({
      name: "duplicate",
      definition: defineWorkflow({
        id: "duplicate",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "same", agentName: "worker", input: "one" });
          await ctx.run({ id: "same", agentName: "worker", input: "two" });
        },
      }),
      subAgents: [worker],
    });
    await expect(collect(duplicate)).rejects.toMatchObject({
      code: "WORKFLOW_STEP_MISMATCH",
    });

    const limitedWorker = new ReplyAgent("limited_worker", ["one"]);
    const limited = new WorkflowAgent({
      name: "limited",
      definition: defineWorkflow({
        id: "limited",
        version: "1",
        limits: { maxSteps: 1 },
        handler: async (ctx) => {
          await ctx.run({ id: "one", agentName: "limited_worker", input: "1" });
          await ctx.run({ id: "two", agentName: "limited_worker", input: "2" });
        },
      }),
      subAgents: [limitedWorker],
    });
    await expect(collect(limited)).rejects.toMatchObject({
      code: "WORKFLOW_LIMIT_EXCEEDED",
    });
    expect(limitedWorker.calls).toBe(1);
  });

  test("retries only when the step declares an allowed retry policy", async () => {
    const worker = new ReplyAgent("worker", [new Error("temporary"), "done"]);
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "retry",
        version: "1",
        limits: { maxAttemptsPerStep: 2 },
        handler: async (ctx) => {
          const result = await ctx.run({
            id: "retry-step",
            agentName: "worker",
            input: "task",
            retry: { maxAttempts: 2 },
          });
          return result.output;
        },
      }),
      subAgents: [worker],
    });

    const events = await collect(workflow);
    const completed = workflowEvents(events).find(
      (event) => event.type === "step_completed",
    );
    expect(worker.calls).toBe(2);
    expect(
      (completed?.result as { attempts?: number } | undefined)?.attempts,
    ).toBe(2);
    expect(events.at(-2)?.content?.parts?.[0]?.text).toBe("done");
  });

  test("preserves Content returned by a trusted workflow", async () => {
    const content: Content = {
      role: "model",
      parts: [{ text: "structured" }],
    };
    const workflow = new WorkflowAgent({
      name: "workflow",
      definition: defineWorkflow({
        id: "content",
        version: "1",
        handler: () => content,
      }),
    });

    const events = await collect(workflow);
    expect(events.at(-2)?.content).toBe(content);
  });
});
