import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  BaseLlm,
  type BaseLlmConnection,
  createEvent,
  createEventActions,
  type Event,
  FunctionTool,
  InMemoryRunner,
  InvocationContext,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  LoopAgent,
  ParallelAgent,
  PluginManager,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  SequentialAgent,
} from "@google/adk";
import { type Content, FinishReason } from "@google/genai";
import { z } from "zod";
import {
  EXTERNAL_AGENT_TRANSFER_FAILED,
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
  type RunSubAgentResult,
  ToolGateway,
} from "../../src/agents/index.js";
import type { ExternalAgentPermissionPolicy } from "../../src/agents/permissions/schema.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { fromPartial } from "../helpers/partial.js";

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
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
    });
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

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
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

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(llmRequest);
    const hasToolResponse = llmRequest.contents.some((content) =>
      content.parts?.some(
        (part) => part.functionResponse?.name === "lookup_status",
      ),
    );
    if (hasToolResponse) {
      yield {
        content: { role: "model", parts: [{ text: "final after tool" }] },
      };
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
  return fromPartial<InvocationContext>({
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
  });
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

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

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
    const emitted: Event[] = [];
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

    // #0 native transfer_to_agent call: single agent_name arg (ADK >= 2.1 wire format), no customMetadata,
    // finishReason=STOP and turnComplete=true (completed synthetic model turn).
    expect(emitted[0].content?.role).toBe("model");
    expect(emitted[0].content?.parts?.[0]?.functionCall).toMatchObject({
      name: "transfer_to_agent",
      args: { agent_name: "worker" },
    });
    expect(
      emitted[0].content?.parts?.[0]?.functionCall?.args,
    ).not.toHaveProperty("agentName");
    expect(
      emitted[0].content?.parts?.[0]?.functionCall?.args,
    ).not.toHaveProperty("task");
    expect(emitted[0].customMetadata).toBeUndefined();
    expect(emitted[0].finishReason).toBe(FinishReason.STOP);
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
    const emitted: Event[] = [];
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

  test("legacy sub-agent tool titles show the query, tool name or status", async () => {
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: {
          role: "model",
          parts: [{ functionCall: { id, name, args } }],
        },
      });
    const worker = new FunctionResponseAgent([
      call("c1", "search", { query: "adk docs" }),
      call("c2", "mcp", { toolName: "lookup" }),
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        errorMessage: "broke",
      }),
    ]);
    const root = new TextAgent("root");
    const emitted: ReturnType<typeof createEvent>[] = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      nativeDelegationShape: false,
      eventSink: (event) => emitted.push(event),
    });

    await gateway.runSubAgent({ agentName: "worker", task: "go" });

    const titles = emitted.map(
      (event) =>
        (event.customMetadata as { title?: string } | undefined)?.title,
    );
    expect(titles).toContain("worker: search call: adk docs");
    expect(titles).toContain("worker: mcp call: lookup");
    expect(titles).toContain("worker: error EXTERNAL_AGENT_ERROR");
  });

  test("strips customMetadata from surfaced sub-agent events in native mode", async () => {
    const worker = new FunctionResponseAgent([
      createEvent({
        invocationId: "inv-1",
        author: "worker",
        content: { role: "model", parts: [{ text: "answer" }] },
        actions: createEventActions({ stateDelta: { codexThread: "t-1" } }),
        customMetadata: {
          title: "worker: final response",
          externalAgent: true,
        },
      }),
    ]);
    const root = new TextAgent("root");
    const emitted: Event[] = [];
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
    const emitted: Event[] = [];
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

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "delegated task",
    });

    expect(result.output).toBe("child saw task");
    expect(fakeLlm.requests).toHaveLength(1);
    expect(fakeLlm.requests[0].contents.at(-1)).toEqual({
      role: "user",
      parts: [{ text: "delegated task" }],
    });
    expect(context.session.events).toHaveLength(1);
    expect(context.session.events[0].content?.parts?.[0]?.text).toBe(
      "previous task",
    );
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
    const worker = new LlmAgent({
      name: "worker",
      model: fakeLlm,
      tools: [lookupStatus],
    });
    const root = new TextAgent("root");
    const context = parentContext(root);
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: context,
    });

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "check auth",
    });

    expect(result.output).toBe("final after tool");
    expect(result.summary.toolCalls).toBe(1);
    expect(fakeLlm.requests).toHaveLength(2);
    expect(
      fakeLlm.requests[1].contents.some((content) =>
        content.parts?.some(
          (part) => part.functionResponse?.name === "lookup_status",
        ),
      ),
    ).toBe(true);
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

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

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

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

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

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

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
          actions: createEventActions({
            stateDelta: { architectureSummary: "done" },
          }),
        });
      }

      protected async *runLiveImpl() {}
    }

    const root = new TextAgent("root");
    const emitted: Event[] = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [new StateAgent()],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

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
    expect(emitted[2].actions.stateDelta).toEqual({
      architectureSummary: "done",
    });
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
        // and codex resume keeps working: the transfer response carries no
        // delta.
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          actions: createEventActions({
            stateDelta: { codexThread: "thread-123" },
          }),
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
    const emitted: Event[] = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [new PreambleStateAgent()],
      parentContext: parentContext(root),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

    // #0 transfer call, #1 transfer response (clean), #2 surfaced state_delta
    // event, #3 real-answer sub-agent turn.
    expect(emitted).toHaveLength(4);
    // The transfer response carries NO stateDelta (matches native).
    expect(emitted[1].actions.stateDelta).toEqual({});
    // The content-less state_delta event surfaces as its own event carrying the
    // delta, so the runner commits codex_thread to session.state.
    expect(emitted[2].content).toBeUndefined();
    expect(emitted[2].actions.stateDelta).toEqual({
      codexThread: "thread-123",
    });
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

    const result = await gateway.runSubAgent({
      agentName: "missing",
      task: "do it",
    });

    expect(result.error).toBe("Unknown ADK subagent: missing");
    expect(result.errorKind).toBe("agent-error");
    expect(result.output).toBe("");
    expect(result.events).toBe(0);
  });
});

describe("ToolGateway.transferToAgent", () => {
  test("runs the target on the input with no synthetic transfer events", async () => {
    const worker = new TextAgent("worker");
    const coordinator = new TextAgent("coordinator");
    const emitted: ReturnType<typeof createEvent>[] = [];
    const gateway = new ToolGateway({
      rootAgent: coordinator,
      subAgents: [worker],
      parentContext: parentContext(coordinator),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.transferToAgent("worker", {
      role: "user",
      parts: [{ text: "the user request" }],
    });

    expect(result.output).toBe("OK: the user request");
    expect(result.error).toBeUndefined();
    const names = emitted.flatMap((event) =>
      (event.content?.parts ?? []).flatMap((part) => [
        part.functionCall?.name,
        part.functionResponse?.name,
      ]),
    );
    expect(names).not.toContain("transfer_to_agent");
    expect(emitted[0]?.author).toBe("worker");
  });

  test("waits for the timeline before the target runs and appends only a foreign input", async () => {
    const order: string[] = [];
    class RecordingAgent extends BaseAgent {
      constructor() {
        super({ name: "worker" });
      }
      protected async *runAsyncImpl(context: InvocationContext) {
        order.push(
          `run:${context.session.events.length}:${context.userContent?.parts?.[0]?.text}`,
        );
        yield createEvent({
          invocationId: context.invocationId,
          author: "worker",
        });
      }
      protected async *runLiveImpl() {}
    }
    const coordinator = new TextAgent("coordinator");
    const context = parentContext(coordinator);
    const gateway = new ToolGateway({
      rootAgent: coordinator,
      subAgents: [new RecordingAgent()],
      parentContext: context,
      eventSink: (event) =>
        order.push(`emit:${event.content?.parts?.[0]?.functionCall?.name}`),
      waitForTimeline: async () => {
        order.push("wait");
      },
    });

    // The invocation's own user message: reused, not appended again.
    await gateway.transferToAgent("worker", context.userContent as Content);
    // Any other input (no user message to reuse) is appended.
    await gateway.transferToAgent("worker", {
      role: "user",
      parts: [{ text: "Transferred from coordinator." }],
    });
    await gateway.runSubAgent({ agentName: "worker", task: "task" });

    expect(order).toEqual([
      // Transfers: no synthetic events; only the second adds a user event.
      "wait",
      "run:0:parent",
      "wait",
      "run:1:Transferred from coordinator.",
      // Delegation: its call and response first, then the wait. (The
      // target's content-less events are not surfaced in native shape.)
      "emit:transfer_to_agent",
      "emit:undefined",
      "wait",
      "run:1:task",
    ]);
  });

  test("caps an ExternalAgent target by the caller's policy", async () => {
    const driver = new CaptureDriver();
    const target = new ExternalAgent({
      name: "target",
      provider: CODEX_PROVIDER,
      driver,
      permissions: { mode: "full-access", allowNetwork: true },
    });
    const coordinator = new TextAgent("coordinator");
    const gateway = new ToolGateway({
      rootAgent: coordinator,
      subAgents: [target],
      parentContext: parentContext(coordinator),
      parentPermissions: { mode: "ask" },
    });

    await gateway.transferToAgent("target", {
      role: "user",
      parts: [{ text: "go" }],
    });

    expect(driver.request?.permissions).toEqual({
      mode: "ask",
      allowNetwork: false,
    });
  });

  test("accepts the root and other known agents, never the caller or unknown names", async () => {
    const worker = new TextAgent("worker");
    const sibling = new TextAgent("sibling");
    const root = new SequentialAgent({
      name: "root",
      subAgents: [worker, sibling],
    });
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [],
      parentContext: parentContext(worker),
    });

    expect(gateway.canTransferTo("root")).toBe(true);
    expect(gateway.canTransferTo("sibling")).toBe(true);
    expect(gateway.canTransferTo("worker")).toBe(false);
    expect(gateway.canTransferTo("missing")).toBe(false);
    const result = await gateway.transferToAgent("missing", {
      role: "user",
      parts: [{ text: "go" }],
    });
    expect(result.error).toBe("Unknown ADK agent: missing");
    expect(result.errorKind).toBe("agent-error");
  });

  test("a target that throws is reported once with EXTERNAL_AGENT_TRANSFER_FAILED", async () => {
    class ThrowingAgent extends BaseAgent {
      constructor() {
        super({ name: "thrower" });
      }
      // biome-ignore lint/correctness/useYield: fails before its first event.
      protected async *runAsyncImpl() {
        throw new Error("kaput");
      }
      protected async *runLiveImpl() {}
    }
    const coordinator = new TextAgent("coordinator");
    const emitted: ReturnType<typeof createEvent>[] = [];
    const gateway = new ToolGateway({
      rootAgent: coordinator,
      subAgents: [new ThrowingAgent()],
      parentContext: parentContext(coordinator),
      eventSink: (event) => emitted.push(event),
    });

    const result = await gateway.transferToAgent("thrower", {
      role: "user",
      parts: [{ text: "go" }],
    });

    expect(result.error).toContain("kaput");
    expect(result.errorKind).toBe("agent-error");
    const failures = emitted.filter((event) => event.errorCode);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorCode).toBe(EXTERNAL_AGENT_TRANSFER_FAILED);
    expect(failures[0]?.errorCode).toBe("EXTERNAL_AGENT_TRANSFER_FAILED");
    expect(failures[0]?.author).toBe("coordinator");
  });

  test("an error event of the target is surfaced as is, not reported twice", async () => {
    const failing = new FunctionResponseAgent(
      [
        createEvent({
          invocationId: "inv-1",
          author: "failing",
          errorCode: "OWN_CODE",
          errorMessage: "own failure",
        }),
      ],
      "failing",
    );
    const coordinator = new TextAgent("coordinator");
    const emitted: ReturnType<typeof createEvent>[] = [];
    const gateway = new ToolGateway({
      rootAgent: coordinator,
      subAgents: [failing],
      parentContext: parentContext(coordinator),
      eventSink: (event) => emitted.push(event),
    });

    await gateway.transferToAgent("failing", {
      role: "user",
      parts: [{ text: "go" }],
    });

    expect(emitted.map((event) => event.errorCode)).toEqual(["OWN_CODE"]);
  });
});

describe("ToolGateway parent context without a session", () => {
  class ContextCapturingAgent extends BaseAgent {
    seen?: InvocationContext;

    constructor() {
      super({ name: "worker" });
    }

    protected async *runAsyncImpl(context: InvocationContext) {
      this.seen = context;
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: { role: "model", parts: [{ text: "ok" }] },
      });
    }

    protected async *runLiveImpl() {}
  }

  for (const [label, makeContext] of [
    [
      "an InvocationContext instance",
      () =>
        new InvocationContext({
          invocationId: "inv-1",
          pluginManager: new PluginManager(),
          session: undefined as never,
        }),
    ],
    [
      "a duck-typed context",
      () => ({ invocationId: "inv-1" }) as unknown as InvocationContext,
    ],
  ] as const) {
    test(`gives the child a real InvocationContext with a session (${label})`, async () => {
      const worker = new ContextCapturingAgent();
      const gateway = new ToolGateway({
        rootAgent: worker,
        subAgents: [worker],
        parentContext: makeContext(),
      });

      const result = await gateway.runSubAgent({
        agentName: "worker",
        task: "go",
      });

      expect(result.error).toBeUndefined();
      expect(worker.seen).toBeInstanceOf(InvocationContext);
      expect(worker.seen?.session.id).toBe("tool-gateway-child-session");
      expect(worker.seen?.invocationId).toBe("inv-1");
    });
  }
});

describe("permission inheritance through intermediate ADK agents", () => {
  const FULL = { mode: "full-access", allowNetwork: true } as const;

  class TransferLlm extends BaseLlm {
    constructor(private readonly target: string) {
      super({ model: "fake-transfer" });
    }

    async *generateContentAsync(
      request: LlmRequest,
    ): AsyncGenerator<LlmResponse, void> {
      const transferred = request.contents.some((content) =>
        content.parts?.some((part) => part.functionResponse),
      );
      yield transferred
        ? { content: { role: "model", parts: [{ text: "coordinated" }] } }
        : {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    id: "t-1",
                    name: "transfer_to_agent",
                    args: { agent_name: this.target },
                  },
                },
              ],
            },
          };
    }

    async connect(): Promise<BaseLlmConnection> {
      throw new Error("not implemented");
    }
  }

  class ContextCloningAgent extends BaseAgent {
    constructor(
      name: string,
      private readonly inner: BaseAgent,
    ) {
      super({ name, subAgents: [inner] });
    }

    protected async *runAsyncImpl(context: InvocationContext) {
      yield* this.inner.runAsync(context.clone({ branch: "cloned" }));
    }

    protected async *runLiveImpl() {}
  }

  function worker(
    driver: CaptureDriver,
    permissions: ExternalAgentPermissionPolicy = FULL,
    name = "worker",
  ) {
    return new ExternalAgent({
      name,
      provider: CODEX_PROVIDER,
      driver,
      permissions,
    });
  }

  async function delegate(
    target: BaseAgent,
    parentPermissions?: ExternalAgentPermissionPolicy,
  ) {
    const root = new TextAgent("root");
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [target],
      parentContext: parentContext(root),
      parentPermissions,
    });
    const result = await gateway.runSubAgent({
      agentName: target.name,
      task: "go",
    });
    expect(result.error).toBeUndefined();
  }

  const READ_ONLY = { mode: "read-only", allowNetwork: false } as const;

  test("SequentialAgent in between does not escalate", async () => {
    const driver = new CaptureDriver();
    await delegate(
      new SequentialAgent({ name: "seq", subAgents: [worker(driver)] }),
      { mode: "read-only" },
    );
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("ParallelAgent in between does not escalate", async () => {
    const driver = new CaptureDriver();
    await delegate(
      new ParallelAgent({ name: "par", subAgents: [worker(driver)] }),
      { mode: "read-only" },
    );
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("LoopAgent in between does not escalate", async () => {
    const driver = new CaptureDriver();
    await delegate(
      new LoopAgent({
        name: "loop",
        maxIterations: 1,
        subAgents: [worker(driver)],
      }),
      { mode: "read-only" },
    );
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("LlmAgent transfer in between does not escalate", async () => {
    const driver = new CaptureDriver();
    const coordinator = new LlmAgent({
      name: "coord",
      model: new TransferLlm("worker"),
      subAgents: [worker(driver)],
    });
    await delegate(coordinator, { mode: "read-only" });
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("InvocationContext.clone() in between does not escalate", async () => {
    const driver = new CaptureDriver();
    await delegate(new ContextCloningAgent("host", worker(driver)), {
      mode: "read-only",
    });
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("a clone() of the ExternalAgent is bound by the inherited policy", async () => {
    const driver = new CaptureDriver();
    const copy = worker(driver).clone({ name: "worker_copy" });
    await delegate(new SequentialAgent({ name: "seq", subAgents: [copy] }), {
      mode: "read-only",
    });
    expect(driver.request?.permissions).toEqual(READ_ONLY);
  });

  test("the child's own stricter policy still applies", async () => {
    const driver = new CaptureDriver();
    await delegate(
      new SequentialAgent({
        name: "seq",
        subAgents: [worker(driver, { mode: "read-only" })],
      }),
      FULL,
    );
    expect(driver.request?.permissions).toMatchObject({ mode: "read-only" });
  });

  test("parallel delegations do not share policy", async () => {
    const strictDriver = new CaptureDriver();
    const looseDriver = new CaptureDriver();
    const strict = new SequentialAgent({
      name: "strict",
      subAgents: [worker(strictDriver, FULL, "w1")],
    });
    const loose = new SequentialAgent({
      name: "loose",
      subAgents: [worker(looseDriver, FULL, "w2")],
    });
    const root = new TextAgent("root");
    const strictGateway = new ToolGateway({
      rootAgent: root,
      subAgents: [strict],
      parentContext: parentContext(root),
      parentPermissions: { mode: "read-only" },
    });
    const looseGateway = new ToolGateway({
      rootAgent: root,
      subAgents: [loose],
      parentContext: parentContext(root),
      parentPermissions: FULL,
    });

    await Promise.all([
      strictGateway.runSubAgent({ agentName: "strict", task: "a" }),
      looseGateway.runSubAgent({ agentName: "loose", task: "b" }),
    ]);

    expect(strictDriver.request?.permissions).toEqual(READ_ONLY);
    expect(looseDriver.request?.permissions).toEqual(FULL);
  });

  test("a root run without delegation keeps the agent's own permissions", async () => {
    const driver = new CaptureDriver();
    const agent = worker(driver);
    for await (const _event of agent.runAsync(parentContext(agent))) {
      // drain
    }
    expect(driver.request?.permissions).toEqual(FULL);
  });

  test("the policy is not exposed on the context or in session state", async () => {
    const driver = new CaptureDriver();
    await delegate(
      new SequentialAgent({ name: "seq", subAgents: [worker(driver)] }),
      { mode: "read-only" },
    );
    const context = driver.request?.context as unknown as Record<
      string,
      unknown
    >;
    expect(context.externalAgentPermissionOverride).toBeUndefined();
    expect(JSON.stringify(driver.request?.context.session.state)).not.toContain(
      "read-only",
    );
  });
});

/** Calls `deploy` (which requires confirmation), then answers once it ran. */
class DeployingFakeLlm extends BaseLlm {
  constructor() {
    super({ model: "fake-deploy-model" });
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const deployed = llmRequest.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse?.name === "deploy"),
    );
    yield deployed
      ? { content: { role: "model", parts: [{ text: "deployed" }] } }
      : {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "deploy-1",
                  name: "deploy",
                  args: { env: "prod" },
                },
              },
            ],
          },
        };
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error("DeployingFakeLlm.connect is not implemented");
  }
}

function confirmingDeployer() {
  const executed: unknown[] = [];
  const deploy = new FunctionTool({
    name: "deploy",
    description: "Deploys to an environment.",
    parameters: z.object({ env: z.string() }),
    requireConfirmation: true,
    execute: async (args) => {
      executed.push(args);
      return { ok: true };
    },
  });
  const agent = new LlmAgent({
    name: "deployer",
    model: new DeployingFakeLlm(),
    tools: [deploy],
  });
  return { agent, executed };
}

describe("ToolGateway sub-agent interrupts", () => {
  test("a sub-agent waiting for confirmation is reported as an interrupt, never as success", async () => {
    const { agent: deployer, executed } = confirmingDeployer();
    const root = new TextAgent("root");
    const emitted: ReturnType<typeof createEvent>[] = [];
    const interrupts: RunSubAgentResult[] = [];
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [deployer],
      parentContext: new InvocationContext({
        invocationId: "inv-1",
        agent: root,
        session: parentContext(root).session,
        pluginManager: new PluginManager(),
        userContent: { role: "user", parts: [{ text: "go" }] },
      }),
      eventSink: (event) => emitted.push(event),
      onInterrupt: (result) => interrupts.push(result),
    });

    const result = await gateway.runSubAgent({
      agentName: "deployer",
      task: "deploy prod",
    });

    expect(executed).toEqual([]);
    expect(result.error).toContain(
      "Sub-agent deployer is waiting for user input (confirmation)",
    );
    expect(result.interrupt?.kind).toBe("confirmation");
    expect(result.interrupt?.functionCallIds.length).toBe(1);
    expect(interrupts).toEqual([result]);
    // No final answer to protect: the coordinator's next text is not dropped.
    expect(gateway.consumeFinalAnswer()).toBe(false);
    // The request the user must answer is on the timeline, as a long-running call.
    const requestEvent = emitted.find((event) =>
      event.content?.parts?.some(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      ),
    );
    expect(requestEvent?.longRunningToolIds).toEqual([
      ...(result.interrupt?.functionCallIds ?? []),
    ]);
  });

  test("a delegation that completes reports no interrupt", async () => {
    const worker = new TextAgent("worker");
    const root = new TextAgent("root");
    let interrupted = false;
    const gateway = new ToolGateway({
      rootAgent: root,
      subAgents: [worker],
      parentContext: parentContext(root),
      onInterrupt: () => {
        interrupted = true;
      },
    });

    const result = await gateway.runSubAgent({
      agentName: "worker",
      task: "do it",
    });

    expect(result.interrupt).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(interrupted).toBe(false);
  });

  test("ExternalAgent stops the coordinator and the next turn's answer resumes the sub-agent", async () => {
    const { agent: deployer, executed } = confirmingDeployer();
    const toolResults: RunSubAgentResult[] = [];
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run(request: ExternalAgentRunRequest) {
        const result = await request.toolGateway?.runSubAgent({
          agentName: "deployer",
          task: "deploy prod",
        });
        if (result) toolResults.push(result);
        yield {
          type: "output",
          content: "All done, deployed.",
        } satisfies ExternalAgentEvent;
      },
    };
    const coordinator = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver,
      subAgents: [deployer],
    });
    // A resumable app routes the answer to the agent that asked (ADK's
    // determineAgentForResumption); without it the Runner restarts the root.
    const runner = new InMemoryRunner({
      agent: coordinator,
      appName: "app",
      resumabilityConfig: { isResumable: true },
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });

    const firstTurn = [];
    for await (const event of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "deploy" }] },
    })) {
      firstTurn.push(event);
    }

    expect(toolResults[0]?.interrupt?.kind).toBe("confirmation");
    const texts = firstTurn.flatMap((event) =>
      (event.content?.parts ?? []).flatMap((part) =>
        part.text ? [`${event.author}:${part.text}`] : [],
      ),
    );
    // Whatever the coordinator says after the pause never reaches the user.
    expect(texts).not.toContain("coordinator:All done, deployed.");
    const requestCall = firstTurn
      .flatMap((event) => event.content?.parts ?? [])
      .find(
        (part) =>
          part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
      )?.functionCall;
    expect(requestCall?.id).toBeDefined();
    expect(executed).toEqual([]);

    const secondTurn = [];
    for await (const event of runner.runAsync({
      userId: "u",
      sessionId: session.id,
      newMessage: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: requestCall?.id,
              name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
              response: { confirmed: true },
            },
          },
        ],
      },
    })) {
      secondTurn.push(event);
    }

    expect(executed).toEqual([{ env: "prod" }]);
    expect(
      secondTurn.some(
        (event) =>
          event.author === "deployer" &&
          event.content?.parts?.some((part) => part.text === "deployed"),
      ),
    ).toBe(true);
  });

  test("without a resumable app the answer is not replayed into a fresh delegation", async () => {
    const { agent: deployer, executed } = confirmingDeployer();
    const coordinator = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver: {
        providerId: CODEX_PROVIDER.id,
        async *run(request: ExternalAgentRunRequest) {
          await request.toolGateway?.runSubAgent({
            agentName: "deployer",
            task: "deploy prod",
          });
          yield {
            type: "output",
            content: "done",
          } satisfies ExternalAgentEvent;
        },
      },
      subAgents: [deployer],
    });
    const runner = new InMemoryRunner({ agent: coordinator, appName: "app" });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "u",
    });
    const run = async (
      newMessage: Parameters<typeof runner.runAsync>[0]["newMessage"],
    ) => {
      const events = [];
      for await (const event of runner.runAsync({
        userId: "u",
        sessionId: session.id,
        newMessage,
      })) {
        events.push(event);
      }
      return events;
    };
    const confirmationIds = (events: Awaited<ReturnType<typeof run>>) =>
      events
        .flatMap((event) => event.content?.parts ?? [])
        .filter(
          (part) =>
            part.functionCall?.name === REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
        )
        .map((part) => part.functionCall?.id);

    const [firstId] = confirmationIds(
      await run({ role: "user", parts: [{ text: "deploy" }] }),
    );
    const second = await run({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: firstId,
            name: REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
            response: { confirmed: true },
          },
        },
      ],
    });

    // The coordinator restarts and the new delegation asks again: fail closed.
    expect(executed).toEqual([]);
    const [secondId] = confirmationIds(second);
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
  });
});
