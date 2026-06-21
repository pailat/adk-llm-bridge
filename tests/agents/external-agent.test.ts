import { describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  createEventActions,
  InMemorySessionService,
  Runner,
  type InvocationContext,
} from "@google/adk";
import { trace } from "@opentelemetry/api";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";

class StateAgent extends BaseAgent {
  constructor(name = "state_agent") {
    super({ name });
  }

  protected async *runAsyncImpl(context: InvocationContext) {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: { role: "model", parts: [{ text: "child output" }] },
      actions: createEventActions({ stateDelta: { architectureSummary: "done" } }),
    });
  }

  protected async *runLiveImpl() {}
}

class StaticDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  constructor(private readonly events: ExternalAgentEvent[]) {}

  async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    this.request = request;
    yield* this.events;
  }
}

class DelegatingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;

  async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    yield { type: "output", content: "starting", partial: true };
    const result = await request.toolGateway?.runSubAgent({
      agentName: "state_agent",
      task: "summarize architecture",
    });
    yield { type: "output", content: result?.output ?? "missing" };
  }
}

type CapturedSpan = {
  name: string;
  attributes: Record<string, unknown>;
};

function installTraceCapture(): CapturedSpan[] {
  const spans: CapturedSpan[] = [];
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer() {
      return {
        startSpan(name: string) {
          const span = { name, attributes: {} };
          spans.push(span);
          return {
            setAttributes(attributes: Record<string, unknown>) {
              Object.assign(span.attributes, attributes);
              return this;
            },
            setAttribute(key: string, value: unknown) {
              span.attributes[key] = value;
              return this;
            },
            end() {},
          };
        },
      };
    },
  } as never);
  return spans;
}

async function collect(agent: ExternalAgent, context: Partial<InvocationContext> = {}) {
  const events = [];
  for await (const event of agent.runAsync({
    invocationId: "inv-1",
    branch: "root.external",
    ...context,
  } as InvocationContext)) {
    events.push(event);
  }
  return events;
}

describe("ExternalAgent ADK event formatting", () => {
  test("passes runtime bridge context to the configured driver", async () => {
    const driver = new StaticDriver([{ type: "completed", exitCode: 0 }]);
    const subAgent = new ExternalAgent({
      name: "codex_subagent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([]),
    });
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
      subAgents: [subAgent],
    });

    await collect(agent);

    expect(driver.request?.agent).toBe(agent);
    expect(driver.request?.rootAgent).toBe(agent);
    expect(driver.request?.subAgents).toEqual([subAgent]);
    expect(driver.request?.toolGateway).toBeDefined();
    expect(driver.request?.runtimeSession).toMatchObject({
      id: "inv-1",
      rootAgentName: "codex_agent",
    });
  });

  test("renders output as model text content with invocation metadata", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "Hello" }]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invocationId: "inv-1",
      author: "codex_agent",
      branch: "root.external",
      content: { role: "model", parts: [{ text: "Hello" }] },
    });
  });

  test("renders partial output as non-terminal streaming ADK events", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "output", content: "partial", partial: true },
        { type: "output", content: "final" },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      partial: true,
      turnComplete: false,
      content: { role: "model", parts: [{ text: "partial" }] },
    });
    expect(events[1]).toMatchObject({
      partial: undefined,
      turnComplete: true,
      content: { role: "model", parts: [{ text: "final" }] },
    });
  });

  test("does not render started or completed lifecycle events", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "started", providerId: "codex" },
        { type: "output", content: "Visible" },
        { type: "completed", exitCode: 0 },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0]?.text).toBe("Visible");
  });

  test("traces synthetic ADK llm_request with native ADK model attributes", async () => {
    const spans = installTraceCapture();
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "Hello" }]),
    });

    await collect(agent, {
      userContent: { role: "user", parts: [{ text: "Review this diff" }] },
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      "gen_ai.system": "gcp.vertex.agent",
      "gen_ai.request.model": CODEX_PROVIDER.id,
      "gcp.vertex.agent.provider_id": CODEX_PROVIDER.id,
      "gcp.vertex.agent.event_title": "codex_agent: final response",
    });
    expect(JSON.parse(spans[0].attributes["gcp.vertex.agent.llm_request"] as string)).toEqual({
      model: CODEX_PROVIDER.id,
      contents: [{ role: "user", parts: [{ text: "Review this diff" }] }],
    });
  });

  test("renders errors using ADK errorCode and errorMessage fields", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        {
          type: "error",
          code: "CODEX_ERROR",
          message: "Something failed",
          recoverable: true,
        },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      invocationId: "inv-1",
      author: "codex_agent",
      branch: "root.external",
      errorCode: "CODEX_ERROR",
      errorMessage: "Something failed",
    });
    expect(events[0].content).toBeUndefined();
  });

  test("renders tool calls as ADK functionCall parts", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "tool_call", name: "shell", input: { command: "pwd" } },
        { type: "tool_call", name: "raw", input: "value" },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(2);
    expect(events[0].content).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "shell", args: { command: "pwd" } } }],
    });
    expect(events[1].content).toEqual({
      role: "model",
      parts: [{ functionCall: { name: "raw", args: { input: "value" } } }],
    });
  });

  test("renders tool results as ADK functionResponse parts", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        {
          type: "tool_result",
          name: "shell",
          callId: "call-1",
          result: { stdout: "ok" },
        },
      ]),
    });

    const events = await collect(agent);

    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "call-1",
            name: "shell",
            response: { stdout: "ok" },
          },
        },
      ],
    });
  });

  test("emits native transfer_to_agent delegation through Runner sessions and state", async () => {
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: new DelegatingDriver(),
      subAgents: [new StateAgent()],
    });
    const runner = new Runner({ appName: "app", agent, sessionService });

    const streamed = [];
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "understand architecture" }] },
    })) {
      streamed.push(event);
    }

    const updated = await sessionService.getSession({
      appName: "app",
      userId: "user",
      sessionId: session.id,
    });

    expect(streamed.some((event) => event.partial)).toBe(true);
    expect(updated?.events.some((event) => event.partial)).toBe(false);

    // Delegation is shaped as a native transfer_to_agent call.
    expect(
      updated?.events.some((event) =>
        event.content?.parts?.some((part) => part.functionCall?.name === "transfer_to_agent"),
      ),
    ).toBe(true);

    // The sub-agent's turn is surfaced on the root branch with no external-agent
    // metadata (renders as the sub-agent's own turn on the shared timeline).
    expect(
      updated?.events.some(
        (event) =>
          event.author === "state_agent" &&
          event.content?.parts?.[0]?.text === "child output" &&
          event.customMetadata === undefined,
      ),
    ).toBe(true);

    // The transfer response carries the agent-switch signal.
    const transferResponse = updated?.events.find((event) =>
      event.content?.parts?.some((part) => part.functionResponse?.name === "transfer_to_agent"),
    );
    expect(transferResponse).toBeDefined();
    expect(transferResponse?.actions?.transferToAgent).toBe("state_agent");

    // No legacy run_adk_subagent event leaks through.
    expect(
      updated?.events.some((event) =>
        event.content?.parts?.some(
          (part) =>
            part.functionCall?.name === "run_adk_subagent" ||
            part.functionResponse?.name === "run_adk_subagent",
        ),
      ),
    ).toBe(false);

    // Native ordering: call -> transfer response (with the agent-switch signal,
    // fired BEFORE the sub-agent runs) -> sub-agent turn.
    const functionCallIndex = updated?.events.findIndex((event) =>
      event.content?.parts?.some((part) => part.functionCall?.name === "transfer_to_agent"),
    );
    const functionResponseIndex = updated?.events.findIndex((event) =>
      event.content?.parts?.some((part) => part.functionResponse?.name === "transfer_to_agent"),
    );
    const childEventIndex = updated?.events.findIndex(
      (event) => event.author === "state_agent" && event.content?.parts?.[0]?.text === "child output",
    );
    expect(functionCallIndex).toBeGreaterThanOrEqual(0);
    expect(functionResponseIndex).toBeGreaterThan(functionCallIndex ?? -1);
    expect(childEventIndex).toBeGreaterThan(functionResponseIndex ?? -1);

    // Root does NOT re-narrate the sub-agent's answer: the only terminal model
    // text authored by the root is "starting" was partial; the final "child
    // output" re-narration is suppressed.
    const rootFinalText = updated?.events.filter(
      (event) =>
        event.author === "root_external" &&
        !event.partial &&
        event.content?.parts?.some((part) => typeof part.text === "string" && part.text.length > 0),
    );
    expect(rootFinalText).toHaveLength(0);

    expect(updated?.state.architectureSummary).toBe("done");
  });

  test("suppresses the root re-narration only when a delegation just produced the final answer", async () => {
    // A driver that delegates, then re-narrates — and on a SECOND turn produces
    // legitimate root text with no delegation (must NOT be suppressed).
    class TwoPhaseDriver implements ExternalAgentDriver {
      readonly providerId = CODEX_PROVIDER.id;

      async *run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
        await request.toolGateway?.runSubAgent({
          agentName: "state_agent",
          task: "summarize",
        });
        // Root re-narration of the delegated answer — should be suppressed.
        yield { type: "output", content: "child output (re-narrated)" };
        // Independent root text after the delegation flag is consumed — kept.
        yield { type: "output", content: "additional root commentary" };
      }
    }

    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: new TwoPhaseDriver(),
      subAgents: [new StateAgent()],
    });

    const events = await collect(agent, { branch: undefined });
    const rootTexts = events
      .filter((event) => event.author === "root_external")
      .map((event) => event.content?.parts?.[0]?.text)
      .filter((text): text is string => typeof text === "string");

    expect(rootTexts).not.toContain("child output (re-narrated)");
    expect(rootTexts).toContain("additional root commentary");
  });
});
