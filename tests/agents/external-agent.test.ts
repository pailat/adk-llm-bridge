import { afterEach, describe, expect, test } from "bun:test";
import {
  BaseAgent,
  createEvent,
  createEventActions,
  createSession,
  InMemoryRunner,
  InMemorySessionService,
  type InvocationContext,
  isFinalResponse,
  Runner,
  Workflow,
} from "@google/adk";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import { withDeadline } from "./helpers.js";

// installTraceCapture() sets a process-global tracer provider; always undo it.
afterEach(() => {
  trace.disable();
});

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
      actions: createEventActions({
        stateDelta: { architectureSummary: "done" },
      }),
    });
  }

  protected async *runLiveImpl() {}
}

class StaticDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  request?: ExternalAgentRunRequest;

  constructor(private readonly events: ExternalAgentEvent[]) {}

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    this.request = request;
    yield* this.events;
  }
}

class DelegatingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;

  async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    yield { type: "output", content: "starting", partial: true };
    const result = await request.toolGateway?.runSubAgent({
      agentName: "state_agent",
      task: "summarize architecture",
    });
    yield { type: "output", content: result?.output ?? "missing" };
  }
}

class TerminalThenPendingDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  returned = false;

  async *run(): AsyncIterable<ExternalAgentEvent> {
    try {
      yield { type: "output", content: "done" };
      yield { type: "completed", exitCode: 0 };
      await new Promise<never>(() => {});
    } finally {
      this.returned = true;
    }
  }
}

type CapturedSpan = {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
};

function installTraceCapture(): CapturedSpan[] {
  const spans: CapturedSpan[] = [];
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer(_name?: string, version?: string) {
      // ADK >= 2.5 also opens its own spans (invoke_agent, ...) through the
      // global provider; only record the ones created by this package's tracer.
      const ours = version === "adk-llm-bridge";
      return {
        startSpan(name: string) {
          const span: CapturedSpan = { name, attributes: {} };
          if (ours) spans.push(span);
          return {
            setAttributes(attributes: Record<string, unknown>) {
              Object.assign(span.attributes, attributes);
              return this;
            },
            setAttribute(key: string, value: unknown) {
              span.attributes[key] = value;
              return this;
            },
            setStatus(status: { code: number; message?: string }) {
              (span as CapturedSpan).status = status;
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

async function collect(
  agent: ExternalAgent,
  context: Partial<InvocationContext> = {},
) {
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
    // The agent cannot know the runtime's own thread id (each driver keeps
    // it under its own state key), so it sends none rather than a made-up one.
    expect(driver.request?.runtimeSession).toBeUndefined();
    expect(driver.request).not.toHaveProperty("tools");
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

  test("closes the ADK stream at completed without waiting for provider EOF", async () => {
    const driver = new TerminalThenPendingDriver();
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });

    const events = await withDeadline(
      collect(agent),
      2000,
      "external agent waited for provider EOF after completed",
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.content?.parts?.[0]?.text).toBe("done");
    expect(driver.returned).toBe(true);
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
      "gen_ai.operation.name": "call_llm",
      "gcp.vertex.agent.provider_id": CODEX_PROVIDER.id,
      "gcp.vertex.agent.event_title": "codex_agent: final response",
    });
    // With no configured or reported model the provider id ("codex") is
    // never passed off as a model.
    expect(spans[0].attributes["gen_ai.request.model"]).toBeUndefined();
    expect(spans[0].attributes["gen_ai.response.model"]).toBeUndefined();
    expect(
      JSON.parse(spans[0].attributes["gcp.vertex.agent.llm_request"] as string),
    ).toEqual({
      contents: [{ role: "user", parts: [{ text: "Review this diff" }] }],
    });
  });

  test("uses the configured and reported model ids, never the provider id", async () => {
    const spans = installTraceCapture();
    const driver = Object.assign(
      new StaticDriver([
        { type: "started", providerId: CODEX_PROVIDER.id, model: "gpt-x-1" },
        { type: "output", content: "Hello" },
      ]),
      { model: "gpt-x" },
    );
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });

    await collect(agent, {
      userContent: { role: "user", parts: [{ text: "Review this diff" }] },
    });

    expect(spans).toHaveLength(1);
    expect(spans[0].attributes).toMatchObject({
      "gen_ai.request.model": "gpt-x",
      "gen_ai.response.model": "gpt-x-1",
    });
    expect(
      JSON.parse(spans[0].attributes["gcp.vertex.agent.llm_request"] as string)
        .model,
    ).toBe("gpt-x");
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
      newMessage: {
        role: "user",
        parts: [{ text: "understand architecture" }],
      },
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
        event.content?.parts?.some(
          (part) => part.functionCall?.name === "transfer_to_agent",
        ),
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
      event.content?.parts?.some(
        (part) => part.functionResponse?.name === "transfer_to_agent",
      ),
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
      event.content?.parts?.some(
        (part) => part.functionCall?.name === "transfer_to_agent",
      ),
    );
    const functionResponseIndex = updated?.events.findIndex((event) =>
      event.content?.parts?.some(
        (part) => part.functionResponse?.name === "transfer_to_agent",
      ),
    );
    const childEventIndex = updated?.events.findIndex(
      (event) =>
        event.author === "state_agent" &&
        event.content?.parts?.[0]?.text === "child output",
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
        event.content?.parts?.some(
          (part) => typeof part.text === "string" && part.text.length > 0,
        ),
    );
    expect(rootFinalText).toHaveLength(0);

    expect(updated?.state.architectureSummary).toBe("done");
  });

  test("suppresses the root re-narration only when a delegation just produced the final answer", async () => {
    // A driver that delegates, then re-narrates — and on a SECOND turn produces
    // legitimate root text with no delegation (must NOT be suppressed).
    class TwoPhaseDriver implements ExternalAgentDriver {
      readonly providerId = CODEX_PROVIDER.id;

      async *run(
        request: ExternalAgentRunRequest,
      ): AsyncIterable<ExternalAgentEvent> {
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

describe("ExternalAgent ADK 2.x integration", () => {
  test("clone() rebuilds the agent with provider, driver and permissions", () => {
    const driver = new StaticDriver([]);
    const child = new ExternalAgent({
      name: "child",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([]),
    });
    const agent = new ExternalAgent({
      name: "original",
      provider: CODEX_PROVIDER,
      driver,
      instruction: "be brief",
      permissions: { mode: "read-only" },
      subAgents: [child],
    });

    const copy = agent.clone();
    expect(copy).toBeInstanceOf(ExternalAgent);
    expect(copy).not.toBe(agent);
    expect(copy.driver).toBe(driver);
    expect(copy.provider).toBe(CODEX_PROVIDER);
    expect(copy.instruction).toBe("be brief");
    expect(copy.permissions).toEqual({ mode: "read-only" });
    expect(copy.parentAgent).toBeUndefined();
    expect(copy.subAgents).toHaveLength(1);
    expect(copy.subAgents[0]).not.toBe(child);
    expect(copy.subAgents[0]?.parentAgent).toBe(copy);

    const renamed = agent.clone({
      name: "renamed",
      permissions: { mode: "full-access" },
    });
    expect(renamed.name).toBe("renamed");
    expect(renamed.permissions).toEqual({ mode: "full-access" });
    expect(agent.permissions).toEqual({ mode: "read-only" });
  });

  test("honors ADK before/afterAgentCallback from the config", async () => {
    const skipped = new StaticDriver([{ type: "output", content: "driver" }]);
    const blocked = new ExternalAgent({
      name: "blocked",
      provider: CODEX_PROVIDER,
      driver: skipped,
      beforeAgentCallback: () => ({
        role: "model",
        parts: [{ text: "short-circuit" }],
      }),
    });
    const session = createSession({ id: "s", appName: "app", userId: "user" });
    const blockedEvents = await collect(blocked, { session });
    expect(blockedEvents.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      "short-circuit",
    ]);
    expect(skipped.request).toBeUndefined();

    const after = new ExternalAgent({
      name: "after",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "driver" }]),
      afterAgentCallback: () => ({
        role: "model",
        parts: [{ text: "after" }],
      }),
    });
    const afterEvents = await collect(after, { session });
    expect(afterEvents.map((e) => e.content?.parts?.[0]?.text)).toEqual([
      "driver",
      "after",
    ]);
  });

  test("final output carries output and nodeInfo; partial output does not", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "output", content: "draft", partial: true },
        { type: "output", content: "final" },
      ]),
    });

    const [partial, final] = await collect(agent);

    expect(partial?.output).toBeUndefined();
    expect(final?.output).toBe("final");
    expect(final?.nodeInfo).toMatchObject({ messageAsOutput: true });
  });

  test("works as a node of an ADK Workflow and feeds the next node", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "HELLO" }]),
    });
    const received: unknown[] = [];
    const sink = Object.defineProperty(
      (_ctx: unknown, input: unknown) => {
        received.push(input);
        return "done";
      },
      "name",
      { value: "sink" },
    );
    const workflow = new Workflow({
      name: "wf",
      edges: [["START", agent, sink]],
    } as never);
    const runner = new InMemoryRunner({
      agent: workflow as never,
      appName: "app",
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "user",
    });

    for await (const _event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text: "go" }] },
    })) {
      // drain
    }

    expect(received).toEqual(["HELLO"]);
  });

  test("clone() shares the driver instance unless overridden", () => {
    const driver = new StaticDriver([]);
    const agent = new ExternalAgent({
      name: "a",
      provider: CODEX_PROVIDER,
      driver,
    });
    expect(agent.clone().driver).toBe(driver);
    const fresh = new StaticDriver([]);
    expect(agent.clone({ name: "b", driver: fresh }).driver).toBe(fresh);
  });

  async function runAsNode(
    agent: ExternalAgent,
  ): Promise<{ received: unknown[]; errors: (string | undefined)[] }> {
    const received: unknown[] = [];
    const sink = Object.defineProperty(
      (_ctx: unknown, input: unknown) => {
        received.push(input);
        return "done";
      },
      "name",
      { value: "sink" },
    );
    const runner = new InMemoryRunner({
      agent: new Workflow({
        name: "wf",
        edges: [["START", agent, sink]],
      } as never) as never,
      appName: "app",
    });
    const session = await runner.sessionService.createSession({
      appName: "app",
      userId: "user",
    });
    const errors: (string | undefined)[] = [];
    try {
      for await (const event of runner.runAsync({
        userId: "user",
        sessionId: session.id,
        newMessage: { role: "user", parts: [{ text: "go" }] },
      })) {
        if (event.errorCode) errors.push(event.errorMessage);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { received, errors };
  }

  test("outputSchema: JSON text is parsed into the node output", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: '{"x":1}' }]),
      outputSchema: z.object({ x: z.number() }),
    });

    const { received, errors } = await runAsNode(agent);

    expect(errors).toEqual([]);
    expect(received).toEqual([{ x: 1 }]);
  });

  test("outputSchema: non-JSON text is kept raw and ADK reports the mismatch", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "not json" }]),
      outputSchema: z.object({ x: z.number() }),
    });

    const [final] = await collect(agent);
    expect(final?.output).toBe("not json");

    const { received, errors } = await runAsNode(agent);
    expect(received).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("outputSchema: an integer id beyond the safe range stays exact", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "output", content: '{"id":12345678901234567890,"n":2}' },
      ]),
      outputSchema: z.object({ id: z.string(), n: z.number() }),
    });

    const [final] = await collect(agent);
    expect(final?.output).toEqual({ id: "12345678901234567890", n: 2 });
  });

  test("outputSchema: a JSON array answer is still parsed", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "[1,2]" }]),
      outputSchema: z.object({ x: z.number() }),
    });

    const [final] = await collect(agent);
    expect(final?.output).toEqual([1, 2]);
  });

  test("outputSchema: unsafe integers stay exact in an array or scalar answer", async () => {
    const run = async (content: string) => {
      const agent = new ExternalAgent({
        name: "worker",
        provider: CODEX_PROVIDER,
        driver: new StaticDriver([{ type: "output", content }]),
        outputSchema: z.array(z.string()),
      });
      const [final] = await collect(agent);
      return final?.output;
    };

    expect(await run("[12345678901234567890]")).toEqual([
      "12345678901234567890",
    ]);
    expect(await run("12345678901234567890")).toBe("12345678901234567890");
    expect(await run('"text"')).toBe("text");
  });

  test("an error with an empty code reports EXTERNAL_AGENT_ERROR in the code and the title", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "error", message: "boom", code: "", recoverable: true },
      ]),
    });
    const events = await collect(agent);
    const error = events.find((event) => event.errorMessage === "boom");
    expect(error?.errorCode).toBe("EXTERNAL_AGENT_ERROR");
    expect(error?.customMetadata?.title).toBe(
      "worker: error EXTERNAL_AGENT_ERROR",
    );
  });

  test("without outputSchema the output stays raw text even if it is JSON", async () => {
    const agent = new ExternalAgent({
      name: "worker",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: '{"x":1}' }]),
    });
    const [final] = await collect(agent);
    expect(final?.output).toBe('{"x":1}');
  });

  test("passes the Runner abort signal to the driver and aborts it when the consumer abandons the stream", async () => {
    let seen: AbortSignal | undefined;
    let finished = false;
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run(request) {
        seen = request.abortSignal;
        try {
          yield { type: "output", content: "one", partial: true };
          await new Promise<never>((_, reject) => {
            request.abortSignal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
        } finally {
          finished = true;
        }
      },
    };
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });
    const upstream = new AbortController();

    const iterator = agent.runAsync({
      invocationId: "inv-1",
      abortSignal: upstream.signal,
    } as InvocationContext);
    const first = await iterator.next();
    expect(first.value?.content?.parts?.[0]?.text).toBe("one");
    expect(seen?.aborted).toBe(false);

    await iterator.return(undefined);

    expect(seen?.aborted).toBe(true);
    await withDeadline(
      (async () => {
        while (!finished) await new Promise((r) => setTimeout(r, 5));
      })(),
      2000,
      "driver was not cancelled after the consumer abandoned the stream",
    );
    expect(upstream.signal.aborted).toBe(false);
  });

  test("an upstream abort reaches the driver signal", async () => {
    let seen: AbortSignal | undefined;
    const upstream = new AbortController();
    const driver: ExternalAgentDriver = {
      providerId: CODEX_PROVIDER.id,
      async *run(request) {
        seen = request.abortSignal;
        upstream.abort();
        yield { type: "output", content: "x" };
      },
    };
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });

    await collect(agent, { abortSignal: upstream.signal });

    expect(seen?.aborted).toBe(true);
  });

  test("does not abort the driver signal on a normal completion", async () => {
    const driver = new StaticDriver([{ type: "output", content: "ok" }]);
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver,
    });

    await collect(agent);

    expect(driver.request?.abortSignal?.aborted).toBe(false);
  });
});

describe("ExternalAgent telemetry", () => {
  const ENV = "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS";
  const original = process.env[ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  async function runWithSpans(value: string | undefined) {
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    const spans = installTraceCapture();
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([{ type: "output", content: "secret" }]),
    });
    await collect(agent, {
      userContent: { role: "user", parts: [{ text: "private prompt" }] },
    });
    return spans;
  }

  test("captures message content by default", async () => {
    const spans = await runWithSpans(undefined);
    expect(spans[0]?.attributes["gcp.vertex.agent.llm_request"]).toContain(
      "private prompt",
    );
    expect(spans[0]?.attributes["gcp.vertex.agent.llm_response"]).toContain(
      "secret",
    );
  });

  for (const value of ["false", "0"]) {
    test(`redacts message content when ${ENV}=${value}`, async () => {
      const spans = await runWithSpans(value);
      expect(spans[0]?.attributes["gcp.vertex.agent.llm_request"]).toBe("{}");
      expect(spans[0]?.attributes["gcp.vertex.agent.llm_response"]).toBe("{}");
    });
  }

  describe("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT (ADK >= 2.5)", () => {
    const OTEL = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";
    const originalOtel = process.env[OTEL];
    afterEach(() => {
      if (originalOtel === undefined) delete process.env[OTEL];
      else process.env[OTEL] = originalOtel;
    });

    for (const [value, captured] of [
      ["NO_CONTENT", false],
      ["EVENT_ONLY", false],
      ["SPAN_ONLY", true],
      ["SPAN_AND_EVENT", true],
    ] as const) {
      test(`${OTEL}=${value} ${captured ? "captures" : "redacts"} content`, async () => {
        process.env[OTEL] = value;
        const spans = await runWithSpans(undefined);
        const request = spans[0]?.attributes["gcp.vertex.agent.llm_request"];
        if (captured) expect(request).toContain("private prompt");
        else expect(request).toBe("{}");
      });
    }

    test("takes precedence over ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS", async () => {
      process.env[OTEL] = "NO_CONTENT";
      const spans = await runWithSpans("true");
      expect(spans[0]?.attributes["gcp.vertex.agent.llm_request"]).toBe("{}");
    });
  });

  test("marks error events with error.type and ERROR status without the message", async () => {
    const spans = installTraceCapture();
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        {
          type: "error",
          code: "CODEX_ERROR",
          message: "sensitive detail",
          recoverable: false,
        },
      ]),
    });

    await collect(agent);

    expect(spans[0]?.attributes["error.type"]).toBe("CODEX_ERROR");
    expect(spans[0]?.status).toEqual({ code: 2, message: "CODEX_ERROR" });
  });

  test("records the transfer target from the native agent_name argument", async () => {
    const spans = installTraceCapture();
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: new DelegatingDriver(),
      subAgents: [new StateAgent()],
    });

    await collect(agent);

    const transfer = spans.find(
      (span) => span.attributes["gen_ai.tool.name"] === "transfer_to_agent",
    );
    expect(transfer?.attributes["gcp.vertex.agent.subagent.name"]).toBe(
      "state_agent",
    );
  });
});

describe("ExternalAgent delegation final answer", () => {
  class FailingAgent extends BaseAgent {
    constructor() {
      super({ name: "failing_agent" });
    }
    protected async *runAsyncImpl(context: InvocationContext) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        errorCode: "BOOM",
        errorMessage: "child failed",
      });
    }
    protected async *runLiveImpl() {}
  }

  class EscalatingAgent extends BaseAgent {
    constructor() {
      super({ name: "escalating_agent" });
    }
    protected async *runAsyncImpl(context: InvocationContext) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        actions: createEventActions({ escalate: true }),
      });
    }
    protected async *runLiveImpl() {}
  }

  function scripted(
    script: (
      request: ExternalAgentRunRequest,
    ) => AsyncIterable<ExternalAgentEvent>,
  ): ExternalAgentDriver {
    return { providerId: CODEX_PROVIDER.id, run: script };
  }

  const rootTexts = (events: Awaited<ReturnType<typeof collect>>) =>
    events
      .filter((event) => event.author === "root_external")
      .map((event) => event.content?.parts?.[0]?.text)
      .filter((text): text is string => typeof text === "string");

  test("a failed delegation does not suppress the coordinator's explanation", async () => {
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: scripted(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "state_agent",
          task: "first",
        });
        // Second delegation fails: its flag decision replaces the first one.
        await request.toolGateway?.runSubAgent({
          agentName: "failing_agent",
          task: "second",
        });
        yield { type: "output", content: "the second delegation failed" };
      }),
      subAgents: [new StateAgent(), new FailingAgent()],
    });

    const texts = rootTexts(await collect(agent, { branch: undefined }));

    expect(texts).toContain("the second delegation failed");
  });

  test("a new tool call after the delegation means the coordinator keeps the floor", async () => {
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: scripted(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "state_agent",
          task: "first",
        });
        yield { type: "tool_call", callId: "c1", name: "shell", input: {} };
        yield { type: "output", content: "synthesis after more work" };
      }),
      subAgents: [new StateAgent()],
    });

    const texts = rootTexts(await collect(agent, { branch: undefined }));

    expect(texts).toContain("synthesis after more work");
  });

  test('finalAnswer "coordinator" lets the coordinator synthesize and does not set skipSummarization', async () => {
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      delegation: { finalAnswer: "coordinator" },
      driver: scripted(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "state_agent",
          task: "a",
        });
        yield { type: "output", content: "synthesis of everything" };
      }),
      subAgents: [new StateAgent()],
    });

    const events = await collect(agent, { branch: undefined });

    expect(rootTexts(events)).toContain("synthesis of everything");
    const transferResponse = events.find((event) =>
      event.content?.parts?.some(
        (part) => part.functionResponse?.name === "transfer_to_agent",
      ),
    );
    expect(transferResponse?.actions.transferToAgent).toBe("state_agent");
    expect(transferResponse?.actions.skipSummarization).toBeUndefined();
  });

  test('default "subagent" mode marks the transfer response as a final response', async () => {
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: scripted(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "state_agent",
          task: "a",
        });
        yield { type: "completed", exitCode: 0 };
      }),
      subAgents: [new StateAgent()],
    });

    const events = await collect(agent, { branch: undefined });
    const transferResponse = events.find((event) =>
      event.content?.parts?.some(
        (part) => part.functionResponse?.name === "transfer_to_agent",
      ),
    );

    expect(transferResponse?.actions.skipSummarization).toBe(true);
    expect(transferResponse && isFinalResponse(transferResponse)).toBe(true);
  });

  test("a child's escalate reaches the enclosing agent's stream", async () => {
    const agent = new ExternalAgent({
      name: "root_external",
      provider: CODEX_PROVIDER,
      driver: scripted(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "escalating_agent",
          task: "stop the loop",
        });
        yield { type: "completed", exitCode: 0 };
      }),
      subAgents: [new EscalatingAgent()],
    });

    const events = await collect(agent, { branch: undefined });

    expect(events.some((event) => event.actions.escalate === true)).toBe(true);
  });

  test("each invocation has its own state (parallel runs do not interfere)", async () => {
    const make = () =>
      new ExternalAgent({
        name: "root_external",
        provider: CODEX_PROVIDER,
        driver: scripted(async function* (request) {
          await request.toolGateway?.runSubAgent({
            agentName: "state_agent",
            task: "a",
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield { type: "output", content: "narration" };
        }),
        subAgents: [new StateAgent()],
      });
    const agentWithTexts = async () =>
      rootTexts(await collect(make(), { branch: undefined }));

    const [first, second] = await Promise.all([
      agentWithTexts(),
      agentWithTexts(),
    ]);

    expect(first).not.toContain("narration");
    expect(second).not.toContain("narration");
  });
});

describe("ExternalAgent telemetry privacy (no content in span names or titles)", () => {
  const OTEL = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";
  const LEGACY = "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS";
  const saved = { otel: process.env[OTEL], legacy: process.env[LEGACY] };
  afterEach(() => {
    for (const [key, value] of [
      [OTEL, saved.otel],
      [LEGACY, saved.legacy],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const SECRET_COMMAND = "cat /etc/SECRETFILE-xyz";
  const SECRET_OUTPUT = "TOPSECRET-ANSWER";
  const SECRET_PROMPT = "PRIVATE-USER-TEXT";
  const SECRETS = [
    "SECRETFILE-xyz",
    SECRET_OUTPUT,
    SECRET_PROMPT,
    "web-query-secret",
  ];

  async function traceRun(env: { otel?: string; legacy?: string }) {
    if (env.otel === undefined) delete process.env[OTEL];
    else process.env[OTEL] = env.otel;
    if (env.legacy === undefined) delete process.env[LEGACY];
    else process.env[LEGACY] = env.legacy;

    const spans = installTraceCapture();
    const agent = new ExternalAgent({
      name: "claude_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        {
          type: "tool_call",
          callId: "c1",
          name: "Bash",
          input: { command: SECRET_COMMAND },
        },
        {
          type: "tool_result",
          callId: "c1",
          name: "Bash",
          result: { command: SECRET_COMMAND, stdout: SECRET_OUTPUT },
        },
        // Codex-style tool progress carrying the command in metadata, then
        // the builtin call/result pair the Codex driver emits on
        // item.completed.
        {
          type: "output",
          content: "running",
          partial: true,
          metadata: {
            itemType: "command_execution",
            itemId: "cmd_1",
            status: "in_progress",
            command: SECRET_COMMAND,
            title: `claude_agent: Bash call: ${SECRET_COMMAND}`,
          },
        },
        {
          type: "tool_call",
          callId: "cmd_1",
          name: "command_execution",
          input: { command: SECRET_COMMAND },
          metadata: { itemType: "command_execution", builtin: true },
        },
        {
          type: "tool_result",
          callId: "cmd_1",
          name: "command_execution",
          result: { command: SECRET_COMMAND, output: SECRET_OUTPUT },
          metadata: { itemType: "command_execution", builtin: true },
        },
        {
          type: "output",
          content: "searching",
          partial: true,
          metadata: { itemType: "web_search", query: "web-query-secret" },
        },
        {
          type: "tool_call",
          callId: "ws_1",
          name: "web_search",
          input: { query: "web-query-secret" },
          metadata: { itemType: "web_search", builtin: true },
        },
        {
          type: "tool_result",
          callId: "ws_1",
          name: "web_search",
          result: { query: "web-query-secret" },
          metadata: { itemType: "web_search", builtin: true },
        },
        { type: "output", content: SECRET_OUTPUT },
      ]),
    });
    await collect(agent, {
      userContent: { role: "user", parts: [{ text: SECRET_PROMPT }] },
    });
    return spans;
  }

  const leaks = (spans: CapturedSpan[]) =>
    SECRETS.filter((secret) =>
      spans.some((span) =>
        JSON.stringify({
          name: span.name,
          attributes: span.attributes,
        }).includes(secret),
      ),
    );

  for (const [label, env] of [
    ["OTEL NO_CONTENT", { otel: "NO_CONTENT" }],
    ["OTEL EVENT_ONLY", { otel: "EVENT_ONLY" }],
    ["legacy ADK variable set to false", { legacy: "false" }],
  ] as const) {
    test(`${label}: no secret in any span name or attribute`, async () => {
      const spans = await traceRun(env);

      expect(spans.length).toBeGreaterThan(0);
      expect(leaks(spans)).toEqual([]);
    });
  }

  test("NO_CONTENT keeps structural information (tool name, item type, titles without content)", async () => {
    const spans = await traceRun({ otel: "NO_CONTENT" });
    const names = spans.map((span) => span.name);

    expect(names).toContain("execute_tool Bash");
    expect(names).toContain("execute_tool command_execution");
    expect(names).toContain("execute_tool web_search");
    const toolCall = spans.find((span) => span.name === "execute_tool Bash");
    expect(toolCall?.attributes["gen_ai.tool.name"]).toBe("Bash");
    const titles = spans.map(
      (span) => span.attributes["gcp.vertex.agent.event_title"],
    );
    expect(titles).toContain("functionCall:Bash");
    expect(titles).toContain("claude_agent: response");
  });

  for (const [label, env] of [
    ["default", {}],
    ["OTEL SPAN_ONLY", { otel: "SPAN_ONLY" }],
  ] as const) {
    test(`${label}: tool detail stays in span names and titles`, async () => {
      const spans = await traceRun(env);

      expect(spans.map((span) => span.name)).toContain(
        `execute_tool Bash: ${SECRET_COMMAND}`,
      );
      expect(
        spans.some((span) =>
          String(span.attributes["gcp.vertex.agent.event_title"]).includes(
            SECRET_COMMAND,
          ),
        ),
      ).toBe(true);
    });
  }
});

describe("ExternalAgent tool result shapes", () => {
  test("arrays and primitives are wrapped so the response is a record", async () => {
    const agent = new ExternalAgent({
      name: "codex_agent",
      provider: CODEX_PROVIDER,
      driver: new StaticDriver([
        { type: "tool_result", name: "a", callId: "1", result: [1, 2] },
        {
          type: "tool_result",
          name: "b",
          callId: "2",
          result: [1, 2],
          error: "boom",
        },
        { type: "tool_result", name: "c", callId: "3", result: "text" },
        { type: "tool_result", name: "d", callId: "4", result: undefined },
      ]),
    });

    const events = await collect(agent);

    expect(
      events.map(
        (event) => event.content?.parts?.[0]?.functionResponse?.response,
      ),
    ).toEqual([
      { result: [1, 2] },
      { result: [1, 2], error: "boom" },
      { result: "text" },
      { result: null },
    ]);
  });
});
