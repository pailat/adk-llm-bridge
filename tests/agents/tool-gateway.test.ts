import {
  BaseAgent,
  BaseLlm,
  createEvent,
  createEventActions,
  FunctionTool,
  LlmAgent,
  PluginManager,
  type BaseLlmConnection,
  type InvocationContext,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { describe, expect, test } from "bun:test";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentRunRequest,
  ToolGateway,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

class CaptureDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  async *run(request: ExternalAgentRunRequest) {
    this.request = request;
    yield { type: "output" as const, content: "child" };
  }
}

class TextAgent extends BaseAgent {
  constructor(name = "worker") {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    const task = context.userContent?.parts?.[0]?.text ?? "";
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: `OK: ${task}` }] },
    });
    yield createEvent({ invocationId: context.invocationId, author: this.name });
  }

  protected async *runLiveImpl() {}
}

class FunctionResponseAgent extends BaseAgent {
  constructor(
    private readonly eventsToYield: ReturnType<typeof createEvent>[],
    name = "worker",
  ) {
    super({ name });
  }

  protected async *runAsyncImpl() {
    yield* this.eventsToYield;
  }

  protected async *runLiveImpl() {}
}

class FakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor() {
    super({ model: "fake-model" });
  }

  async *generateContentAsync(llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    yield { content: { role: "model", parts: [{ text: "child saw task" }] } };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("FakeLlm.connect is not implemented");
  }
}

class ToolCallingFakeLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];

  constructor() {
    super({ model: "fake-tool-model" });
  }

  async *generateContentAsync(llmRequest: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    const hasToolResponse = llmRequest.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse?.name === "lookup_status")
    );
    if (hasToolResponse) {
      yield { content: { role: "model", parts: [{ text: "final after tool" }] } };
      return;
    }
    yield {
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "call-1",
              name: "lookup_status",
              args: { service: "auth" },
            },
          },
        ],
      },
    };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("ToolCallingFakeLlm.connect is not implemented");
  }
}

function parentContext(agent: BaseAgent): InvocationContext {
  return {
    invocationId: "inv-1",
    agent,
    userContent: { role: "user", parts: [{ text: "parent" }] },
    session: {
      id: "session-1",
      appName: "app",
      userId: "user",
      state: {},
      events: [],
      lastUpdateTime: 1,
    },
    pluginManager: new PluginManager(),
  } as InvocationContext;
}

describe("ToolGateway", () => {
  test("runs a named ADK subagent and returns visible text only", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result).toEqual({
      agentName: "worker",
      output: "OK: do it",
      events: 2,
      summary: {
        events: 2,
        textEvents: 1,
        toolCalls: 0,
        errors: 0,
        durationMs: expect.any(Number),
      },
    });
  });

  test("emits native function call, subagent events, and function response events by default", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(emitted).toHaveLength(4);
    expect(emitted[0].content?.parts?.[0]?.functionCall).toMatchObject({
      name: "run_adk_subagent",
      args: { agentName: "worker", task: "do it" },
    });
    expect(emitted[1]).toMatchObject({
      author: "worker",
      customMetadata: {
        title: "worker: final response",
        externalAgent: true,
        subAgentEvent: true,
        parentToolName: "run_adk_subagent",
        parentToolCallId: expect.any(String),
        rootAgentName: "root",
        subAgentName: "worker",
      },
      content: { role: "model", parts: [{ text: "OK: do it" }] },
    });
    expect(emitted[3].content?.parts?.[0]?.functionResponse).toMatchObject({
      name: "run_adk_subagent",
      response: {
        agentName: "worker",
        output: "OK: do it",
        events: 2,
        summary: {
          events: 2,
          textEvents: 1,
          toolCalls: 0,
          errors: 0,
          durationMs: expect.any(Number),
        },
      },
    });
  });

  test("can hide subagent events for quiet summaries", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      exposeSubAgentEvents: false,
      eventSink: (event) => emitted.push(event),
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(emitted).toHaveLength(2);
    expect(emitted[1].content?.parts?.[0]?.functionResponse).toMatchObject({
      name: "run_adk_subagent",
      response: {
        agentName: "worker",
        output: "OK: do it",
        events: 2,
        summary: {
          events: 2,
          textEvents: 1,
          toolCalls: 0,
          errors: 0,
          durationMs: expect.any(Number),
        },
      },
    });
  });

  test("passes delegated task to real LlmAgent through child session contents", async () => {
    const fakeLlm = new FakeLlm();
    const worker = new LlmAgent({ name: "worker", model: fakeLlm });
    const root = new TextAgent("root");
    const context = parentContext(root);
    context.session.events.push(
      createEvent({
        invocationId: "previous",
        author: "user",
        content: { role: "user", parts: [{ text: "previous task" }] },
      }),
    );
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: context,
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "delegated task" });

    expect(result.output).toBe("child saw task");
    expect(fakeLlm.requests).toHaveLength(1);
    expect(fakeLlm.requests[0].contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: "delegated task" }],
    });
    expect(context.session.events).toHaveLength(1);
    expect(context.session.events[0].content?.parts?.[0]?.text).toBe("previous task");
  });

  test("persists child LlmAgent events in the child session for multi-step tool calls", async () => {
    const fakeLlm = new ToolCallingFakeLlm();
    const lookupStatus = new FunctionTool({
      name: "lookup_status",
      description: "Look up service status.",
      parameters: {
        type: "OBJECT",
        properties: {
          service: { type: "STRING" },
        },
      } as never,
      execute: () => ({ status: "degraded" }),
    });
    const worker = new LlmAgent({ name: "worker", model: fakeLlm, tools: [lookupStatus] });
    const root = new TextAgent("root");
    const context = parentContext(root);
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: context,
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "check auth" });

    expect(result.output).toBe("final after tool");
    expect(result.summary.toolCalls).toBe(1);
    expect(fakeLlm.requests).toHaveLength(2);
    expect(fakeLlm.requests[1].contents.some((content) =>
      content.parts?.some((part) => part.functionResponse?.name === "lookup_status")
    )).toBe(true);
    expect(context.session.events).toHaveLength(0);
  });

  test("prefers visible text over function response fallback output", async () => {
    const worker = new FunctionResponseAgent([
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "tool",
                response: { output: "tool output" },
              },
            },
          ],
        },
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "final text" }] },
      }),
    ]);
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result.output).toBe("final text");
  });

  test("uses function response output when subagent emits no visible text", async () => {
    const worker = new FunctionResponseAgent([
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-1",
                name: "tool",
                response: { output: "tool output" },
              },
            },
          ],
        },
      }),
    ]);
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result.output).toBe("tool output");
    expect(result.summary.textEvents).toBe(0);
  });

  test("propagates subagent state through the synthetic function response", async () => {
    class StateAgent extends BaseAgent {
      constructor() {
        super({ name: "worker" });
      }

      protected async *runAsyncImpl(context: InvocationContext) {
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "stateful" }] },
          actions: createEventActions({ stateDelta: { architectureSummary: "done" } }),
        });
      }

      protected async *runLiveImpl() {}
    }

    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [new StateAgent()],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result.stateDelta).toEqual({ architectureSummary: "done" });
    expect(emitted).toHaveLength(3);
    expect(emitted[1]).toMatchObject({
      author: "worker",
      customMetadata: {
        subAgentEvent: true,
        subAgentName: "worker",
        parentToolName: "run_adk_subagent",
      },
    });
    expect(emitted[2].actions.stateDelta).toEqual({ architectureSummary: "done" });
    expect(emitted[2].content?.parts?.[0]?.functionResponse?.response).toEqual({
      agentName: "worker",
      output: "stateful",
      events: 1,
      summary: {
        events: 1,
        textEvents: 1,
        toolCalls: 0,
        errors: 0,
        durationMs: expect.any(Number),
      },
    });
  });

  test("applies inherited permission override to ExternalAgent subagents", async () => {
    const driver = new CaptureDriver();
    const worker = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver,
      permissions: { mode: "full-access", allowNetwork: true },
    });
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      parentPermissions: { mode: "read-only" },
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(driver.request?.permissions).toEqual({
      mode: "read-only",
      allowNetwork: false,
    });
  });

  test("returns a controlled error for unknown subagents", async () => {
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "missing", task: "do it" });

    expect(result.error).toBe("Unknown ADK subagent: missing");
    expect(result.output).toBe("");
    expect(result.events).toBe(0);
  });
});
