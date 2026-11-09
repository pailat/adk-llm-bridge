// Span-tree tests for ExternalAgent: one call_llm per model call, real
// durations, nesting, usage attributes, and content capture rules on the
// runtime's built-in tool spans.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Event,
  InMemorySessionService,
  type InvocationContext,
  Runner,
} from "@google/adk";
import { type Context, context, type Span, trace } from "@opentelemetry/api";
import {
  ExternalAgent,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../src/agents/index.js";
import { CODEX_PROVIDER } from "../../src/agents/provider/schema.js";
import {
  ExternalAgentRunTracer,
  usageMetadataFor,
} from "../../src/agents/telemetry.js";

interface RecordedSpan {
  name: string;
  parent?: RecordedSpan;
  attributes: Record<string, unknown>;
  start: number;
  end?: number;
  status?: { code: number; message?: string };
}

// biome-ignore lint/suspicious/noExplicitAny: the root context is opaque
const ROOT = context.active() as any as Context;

function toMillis(time: unknown): number | undefined {
  if (typeof time === "number") return time;
  if (time instanceof Date) return time.getTime();
  return undefined;
}

/**
 * Recording tracer plus an AsyncLocalStorage context manager whose `bind`
 * really binds (ADK binds its generators to the `invoke_agent` context).
 *
 * Only this package's tracer (version `adk-llm-bridge`) and the test's own
 * tracer record. ADK's spans (`invocation`, `invoke_agent ...`) are not public
 * API and its module-level tracer is bound to whichever OTel proxy existed when
 * ADK loaded, so whether they reach this provider depends on test order. They
 * are made transparent instead: a foreign span reuses its parent's span
 * context, so the bridge's spans resolve to the nearest recorded ancestor.
 */
function installOtel(): RecordedSpan[] {
  const spans: RecordedSpan[] = [];
  const storage = new AsyncLocalStorage<Context>();
  const byId = new Map<string, RecordedSpan>();
  let nextId = 1;
  context.disable();
  context.setGlobalContextManager({
    active: () => storage.getStore() ?? ROOT,
    with: (
      ctx: Context,
      fn: (...args: never[]) => unknown,
      thisArg?: unknown,
      ...args: never[]
    ) => storage.run(ctx, () => fn.call(thisArg, ...args)),
    bind: <T>(ctx: Context, target: T): T => {
      if (typeof target !== "function") return target;
      return function (this: unknown, ...args: unknown[]) {
        return storage.run(ctx, () =>
          (target as (...a: unknown[]) => unknown).apply(this, args),
        );
      } as T;
    },
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  } as never);
  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer: (name: string, version?: string) => ({
      startSpan(
        spanName: string,
        options?: { startTime?: unknown },
        ctx?: Context,
      ) {
        const parentSpan = trace.getSpan(ctx ?? context.active());
        const parentContext = parentSpan?.spanContext();
        const recorded = version === "adk-llm-bridge" || name === "test";
        if (!recorded) {
          const inherited = parentContext ?? {
            traceId: "0".repeat(32),
            spanId: "0".repeat(16),
            traceFlags: 0,
          };
          const foreign = {
            setAttributes: () => foreign,
            setAttribute: () => foreign,
            setStatus: () => foreign,
            recordException() {},
            updateName: () => foreign,
            addEvent: () => foreign,
            spanContext: () => inherited,
            isRecording: () => false,
            end() {},
          };
          return foreign as unknown as Span;
        }
        const spanId = (nextId++).toString(16).padStart(16, "0");
        const record: RecordedSpan = {
          name: spanName,
          parent: parentContext ? byId.get(parentContext.spanId) : undefined,
          attributes: {},
          start: toMillis(options?.startTime) ?? Date.now(),
        };
        byId.set(spanId, record);
        spans.push(record);
        const span = {
          setAttributes(attributes: Record<string, unknown>) {
            Object.assign(record.attributes, attributes);
            return span;
          },
          setAttribute(key: string, value: unknown) {
            record.attributes[key] = value;
            return span;
          },
          setStatus(status: { code: number; message?: string }) {
            record.status = status;
            return span;
          },
          recordException() {},
          updateName() {
            return span;
          },
          addEvent() {
            return span;
          },
          spanContext: () => ({
            traceId: "1".repeat(32),
            spanId,
            traceFlags: 1,
          }),
          isRecording: () => true,
          end(time?: unknown) {
            record.end = toMillis(time) ?? Date.now();
          },
        };
        return span as unknown as Span;
      },
    }),
  } as never);
  return spans;
}

const ENV_KEYS = [
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
  "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let spans: RecordedSpan[];

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  spans = installOtel();
});

afterEach(() => {
  trace.disable();
  context.disable();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

class ScriptedDriver implements ExternalAgentDriver {
  readonly providerId = CODEX_PROVIDER.id;
  constructor(
    private readonly script: (
      request: ExternalAgentRunRequest,
    ) => AsyncIterable<ExternalAgentEvent>,
    readonly model?: string,
  ) {}
  run(request: ExternalAgentRunRequest): AsyncIterable<ExternalAgentEvent> {
    return this.script(request);
  }
}

async function runTurn(agent: ExternalAgent, text = "go"): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: "app",
    userId: "user",
  });
  const runner = new Runner({ appName: "app", agent, sessionService });
  const events: Event[] = [];
  const root = trace.getTracer("test").startSpan("root");
  await context.with(trace.setSpan(context.active(), root), async () => {
    for await (const event of runner.runAsync({
      userId: "user",
      sessionId: session.id,
      newMessage: { role: "user", parts: [{ text }] },
    })) {
      events.push(event);
    }
  });
  root.end();
  return events;
}

const rootSpan = () => spans.find((span) => span.name === "root");

const named = (prefix: string) =>
  spans.filter((span) => span.name.startsWith(prefix));
const duration = (span: RecordedSpan) => (span.end ?? 0) - span.start;
const agentName = (span: RecordedSpan) =>
  span.attributes["gen_ai.agent.name"] as string | undefined;

/** Base time for scripted timestamps (ms). */
const T0 = 1_750_000_000_000;

function builtinToolRun(): ExternalAgent {
  return new ExternalAgent({
    name: "coder",
    provider: CODEX_PROVIDER,
    driver: new ScriptedDriver(async function* () {
      yield {
        type: "started",
        providerId: CODEX_PROVIDER.id,
        model: "haiku-real-1",
        timestamp: T0,
      };
      yield {
        type: "tool_call",
        name: "Read",
        callId: "toolu_1",
        input: { file_path: "/repo/SECRET-PATH.ts" },
        metadata: { builtin: true },
        timestamp: T0 + 400,
      };
      yield {
        type: "tool_result",
        name: "Read",
        callId: "toolu_1",
        result: { content: "SECRET-FILE-BODY" },
        metadata: { builtin: true },
        timestamp: T0 + 450,
      };
      yield { type: "output", content: "done", timestamp: T0 + 900 };
      yield {
        type: "completed",
        exitCode: 0,
        model: "haiku-real-1",
        usage: {
          inputTokens: 8,
          outputTokens: 873,
          cacheReadInputTokens: 55_000,
          cacheCreationInputTokens: 500,
          totalCostUsd: 0.0051,
          byModel: { "haiku-real-1": { inputTokens: 8, outputTokens: 873 } },
        },
        numTurns: 2,
        durationMs: 900,
        timestamp: T0 + 950,
      };
    }, "haiku"),
  });
}

describe("ExternalAgent spans: one agent with a built-in tool", () => {
  test("one call_llm per model call, with real durations", async () => {
    await runTurn(builtinToolRun());

    const calls = named("call_llm");
    expect(calls).toHaveLength(2);
    // started -> tool_call, then tool_result -> final text.
    expect(calls.map(duration)).toEqual([400, 450]);
    const tool = named("execute_tool Read");
    expect(tool).toHaveLength(1);
    expect(duration(tool[0] as RecordedSpan)).toBe(50);
    for (const span of [...calls, ...tool]) {
      expect(span.end).toBeDefined();
    }
  });

  test("spans nest under the agent's span in one tree with no orphans", async () => {
    await runTurn(builtinToolRun());

    // ADK's invoke_agent span is transparent here (see installOtel), so the
    // nearest recorded ancestor of the bridge's spans is the test root.
    for (const span of [...named("call_llm"), ...named("execute_tool")]) {
      expect(span.parent).toBe(rootSpan());
    }
    const roots = spans.filter((span) => !span.parent);
    expect(roots).toHaveLength(1);
    for (const span of spans) expect(span.end).toBeDefined();
  });

  test("model ids on every span; no per-call usage on call_llm", async () => {
    await runTurn(builtinToolRun());

    for (const span of [...named("call_llm"), ...named("execute_tool")]) {
      expect(span.attributes["gen_ai.request.model"]).toBe("haiku");
      expect(span.attributes["gen_ai.response.model"]).toBe("haiku-real-1");
    }
    // Per-call usage is not reported by the runtime: no tokens on call_llm.
    for (const span of named("call_llm")) {
      expect(span.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    }
  });

  test("run model, usage, cost and turns go on the agent's span", async () => {
    // The tracer annotates the span active when the run starts: ADK's
    // invoke_agent in production, a recorded stand-in here.
    const agentSpan = trace.getTracer("test").startSpan("invoke_agent coder");
    await context.with(trace.setSpan(context.active(), agentSpan), async () => {
      const tracer = new ExternalAgentRunTracer({
        context: {
          invocationId: "inv-1",
          branch: undefined,
          agent: { name: "coder" },
          session: { id: "s-1" },
        } as unknown as InvocationContext,
        providerId: CODEX_PROVIDER.id,
        requestModel: "haiku",
      });
      tracer.onDriverEvent({
        type: "started",
        providerId: CODEX_PROVIDER.id,
        model: "haiku-real-1",
        timestamp: T0,
      });
      tracer.onDriverEvent({ type: "output", content: "x", timestamp: T0 + 5 });
      tracer.onDriverEvent({
        type: "completed",
        model: "haiku-real-1",
        usage: {
          inputTokens: 8,
          outputTokens: 873,
          cacheReadInputTokens: 55_000,
          cacheCreationInputTokens: 500,
          totalCostUsd: 0.0051,
          byModel: { "haiku-real-1": { inputTokens: 8, outputTokens: 873 } },
        },
        numTurns: 2,
        durationMs: 900,
      });
    });
    agentSpan.end();

    const recorded = spans.find((span) => span.name === "invoke_agent coder");
    expect(named("call_llm")[0]?.parent).toBe(recorded);
    expect(recorded?.attributes).toMatchObject({
      "gen_ai.request.model": "haiku",
      "gen_ai.response.model": "haiku-real-1",
      // Full prompt: input + cache read + cache creation (as ADK/Anthropic).
      "gen_ai.usage.input_tokens": 55_508,
      "gen_ai.usage.output_tokens": 873,
      "gen_ai.usage.cache_read.input_tokens": 55_000,
      "gen_ai.usage.cache_creation.input_tokens": 500,
      "gcp.vertex.agent.external_agent.usage.cost_usd": 0.0051,
      "gcp.vertex.agent.external_agent.num_turns": 2,
      "gcp.vertex.agent.external_agent.duration_ms": 900,
    });
    expect(
      JSON.parse(
        recorded?.attributes[
          "gcp.vertex.agent.external_agent.usage.by_model"
        ] as string,
      ),
    ).toEqual({ "haiku-real-1": { inputTokens: 8, outputTokens: 873 } });
  });

  test("unknown usage fields are left out, never zero", () => {
    expect(usageMetadataFor(undefined)).toBeUndefined();
    expect(usageMetadataFor({ totalCostUsd: 0.1 })).toBeUndefined();
    expect(usageMetadataFor({ outputTokens: 5 })).toEqual({
      candidatesTokenCount: 5,
      totalTokenCount: 5,
    });
  });

  describe("usage on the final text (held until completed)", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 100,
    };
    const expected = {
      promptTokenCount: 110,
      candidatesTokenCount: 5,
      totalTokenCount: 115,
      cachedContentTokenCount: 100,
    };
    const run = (events: ExternalAgentEvent[]) =>
      runTurn(
        new ExternalAgent({
          name: "coder",
          provider: CODEX_PROVIDER,
          driver: new ScriptedDriver(async function* () {
            yield* events;
          }),
        }),
      );
    const textOf = (event: Event | undefined) =>
      event?.content?.parts?.[0]?.text;

    test("a state_delta between the final text and completed keeps the usage on the text", async () => {
      // Event order: output A, state_delta, completed(usage). The state-only
      // event must not release the held final text before `completed`.
      const events = await run([
        { type: "output", content: "A" },
        { type: "state_delta", stateDelta: { k: 1 } },
        { type: "completed", usage },
      ]);

      const final = events.find((event) => textOf(event) === "A");
      expect(final?.usageMetadata).toEqual(expected);
      expect(events.at(-1)).toBe(final);
      const delta = events.find((event) => event.actions?.stateDelta?.k === 1);
      expect(delta).toBeDefined();
      expect(delta?.usageMetadata).toBeUndefined();
    });

    test("two texts: only the last one carries the usage", async () => {
      const events = await run([
        { type: "output", content: "A" },
        { type: "output", content: "B" },
        { type: "completed", usage },
      ]);

      expect(events.map(textOf)).toEqual(["A", "B"]);
      expect(events[0]?.usageMetadata).toBeUndefined();
      expect(events[1]?.usageMetadata).toEqual(expected);
    });

    test("an event with content after the text releases it unchanged, in order", async () => {
      const events = await run([
        { type: "output", content: "A" },
        { type: "error", message: "x", code: "E" },
        { type: "completed", usage },
      ]);

      expect(textOf(events[0])).toBe("A");
      expect(events[1]?.errorCode).toBe("E");
      // Already pushed when completed arrived: never changed afterwards.
      expect(events.every((event) => !event.usageMetadata)).toBe(true);
    });

    test("without completed the text is delivered at driver end, without usage", async () => {
      const events = await run([{ type: "output", content: "A" }]);

      expect(events.map(textOf)).toEqual(["A"]);
      expect(events[0]?.usageMetadata).toBeUndefined();
    });
  });

  test("the final ADK event carries usageMetadata", async () => {
    const events = await runTurn(builtinToolRun());
    const final = events.at(-1);

    expect(final?.content?.parts?.[0]?.text).toBe("done");
    expect(final?.usageMetadata).toEqual({
      promptTokenCount: 55_508,
      candidatesTokenCount: 873,
      totalTokenCount: 56_381,
      cachedContentTokenCount: 55_000,
    });
    expect(
      events.filter((event) => event.usageMetadata !== undefined),
    ).toHaveLength(1);
  });

  test("built-in tools become functionCall/functionResponse events", async () => {
    const events = await runTurn(builtinToolRun());

    const call = events.find((e) => e.content?.parts?.[0]?.functionCall);
    const response = events.find(
      (e) => e.content?.parts?.[0]?.functionResponse,
    );
    expect(call?.content?.parts?.[0]?.functionCall).toEqual({
      id: "toolu_1",
      name: "Read",
      args: { file_path: "/repo/SECRET-PATH.ts" },
    });
    expect(response?.content?.parts?.[0]?.functionResponse?.id).toBe("toolu_1");
    expect(
      (call as { customMetadata?: Record<string, unknown> }).customMetadata
        ?.builtin,
    ).toBe(true);
    // Not long-running: ADK never treats them as a pause or runs them itself.
    expect(call?.longRunningToolIds ?? []).toEqual([]);
    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe("done");
  });

  test("built-in tool span carries args and result when capture is on", async () => {
    await runTurn(builtinToolRun());
    const tool = named("execute_tool Read")[0];

    expect(tool?.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "Read",
      "gen_ai.tool.call.id": "toolu_1",
      "gcp.vertex.agent.external_agent.builtin_tool": true,
    });
    expect(tool?.attributes["gcp.vertex.agent.tool_call_args"]).toContain(
      "SECRET-PATH",
    );
    expect(tool?.attributes["gcp.vertex.agent.tool_response"]).toContain(
      "SECRET-FILE-BODY",
    );
  });

  for (const [label, key, value] of [
    [
      "NO_CONTENT",
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
      "NO_CONTENT",
    ],
    [
      "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false",
      "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS",
      "false",
    ],
  ] as const) {
    test(`${label}: built-in tool spans carry no args or results`, async () => {
      process.env[key] = value;
      await runTurn(builtinToolRun());

      const tool = named("execute_tool Read")[0];
      expect(tool?.name).toBe("execute_tool Read");
      expect(tool?.attributes["gcp.vertex.agent.tool_call_args"]).toBe("{}");
      expect(tool?.attributes["gcp.vertex.agent.tool_response"]).toBe("{}");
      const dump = JSON.stringify(
        spans.map((span) => ({ name: span.name, attributes: span.attributes })),
      );
      expect(dump).not.toContain("SECRET-PATH");
      expect(dump).not.toContain("SECRET-FILE-BODY");
    });
  }

  test("a failed tool result marks the span without the message", async () => {
    const agent = new ExternalAgent({
      name: "coder",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield {
          type: "tool_call",
          name: "Bash",
          callId: "b1",
          input: { command: "ls" },
          metadata: { builtin: true },
          timestamp: T0,
        };
        yield {
          type: "tool_result",
          name: "Bash",
          callId: "b1",
          result: "nope",
          error: "SECRET-ERROR-TEXT",
          metadata: { builtin: true },
          timestamp: T0 + 10,
        };
        yield { type: "output", content: "ok", timestamp: T0 + 20 };
      }),
    });
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "NO_CONTENT";
    await runTurn(agent);

    const tool = named("execute_tool Bash")[0];
    expect(tool?.attributes["error.type"]).toBe("TOOL_ERROR");
    expect(tool?.status?.code).toBe(2);
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain(
      "SECRET-ERROR-TEXT",
    );
  });

  test("parallel tool calls in one step are one model call; open calls end at run end", async () => {
    const agent = new ExternalAgent({
      name: "coder",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield { type: "output", content: "plan", timestamp: T0 + 100 };
        yield {
          type: "tool_call",
          name: "Read",
          callId: "r1",
          metadata: { builtin: true },
          timestamp: T0 + 110,
        };
        yield {
          type: "tool_call",
          name: "Grep",
          callId: "g1",
          metadata: { builtin: true },
          timestamp: T0 + 120,
        };
        yield {
          type: "tool_result",
          name: "Grep",
          callId: "g1",
          result: "x",
          timestamp: T0 + 150,
        };
        yield { type: "completed", timestamp: T0 + 200 };
      }),
    });
    await runTurn(agent);

    expect(named("call_llm")).toHaveLength(1);
    const grep = named("execute_tool Grep")[0] as RecordedSpan;
    expect(duration(grep)).toBe(30);
    const read = named("execute_tool Read")[0] as RecordedSpan;
    expect(read.end).toBe(T0 + 200);
    expect(
      read.attributes["gcp.vertex.agent.external_agent.tool_incomplete"],
    ).toBe(true);
  });
});

describe("ExternalAgent spans: Codex item progress", () => {
  test("progress ends the model call, gives the tool span its start, and makes no span itself", async () => {
    const agent = new ExternalAgent({
      name: "codex",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield { type: "started", providerId: CODEX_PROVIDER.id, timestamp: T0 };
        yield {
          type: "output",
          content: "Codex command in_progress: ls",
          partial: true,
          metadata: { itemType: "command_execution", itemId: "item_1" },
          timestamp: T0 + 100,
        };
        yield {
          type: "output",
          content: "Codex command in_progress: ls",
          partial: true,
          metadata: { itemType: "command_execution", itemId: "item_1" },
          timestamp: T0 + 200,
        };
        // item.completed: call and result arrive together.
        yield {
          type: "tool_call",
          name: "command_execution",
          callId: "item_1",
          input: { command: "ls" },
          metadata: { itemType: "command_execution", builtin: true },
          timestamp: T0 + 700,
        };
        yield {
          type: "tool_result",
          name: "command_execution",
          callId: "item_1",
          result: { output: "a b" },
          metadata: { itemType: "command_execution", builtin: true },
          timestamp: T0 + 700,
        };
        yield { type: "output", content: "listed", timestamp: T0 + 900 };
        yield { type: "completed", timestamp: T0 + 950 };
      }),
    });
    await runTurn(agent);

    const calls = named("call_llm");
    expect(calls.map(duration)).toEqual([100, 200]);
    const tools = named("execute_tool");
    // Capture is on by default, so the name carries the command.
    expect(tools.map((span) => span.name)).toEqual([
      "execute_tool command_execution: ls",
    ]);
    expect(tools[0]?.start).toBe(T0 + 100);
    expect(duration(tools[0] as RecordedSpan)).toBe(600);
  });
});

describe("ExternalAgent spans: coordinator with a delegated sub-agent", () => {
  function coordinator(): ExternalAgent {
    const researcher = new ExternalAgent({
      name: "researcher",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield {
          type: "started",
          providerId: CODEX_PROVIDER.id,
          model: "haiku-real-1",
        };
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield {
          type: "tool_call",
          name: "Grep",
          callId: "g1",
          metadata: { builtin: true },
        };
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "tool_result", name: "Grep", callId: "g1", result: "x" };
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "output", content: "found it" };
        yield {
          type: "completed",
          usage: { inputTokens: 4, outputTokens: 800 },
        };
      }, "haiku"),
    });
    return new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      delegation: { finalAnswer: "coordinator" },
      driver: new ScriptedDriver(async function* (request) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await request.toolGateway?.runSubAgent({
          agentName: "researcher",
          task: "look",
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "output", content: `summary: ${result?.output}` };
        yield { type: "completed" };
      }, "haiku"),
      subAgents: [researcher],
    });
  }

  test("each model call has exactly one call_llm span (no duplicates)", async () => {
    await runTurn(coordinator());

    const calls = named("call_llm");
    // Coordinator: delegation step + summary step. Researcher: 2 steps.
    expect(calls.filter((s) => agentName(s) === "coordinator")).toHaveLength(2);
    expect(calls.filter((s) => agentName(s) === "researcher")).toHaveLength(2);
    expect(calls).toHaveLength(4);
    // No sub-agent span is re-emitted at the coordinator level: all of them
    // sit inside the delegation.
    const transfer = named("execute_tool transfer_to_agent")[0];
    for (const span of calls.filter((s) => agentName(s) === "researcher")) {
      expect(span.parent).toBe(transfer);
    }
    for (const span of calls.filter((s) => agentName(s) === "coordinator")) {
      expect(span.parent).toBe(rootSpan());
    }
  });

  test("the delegated invoke_agent nests under the transfer span", async () => {
    await runTurn(coordinator());

    const transfer = named("execute_tool transfer_to_agent");
    expect(transfer).toHaveLength(1);
    const transferSpan = transfer[0] as RecordedSpan;
    expect(transferSpan.parent).toBe(rootSpan());
    expect(transferSpan.attributes).toMatchObject({
      "gen_ai.tool.name": "transfer_to_agent",
      "gcp.vertex.agent.subagent.name": "researcher",
    });
    // Everything the sub-agent traced (its invoke_agent, transparent here,
    // and the spans under it) is inside the transfer span, in time too.
    const inner = spans.filter((s) => agentName(s) === "researcher");
    expect(inner.length).toBeGreaterThan(0);
    for (const span of inner) {
      expect(span.parent).toBe(transferSpan);
      expect(span.start).toBeGreaterThanOrEqual(transferSpan.start);
      expect(span.end ?? 0).toBeLessThanOrEqual(transferSpan.end ?? 0);
    }
    expect(duration(transferSpan)).toBeGreaterThan(0);
  });

  test("one trace tree, no orphans, every span ended, non-zero model calls", async () => {
    await runTurn(coordinator());

    expect(spans.filter((span) => !span.parent)).toHaveLength(1);
    for (const span of spans) {
      expect(span.end).toBeDefined();
      if (span.parent) expect(spans).toContain(span.parent);
    }
    for (const span of named("call_llm")) {
      expect(duration(span)).toBeGreaterThan(0);
    }
    expect(named("execute_tool Grep")[0]?.parent).toBe(
      named("execute_tool transfer_to_agent")[0],
    );
  });

  test("subagent final answer: the dropped re-narration still gets its call_llm", async () => {
    const researcher = new ExternalAgent({
      name: "researcher",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield { type: "output", content: "answer" };
      }),
    });
    const agent = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "researcher",
          task: "look",
        });
        yield { type: "output", content: "re-narration" };
      }),
      subAgents: [researcher],
    });
    const events = await runTurn(agent);

    expect(
      events.some((e) => e.content?.parts?.[0]?.text === "re-narration"),
    ).toBe(false);
    expect(
      named("call_llm").filter((s) => agentName(s) === "coordinator"),
    ).toHaveLength(2);
  });

  test("a built-in tool call after the delegation does not cancel the subagent final answer", async () => {
    const researcher = new ExternalAgent({
      name: "researcher",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* () {
        yield { type: "output", content: "answer" };
      }),
    });
    const agent = new ExternalAgent({
      name: "coordinator",
      provider: CODEX_PROVIDER,
      driver: new ScriptedDriver(async function* (request) {
        await request.toolGateway?.runSubAgent({
          agentName: "researcher",
          task: "look",
        });
        yield {
          type: "tool_call",
          name: "TodoWrite",
          callId: "t1",
          metadata: { builtin: true },
        };
        yield {
          type: "tool_result",
          name: "TodoWrite",
          callId: "t1",
          result: "ok",
          metadata: { builtin: true },
        };
        yield { type: "output", content: "re-narration" };
      }),
      subAgents: [researcher],
    });
    const events = await runTurn(agent);

    expect(
      events.some((e) => e.content?.parts?.[0]?.text === "re-narration"),
    ).toBe(false);
    const texts = events
      .map((e) => e.content?.parts?.[0]?.text)
      .filter((text): text is string => typeof text === "string");
    expect(texts.at(-1)).toBe("answer");
  });
});
