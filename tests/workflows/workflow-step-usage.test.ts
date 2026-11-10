import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  PluginManager,
} from "@google/adk";
import type { WorkflowStepUsage } from "../../src/workflows/contracts.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepReplayedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

/** Yields one model event per `[prompt, completion]` pair, with usage. */
class UsageAgent extends BaseAgent {
  calls = 0;
  readonly #usages: Array<[number, number]>;

  constructor(name: string, usages: Array<[number, number]>) {
    super({ name });
    this.#usages = usages;
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    this.calls++;
    for (const [prompt, completion] of this.#usages) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: { role: "model", parts: [{ text: "ok" }] },
        usageMetadata: {
          promptTokenCount: prompt,
          candidatesTokenCount: completion,
          totalTokenCount: prompt + completion,
        },
      });
    }
  }

  protected async *runLiveImpl() {}
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-usage",
    branch: "root",
    agent,
    userContent: { role: "user", parts: [{ text: "go" }] },
    session: {
      id: "s",
      appName: "app",
      userId: "u",
      state,
      events: [],
      lastUpdateTime: 1,
    },
  });
}

function workflowEventOf(event: Event): WorkflowEvent | undefined {
  return event.customMetadata?.workflowEvent as WorkflowEvent | undefined;
}

function isStepCompleted(
  event: WorkflowEvent | undefined,
): event is WorkflowStepCompletedEvent {
  return event?.type === "step_completed";
}

function isStepReplayed(
  event: WorkflowEvent | undefined,
): event is WorkflowStepReplayedEvent {
  return event?.type === "step_replayed";
}

async function collect(
  agent: BaseAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

/** Usage of a worker with the two responses `[10, 5]` and `[20, 8]`. */
const TWO_RESPONSES: WorkflowStepUsage = {
  promptTokens: 30,
  completionTokens: 13,
  totalTokens: 43,
  cachedTokens: 0,
  toolCalls: 0,
  llmCalls: 2,
};

function singleStepWorkflow(worker: BaseAgent): WorkflowAgent {
  return new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: "usage",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "s1", agentName: worker.name, input: ctx.input });
      },
    }),
    subAgents: [worker],
  });
}

describe("workflow step results carry the agent run's usage", () => {
  test("an agent step reports the summed usage of its run", async () => {
    const worker = new UsageAgent("worker", [
      [10, 5],
      [20, 8],
    ]);
    const workflow = singleStepWorkflow(worker);
    const events = await collect(workflow, invocation(workflow));

    const done = events.map(workflowEventOf).find(isStepCompleted);
    expect(done?.result.usage).toEqual(TWO_RESPONSES);
  });

  test("a nested workflow step reports its child workflow's summed usage", async () => {
    const worker = new UsageAgent("worker", [
      [10, 5],
      [20, 8],
    ]);
    const child = new WorkflowAgent({
      name: "child",
      definition: defineWorkflow({
        id: "child",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "c1", agentName: "worker", input: ctx.input });
        },
      }),
      subAgents: [worker],
    });
    const parent = new WorkflowAgent({
      name: "parent",
      definition: defineWorkflow({
        id: "parent",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "p1", agentName: "child", input: ctx.input });
        },
      }),
      subAgents: [child],
    });

    const events = await collect(parent, invocation(parent));

    const p1 = events
      .map(workflowEventOf)
      .filter(isStepCompleted)
      .find((event) => event.workflowId === "parent");
    expect(p1?.result.usage).toEqual(TWO_RESPONSES);
  });

  test("a replayed step reports the same usage as when it completed", async () => {
    const worker = new UsageAgent("worker", [
      [10, 5],
      [20, 8],
    ]);
    const workflow = singleStepWorkflow(worker);
    const first = await collect(workflow, invocation(workflow));
    const completed = first.map(workflowEventOf).find(isStepCompleted);
    // The checkpoint saved after the step, before the workflow completed.
    const saved = first.filter(
      (event) => workflowEventOf(event)?.type === "checkpoint_saved",
    );
    const crashState = saved.at(-2)?.actions?.stateDelta ?? {};

    const second = await collect(workflow, invocation(workflow, crashState));

    expect(worker.calls).toBe(1);
    const replayed = second.map(workflowEventOf).find(isStepReplayed);
    expect(replayed?.result.usage).toEqual(TWO_RESPONSES);
    expect(replayed?.result.usage).toEqual(completed?.result.usage);
  });
});
