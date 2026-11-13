import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  type Event,
  InvocationContext,
  LlmAgent,
  type LlmResponse,
  PluginManager,
  SequentialAgent,
} from "@google/adk";
import { ExternalAgent } from "../../src/agents/external-agent.js";
import type {
  ExternalAgentDriver,
  ExternalAgentEvent,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import type { AgentKind } from "../../src/runtime/agent-kind.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import {
  isWorkflowEvent,
  type WorkflowEvent,
  type WorkflowStepCompletedEvent,
  type WorkflowStepStartedEvent,
} from "../../src/workflows/events.js";
import { WorkflowAgent } from "../../src/workflows/workflow-agent.js";

class CustomAgent extends BaseAgent {
  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "custom" }] },
    });
  }
  protected async *runLiveImpl() {}
}

class OkLlm extends BaseLlm {
  constructor() {
    super({ model: "kind-llm" });
  }
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: "model", parts: [{ text: "ok" }] } };
  }
  async connect(): Promise<BaseLlmConnection> {
    throw new Error("not implemented");
  }
}

class SubLlm extends LlmAgent {
  protected override async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "llm" }] },
    });
  }
}

function external(name: string): ExternalAgent {
  const events: ExternalAgentEvent[] = [
    { type: "started", providerId: CODEX_PROVIDER.id },
    { type: "output", content: "done" },
    { type: "completed", exitCode: 0 },
  ];
  const driver: ExternalAgentDriver = {
    providerId: CODEX_PROVIDER.id,
    async *run() {
      yield* events;
    },
  };
  return new ExternalAgent({ name, provider: CODEX_PROVIDER, driver });
}

function invocation(agent: BaseAgent): InvocationContext {
  return new InvocationContext({
    pluginManager: new PluginManager(),
    invocationId: "inv-kind",
    branch: "root",
    agent,
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
}

async function stepEventsOf(worker: BaseAgent) {
  const wf = new WorkflowAgent({
    name: "wf",
    definition: defineWorkflow({
      id: "kinds",
      version: "1",
      handler: async (ctx) => {
        await ctx.run({ id: "s1", agentName: worker.name, input: ctx.input });
      },
    }),
    subAgents: [worker],
  });
  const all: WorkflowEvent[] = [];
  for await (const event of wf.runAsync(invocation(wf))) {
    const workflowEvent = (event as Event).customMetadata?.workflowEvent as
      | WorkflowEvent
      | undefined;
    if (workflowEvent) all.push(workflowEvent);
  }
  return {
    started: all.filter(
      (e): e is WorkflowStepStartedEvent => e.type === "step_started",
    ),
    completed: all.filter(
      (e): e is WorkflowStepCompletedEvent => e.type === "step_completed",
    ),
  };
}

const CASES: Array<[string, () => BaseAgent, AgentKind]> = [
  ["an ExternalAgent", () => external("w"), "external"],
  ["an LlmAgent", () => new LlmAgent({ name: "w", model: new OkLlm() }), "llm"],
  [
    "a subclass of LlmAgent",
    () => new SubLlm({ name: "w", model: "m" }),
    "llm",
  ],
  [
    "a nested WorkflowAgent",
    () =>
      new WorkflowAgent({
        name: "w",
        definition: defineWorkflow({
          id: "inner",
          version: "1",
          handler: async () => undefined,
        }),
      }),
    "workflow",
  ],
  ["a SequentialAgent", () => new SequentialAgent({ name: "w" }), "workflow"],
  ["a custom BaseAgent", () => new CustomAgent({ name: "w" }), "host"],
];

describe("agentKind on step events", () => {
  for (const [label, make, kind] of CASES) {
    test(`${label} is ${kind} on step_started and step_completed`, async () => {
      const { started, completed } = await stepEventsOf(make());
      expect(started[0]?.agentKind).toBe(kind);
      expect(completed[0]?.agentKind).toBe(kind);
    });
  }

  test("events from before agentKind (no field) are still workflow events", () => {
    const old = {
      type: "step_started",
      workflowId: "w",
      workflowVersion: "1",
      executionId: "e",
      timestamp: 1,
      step: { id: "s1", agentName: "a" },
      attempt: 1,
    };
    expect(isWorkflowEvent(old)).toBe(true);
    expect("agentKind" in old).toBe(false);
  });
});
