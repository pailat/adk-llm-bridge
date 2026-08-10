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

  test("emits native transfer_to_agent delegation events by default", async () => {
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

    // Native ordering: #0 transfer_to_agent functionCall, #1 transfer
    // functionResponse with actions.transferToAgent (the transfer signal fires
    // BEFORE the sub-agent runs), #2 sub-agent text turn. The empty trailing
    // TextAgent event has no renderable content so it is suppressed.
    expect(emitted).toHaveLength(3);

    // #0 native transfer_to_agent call: single agentName arg, no customMetadata,
    // finishReason=STOP and turnComplete=true (completed synthetic model turn).
    expect(emitted[0].content?.role).toBe("model");
    expect(emitted[0].content?.parts?.[0]?.functionCall).toMatchObject({
      name: "transfer_to_agent",
      args: { agentName: "worker" },
    });
    expect(emitted[0].content?.parts?.[0]?.functionCall?.args).not.toHaveProperty("task");
    expect(emitted[0].customMetadata).toBeUndefined();
    expect(emitted[0].finishReason).toBe("STOP");
    expect(emitted[0].turnComplete).toBe(true);

    // #1 native transfer_to_agent response carries the agent-switch signal and
    // fires BEFORE the sub-agent runs, with NO stateDelta (matching native).
    const response = emitted[1];
    expect(response.content?.role).toBe("user");
    expect(response.content?.parts?.[0]?.functionResponse).toMatchObject({
      name: "transfer_to_agent",
      response: { result: "Transfer queued" },
    });
    expect(response.actions?.transferToAgent).toBe("worker");
    expect(response.actions?.stateDelta).toEqual({});
    expect(response.customMetadata).toBeUndefined();

    // #2 sub-agent's own turn on the root branch, no external-agent metadata.
    expect(emitted[2]).toMatchObject({
      author: "worker",
      content: { role: "model", parts: [{ text: "OK: do it" }] },
    });
    expect(emitted[2].customMetadata).toBeUndefined();
    expect(emitted[2].branch).toBeUndefined();
  });

  test("emits legacy run_adk_subagent shape when nativeDelegationShape is false", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      nativeDelegationShape: false,
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

  test("strips customMetadata from surfaced sub-agent events in native mode", async () => {
    const worker = new FunctionResponseAgent([
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "answer" }] },
        actions: createEventActions({ stateDelta: { codexThread: "t-1" } }),
        customMetadata: { title: "worker: final response", externalAgent: true },
      }),
    ]);
    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    // #0 call, #1 transfer response, #2 sub-agent turn (metadata stripped).
    expect(emitted).toHaveLength(3);
    expect(emitted[2].customMetadata).toBeUndefined();
    // Content and actions are preserved by the clone.
    expect(emitted[2].content?.parts?.[0]?.text).toBe("answer");
    expect(emitted[2].actions.stateDelta).toEqual({ codexThread: "t-1" });
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
      name: "transfer_to_agent",
      response: { result: "Transfer queued" },
    });
    expect(emitted[1].actions?.transferToAgent).toBe("worker");
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

  test("ignores partial streaming chunks when aggregating subagent output", async () => {
    const worker = new FunctionResponseAgent([
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "L" }] },
        partial: true,
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "amento" }] },
        partial: true,
      }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "Lamento completo" }] },
        turnComplete: true,
      }),
    ]);
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    expect(result.output).toBe("Lamento completo");
    expect(result.summary.textEvents).toBe(1);
    expect(result.events).toBe(3);
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
    // #1 transfer response fires before the sub-agent and is byte-clean: it
    // carries the transfer signal but NO stateDelta (matching native).
    expect(emitted[1].actions.transferToAgent).toBe("worker");
    expect(emitted[1].actions.stateDelta).toEqual({});
    expect(emitted[1].content?.parts?.[0]?.functionResponse?.response).toEqual({
      result: "Transfer queued",
    });
    // #2 sub-agent turn surfaced verbatim on the root branch (no enrichment),
    // carrying its OWN stateDelta exactly as a native sub-agent commits state.
    expect(emitted[2]).toMatchObject({
      author: "worker",
      content: { role: "model", parts: [{ text: "stateful" }] },
    });
    expect(emitted[2].customMetadata).toBeUndefined();
    expect(emitted[2].actions.stateDelta).toEqual({ architectureSummary: "done" });
  });

  test("surfaces a content-less stateDelta event in native mode so resume survives", async () => {
    class PreambleStateAgent extends BaseAgent {
      constructor() {
        super({ name: "worker" });
      }

      protected async *runAsyncImpl(context: InvocationContext) {
        // Content-less state_delta event (e.g. the codex_thread marker emitted
        // the moment the thread starts). In native mode this must SURFACE as
        // its own event so the runner commits its stateDelta to session.state
        // and codex resume keeps working — the transfer response no longer
        // carries the delta.
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          actions: createEventActions({ stateDelta: { codexThread: "thread-123" } }),
        });
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: { role: "model", parts: [{ text: "real answer" }] },
        });
      }

      protected async *runLiveImpl() {}
    }

    const root = new TextAgent("root");
    const emitted = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [new PreambleStateAgent()],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.runSubAgent({ agentName: "worker", task: "do it" });

    // #0 transfer call, #1 transfer response (clean), #2 surfaced state_delta
    // event, #3 real-answer sub-agent turn.
    expect(emitted).toHaveLength(4);
    // The transfer response carries NO stateDelta (matches native).
    expect(emitted[1].actions.stateDelta).toEqual({});
    // The content-less state_delta event surfaces as its own event carrying the
    // delta, so the runner commits codex_thread to session.state.
    expect(emitted[2].content).toBeUndefined();
    expect(emitted[2].actions.stateDelta).toEqual({ codexThread: "thread-123" });
    expect(emitted[2].customMetadata).toBeUndefined();
    // #3 the real answer.
    expect(emitted[3].content?.parts?.[0]?.text).toBe("real answer");
    expect(result.stateDelta).toEqual({ codexThread: "thread-123" });
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
