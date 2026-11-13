import { describe, expect, test } from "bun:test";
import {
  type BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type Event,
  InvocationContext,
  LLMRegistry,
  LlmAgent,
  type LlmResponse,
  PluginManager,
} from "@google/adk";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import type {
  ExternalAgentDriver,
  ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import type {
  WorkflowEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepReplayedEvent,
  WorkflowStepStartedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class StringLlm extends BaseLlm {
  static override readonly supportedModels = [/^step-string-.*/];
  constructor(params: { model: string }) {
    super(params);
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {
      content: { role: "model", parts: [{ text: "ok" }] },
      modelVersion: `${this.model}-v2`,
    };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}
LLMRegistry.register(StringLlm);

class InstanceLlm extends BaseLlm {
  constructor(model: string) {
    super({ model });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: "model", parts: [{ text: "ok" }] } };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

function external(
  name: string,
  shape: { model?: string; reportsResolvedModel?: boolean },
  resolved?: string,
): ExternalAgent {
  const events: ExternalAgentEvent[] = [
    {
      type: "started",
      providerId: CODEX_PROVIDER.id,
      ...(resolved ? { model: resolved } : {}),
    },
    { type: "output", content: "done" },
    {
      type: "completed",
      exitCode: 0,
      // One billed model: a trusted driver names it on `completed`.
      ...(resolved ? { model: resolved } : {}),
    },
  ];
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    ...shape,
    async *run() {
      yield* events;
    },
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

function invocation(
  agent: BaseAgent,
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-models",
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

const workflowEventOf = (event: Event): WorkflowEvent | undefined =>
  event.customMetadata?.workflowEvent as WorkflowEvent | undefined;

async function collect(
  agent: BaseAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) events.push(event);
  return events;
}

function workflowOf(...workers: BaseAgent[]): WorkflowAgent {
  return new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: "models",
      version: "1",
      handler: async (ctx) => {
        for (const [index, worker] of workers.entries()) {
          await ctx.run({
            id: `s${index + 1}`,
            agentName: worker.name,
            input: ctx.input,
          });
        }
      },
    }),
    subAgents: workers,
  });
}

function stepEvents(events: Event[]) {
  const all = events.map(workflowEventOf);
  return {
    started: all.filter(
      (e): e is WorkflowStepStartedEvent => e?.type === "step_started",
    ),
    completed: all.filter(
      (e): e is WorkflowStepCompletedEvent => e?.type === "step_completed",
    ),
    replayed: all.filter(
      (e): e is WorkflowStepReplayedEvent => e?.type === "step_replayed",
    ),
  };
}

describe("step_started.requestedModel", () => {
  test("an ExternalAgent reports its driver's model", async () => {
    const wf = workflowOf(external("ext", { model: "gpt-5.5" }));
    const { started } = stepEvents(await collect(wf, invocation(wf)));
    expect(started[0]?.requestedModel).toBe("gpt-5.5");
  });

  test("an ExternalAgent without a model has no requestedModel", async () => {
    const wf = workflowOf(external("ext", {}));
    const { started } = stepEvents(await collect(wf, invocation(wf)));
    expect("requestedModel" in (started[0] ?? {})).toBe(false);
  });

  test("an LlmAgent with a string model reports that string", async () => {
    const wf = workflowOf(
      new LlmAgent({ name: "llm", model: "step-string-1" }),
    );
    const { started } = stepEvents(await collect(wf, invocation(wf)));
    expect(started[0]?.requestedModel).toBe("step-string-1");
  });

  test("an LlmAgent with a model instance reports the instance's model", async () => {
    const wf = workflowOf(
      new LlmAgent({ name: "llm", model: new InstanceLlm("inst-7") }),
    );
    const { started } = stepEvents(await collect(wf, invocation(wf)));
    expect(started[0]?.requestedModel).toBe("inst-7");
  });

  test("an LlmAgent without a model (canonicalModel throws) has no requestedModel", async () => {
    // ADK cannot run it either, so the step fails after it started; the
    // gateway tests cover the `unknown` flag of such an agent.
    const wf = workflowOf(new LlmAgent({ name: "bare" }));
    const events: Event[] = [];
    try {
      for await (const event of wf.runAsync(invocation(wf))) events.push(event);
    } catch {
      // The step fails: no model to call.
    }
    const { started } = stepEvents(events);
    expect(started).toHaveLength(1);
    expect("requestedModel" in (started[0] ?? {})).toBe(false);
  });
});

describe("step_completed result.models", () => {
  test("a single external run: requested, resolved, not unknown", async () => {
    const wf = workflowOf(
      external(
        "ext",
        { model: "claude-opus-5-5", reportsResolvedModel: true },
        "claude-opus-5-5",
      ),
    );
    const { completed } = stepEvents(await collect(wf, invocation(wf)));
    expect(completed[0]?.result.models).toEqual({
      requested: ["claude-opus-5-5"],
      resolved: ["claude-opus-5-5"],
      used: ["claude-opus-5-5"],
      unexpected: [],
      unknown: false,
    });
  });

  test("a Codex-like step is unknown", async () => {
    const wf = workflowOf(
      external("ext", { model: "gpt-5.5", reportsResolvedModel: false }),
    );
    const { completed } = stepEvents(await collect(wf, invocation(wf)));
    expect(completed[0]?.result.models).toEqual({
      requested: ["gpt-5.5"],
      resolved: [],
      unknown: true,
    });
  });

  test("an LlmAgent step: modelVersion is resolved", async () => {
    const wf = workflowOf(
      new LlmAgent({ name: "llm", model: "step-string-2" }),
    );
    const { completed } = stepEvents(await collect(wf, invocation(wf)));
    expect(completed[0]?.result.models).toEqual({
      requested: ["step-string-2"],
      resolved: ["step-string-2-v2"],
      unknown: false,
    });
  });

  test("a nested workflow with two agents lists both, in order, without duplicates", async () => {
    const a = external(
      "a",
      { model: "m-a", reportsResolvedModel: true },
      "m-a-full",
    );
    const b = external(
      "b",
      { model: "m-b", reportsResolvedModel: true },
      "m-b-full",
    );
    const a2 = external(
      "a2",
      { model: "m-a", reportsResolvedModel: true },
      "m-a-full",
    );
    const child = new WorkflowAgent({
      name: "child",
      definition: defineWorkflow({
        id: "child",
        version: "1",
        handler: async (ctx) => {
          await ctx.run({ id: "c1", agentName: "a", input: ctx.input });
          await ctx.run({ id: "c2", agentName: "b", input: ctx.input });
          await ctx.run({ id: "c3", agentName: "a2", input: ctx.input });
        },
      }),
      subAgents: [a, b, a2],
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
    const { completed } = stepEvents(await collect(parent, invocation(parent)));
    const p1 = completed.find((event) => event.workflowId === "parent");
    expect(p1?.result.models).toEqual({
      requested: ["m-a", "m-b"],
      resolved: ["m-a-full", "m-b-full"],
      used: ["m-a-full", "m-b-full"],
      unexpected: [],
      unknown: false,
    });
  });

  test("a replayed step returns the stored value", async () => {
    const worker = external(
      "ext",
      { model: "claude-opus-5-5", reportsResolvedModel: true },
      "claude-opus-5-5",
    );
    const wf = workflowOf(worker);
    const first = await collect(wf, invocation(wf));
    const completed = stepEvents(first).completed[0];
    const saved = first.filter(
      (event) => workflowEventOf(event)?.type === "checkpoint_saved",
    );
    const crashState = saved.at(-2)?.actions?.stateDelta ?? {};
    const second = await collect(wf, invocation(wf, crashState));
    const replayed = stepEvents(second).replayed[0];
    expect(replayed?.result.models).toEqual(completed?.result.models);
    expect(replayed?.result.models?.requested).toEqual(["claude-opus-5-5"]);
  });
});
