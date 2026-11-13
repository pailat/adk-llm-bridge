import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  MAX_IDENTIFIER_LENGTH,
  withStepSpan,
  withStepSpanStream,
  withWorkflowSpan,
} from "../../src/workflows/telemetry.js";

interface RecordedSpan {
  name: string;
  parent?: RecordedSpan;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
}

/** Installs a recording tracer plus an AsyncLocalStorage context manager. */
function installOtel() {
  const spans: RecordedSpan[] = [];
  const storage = new AsyncLocalStorage<Context>();
  const spanOf = new WeakMap<object, RecordedSpan>();

  context.disable();
  context.setGlobalContextManager({
    active: () => storage.getStore() ?? ROOT,
    with: (
      ctx: Context,
      fn: (...args: never[]) => unknown,
      thisArg?: unknown,
    ) => storage.run(ctx, () => fn.call(thisArg)),
    bind: <T>(_ctx: Context, target: T) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  } as never);

  trace.disable();
  trace.setGlobalTracerProvider({
    getTracer() {
      return {
        startSpan(name: string, _options?: unknown, ctx?: Context) {
          const parentApiSpan = trace.getSpan(ctx ?? context.active());
          const record: RecordedSpan = {
            name,
            parent: parentApiSpan ? spanOf.get(parentApiSpan) : undefined,
            attributes: {},
            ended: false,
          };
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
            spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
            isRecording: () => true,
            end() {
              record.ended = true;
            },
          };
          spanOf.set(span, record);
          return span as unknown as Span;
        },
      };
    },
  } as never);

  return spans;
}

// biome-ignore lint/suspicious/noExplicitAny: the root context is opaque
const ROOT = context.active() as any as Context;

function startChild(name: string): void {
  // Stand-in for ADK creating `invoke_agent` / `call_llm` under the step span.
  trace.getTracer("gcp.vertex.agent").startSpan(name).end();
}

let spans: RecordedSpan[];

beforeEach(() => {
  spans = installOtel();
});

afterEach(() => {
  trace.disable();
  context.disable();
});

function byName(name: string): RecordedSpan {
  const found = spans.find((s) => s.name === name);
  if (!found) throw new Error(`span not found: ${name}`);
  return found;
}

describe("withWorkflowSpan", () => {
  it("emits invoke_workflow <name> with ADK's attributes and ends the span", async () => {
    const result = await withWorkflowSpan(
      { workflowName: "build", nodePath: "root.build", sessionId: "s1" },
      async () => 42,
    );

    expect(result).toBe(42);
    const span = byName("invoke_workflow build");
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_workflow",
      "adk.workflow.name": "build",
      "adk.node.path": "root.build",
      "gen_ai.conversation.id": "s1",
    });
    expect(span.ended).toBe(true);
    expect(span.status).toBeUndefined();
  });

  it("marks failures with error.type and status ERROR, never the message", async () => {
    class BoomError extends Error {}
    const error = new BoomError("secret message");

    await expect(
      withWorkflowSpan({ workflowName: "w" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);

    const span = byName("invoke_workflow w");
    expect(span.attributes["error.type"]).toBe("Error");
    expect(span.status?.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span)).not.toContain("secret message");
    expect(span.ended).toBe(true);
  });

  it("uses the HTTP status as error.type for API errors", async () => {
    await expect(
      withWorkflowSpan({ workflowName: "w" }, () =>
        Promise.reject(Object.assign(new Error("x"), { status: 429 })),
      ),
    ).rejects.toThrow();

    expect(byName("invoke_workflow w").attributes["error.type"]).toBe("429");
  });

  it("does not mark an AbortError as failed", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });

    await expect(
      withWorkflowSpan({ workflowName: "w" }, () => Promise.reject(abort)),
    ).rejects.toBe(abort);

    const span = byName("invoke_workflow w");
    expect(span.status).toBeUndefined();
    expect(span.attributes["error.type"]).toBeUndefined();
  });
});

describe("withStepSpan", () => {
  it("emits execute_node <name> with ADK's attributes", async () => {
    await withStepSpan(
      { name: "lint", nodePath: "root.lint", runId: "r1", attempt: 2 },
      async () => "ok",
    );

    const span = byName("execute_node lint");
    expect(span.attributes).toMatchObject({
      "gen_ai.operation.name": "execute_node",
      "adk.node.path": "root.lint",
      "adk.node.run_id": "r1",
      "adk.node.attempt": 2,
      "adk.node.status": "completed",
      "adk.node.interrupt_count": 0,
    });
    expect(span.ended).toBe(true);
  });

  it("defaults the node path to the name and the attempt to 0", async () => {
    await withStepSpan({ name: "solo" }, async () => {});

    expect(byName("execute_node solo").attributes).toMatchObject({
      "adk.node.path": "solo",
      "adk.node.attempt": 0,
    });
  });

  it("nests spans created inside the step under it, and steps under the workflow", async () => {
    await withWorkflowSpan({ workflowName: "w" }, () =>
      withStepSpan({ name: "a" }, async () => {
        await Promise.resolve();
        startChild("invoke_agent coder");
      }),
    );

    const workflow = byName("invoke_workflow w");
    const step = byName("execute_node a");
    expect(step.parent).toBe(workflow);
    expect(byName("invoke_agent coder").parent).toBe(step);
  });

  it("makes concurrent steps scheduled from the same place siblings", async () => {
    await withWorkflowSpan({ workflowName: "w" }, () =>
      Promise.all([
        withStepSpan({ name: "a" }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          startChild("child-a");
        }),
        withStepSpan({ name: "b" }, async () => {
          startChild("child-b");
        }),
      ]),
    );

    const workflow = byName("invoke_workflow w");
    expect(byName("execute_node a").parent).toBe(workflow);
    expect(byName("execute_node b").parent).toBe(workflow);
    expect(byName("child-a").parent).toBe(byName("execute_node a"));
    expect(byName("child-b").parent).toBe(byName("execute_node b"));
  });

  it("records waiting steps without an error", async () => {
    await withStepSpan({ name: "approve" }, async (handle) => {
      handle.waiting(2);
    });

    const span = byName("execute_node approve");
    expect(span.attributes).toMatchObject({
      "adk.node.status": "waiting",
      "adk.node.interrupt_count": 2,
    });
    expect(span.status).toBeUndefined();
  });

  it("lets the work update attempt and interrupt count", async () => {
    await withStepSpan({ name: "retry" }, async (handle) => {
      handle.setAttempt(3);
      handle.setInterruptCount(1);
    });

    expect(byName("execute_node retry").attributes).toMatchObject({
      "adk.node.attempt": 3,
      "adk.node.interrupt_count": 1,
      "adk.node.status": "completed",
    });
  });

  it("marks a throwing step failed with error.type and status ERROR", async () => {
    await expect(
      withStepSpan({ name: "bad" }, async () => {
        throw new TypeError("private detail");
      }),
    ).rejects.toThrow("private detail");

    const span = byName("execute_node bad");
    expect(span.attributes).toMatchObject({
      "adk.node.status": "failed",
      "error.type": "TypeError",
    });
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR });
    expect(JSON.stringify(span)).not.toContain("private detail");
    expect(span.ended).toBe(true);
  });

  it("records an abort as failed without an error status", async () => {
    const abort = Object.assign(new Error("stop"), { name: "AbortError" });

    await expect(
      withStepSpan({ name: "cancelled" }, () => Promise.reject(abort)),
    ).rejects.toBe(abort);

    const span = byName("execute_node cancelled");
    expect(span.attributes["adk.node.status"]).toBe("failed");
    expect(span.status).toBeUndefined();
  });

  it("is a no-op without an OpenTelemetry SDK", async () => {
    trace.disable();
    context.disable();

    await expect(withStepSpan({ name: "x" }, async () => 7)).resolves.toBe(7);
    await expect(
      withWorkflowSpan({ workflowName: "x" }, async () => 8),
    ).resolves.toBe(8);
  });
});

describe("withStepSpanStream", () => {
  async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
  }

  it("keeps the span open across the iteration and nests children under it", async () => {
    const seen: boolean[] = [];
    const events = await collect(
      withStepSpanStream({ name: "stream" }, async function* () {
        seen.push(byName("execute_node stream").ended);
        yield 1;
        startChild("invoke_agent inner");
        seen.push(byName("execute_node stream").ended);
        yield 2;
      }),
    );

    expect(events).toEqual([1, 2]);
    expect(seen).toEqual([false, false]);
    const step = byName("execute_node stream");
    expect(step.ended).toBe(true);
    expect(step.attributes["adk.node.status"]).toBe("completed");
    expect(byName("invoke_agent inner").parent).toBe(step);
  });

  it("marks the step failed when the iteration throws", async () => {
    const run = collect(
      withStepSpanStream({ name: "s" }, async function* () {
        yield 1;
        throw new RangeError("nope");
      }),
    );

    await expect(run).rejects.toThrow("nope");
    const step = byName("execute_node s");
    expect(step.attributes).toMatchObject({
      "adk.node.status": "failed",
      "error.type": "RangeError",
    });
    expect(step.status?.code).toBe(SpanStatusCode.ERROR);
    expect(step.ended).toBe(true);
  });

  it("closes the inner iterator and ends the span when the consumer stops early", async () => {
    let innerClosed = false;
    const stream = withStepSpanStream({ name: "early" }, async function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        innerClosed = true;
      }
    });

    for await (const _ of stream) break;

    expect(innerClosed).toBe(true);
    const step = byName("execute_node early");
    expect(step.ended).toBe(true);
    expect(step.status).toBeUndefined();
    expect(step.attributes["adk.node.status"]).toBe("cancelled");
  });

  it("records an exhausted stream as completed", async () => {
    await collect(
      withStepSpanStream({ name: "full" }, async function* () {
        yield 1;
      }),
    );
    expect(byName("execute_node full").attributes["adk.node.status"]).toBe(
      "completed",
    );
  });

  it("keeps waiting for a waiting step whose consumer stops", async () => {
    const stream = withStepSpanStream(
      { name: "hitl-stop" },
      async function* (handle) {
        handle.waiting(1);
        yield "request-input";
        yield "never";
      },
    );
    for await (const _ of stream) break;
    expect(byName("execute_node hitl-stop").attributes["adk.node.status"]).toBe(
      "waiting",
    );
  });

  it("supports waiting via the handle", async () => {
    await collect(
      withStepSpanStream({ name: "hitl" }, async function* (handle) {
        handle.waiting(1);
        yield "request-input";
      }),
    );

    expect(byName("execute_node hitl").attributes).toMatchObject({
      "adk.node.status": "waiting",
      "adk.node.interrupt_count": 1,
    });
  });
});

describe("content never reaches spans", () => {
  const SECRET_INPUT = "SECRET-INPUT cat /etc/passwd";
  const SECRET_OUTPUT = "SECRET-OUTPUT api-key=abc123";
  const SECRET_ERROR = "SECRET-ERROR token=xyz";

  const settings: Array<[string, Record<string, string | undefined>]> = [
    [
      "NO_CONTENT",
      { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "NO_CONTENT" },
    ],
    [
      "EVENT_ONLY",
      { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "EVENT_ONLY" },
    ],
    ["ADK legacy off", { ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: "false" }],
    ["ADK legacy on", { ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: "true" }],
    ["no capture variable", {}],
    [
      "SPAN_AND_EVENT",
      { OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "SPAN_AND_EVENT" },
    ],
  ];
  const keys = [
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS",
  ];

  for (const [label, env] of settings) {
    it(`records only ids, paths and names with ${label}`, async () => {
      const saved = keys.map((k) => [k, process.env[k]] as const);
      for (const k of keys) delete process.env[k];
      for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) process.env[k] = v;
      }
      try {
        await withWorkflowSpan(
          { workflowName: "wf", nodePath: "wf", sessionId: "s1" },
          async () => {
            await withStepSpan({ name: "step-1" }, async () => SECRET_OUTPUT);
            await expect(
              withStepSpan({ name: "step-2" }, async () => {
                // The step input/output and the error message are user content.
                void SECRET_INPUT;
                throw new Error(SECRET_ERROR);
              }),
            ).rejects.toThrow();
            for await (const _ of withStepSpanStream(
              { name: "step-3" },
              async function* () {
                yield SECRET_OUTPUT;
              },
            )) {
              void _;
            }
          },
        );
      } finally {
        for (const [k, v] of saved) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }

      const dump = JSON.stringify(spans);
      for (const secret of [SECRET_INPUT, SECRET_OUTPUT, SECRET_ERROR]) {
        expect(dump).not.toContain(secret);
      }
      // Span names are exactly the ADK convention plus an identifier.
      expect(spans.map((s) => s.name)).toEqual([
        "invoke_workflow wf",
        "execute_node step-1",
        "execute_node step-2",
        "execute_node step-3",
      ]);
      // Every attribute key is an id/path/name/status/counter, no payload key.
      const allowed = new Set([
        "gen_ai.operation.name",
        "gen_ai.conversation.id",
        "adk.workflow.name",
        "adk.node.path",
        "adk.node.run_id",
        "adk.node.attempt",
        "adk.node.status",
        "adk.node.interrupt_count",
        "error.type",
      ]);
      for (const span of spans) {
        for (const key of Object.keys(span.attributes)) {
          expect(allowed.has(key)).toBe(true);
        }
        // The only status text is the error class name.
        if (span.status?.message !== undefined) {
          expect<unknown>(span.status.message).toBe(
            span.attributes["error.type"],
          );
        }
      }
    });
  }

  it("bounds free-form identifiers in span names and attributes", async () => {
    const long = `${"x".repeat(MAX_IDENTIFIER_LENGTH)}TAIL-SECRET`;

    await withWorkflowSpan({ workflowName: long, nodePath: long }, () =>
      withStepSpan({ name: long, nodePath: long, runId: long }, async () => {}),
    );

    const dump = JSON.stringify(spans);
    expect(dump).not.toContain("TAIL-SECRET");
    for (const span of spans) {
      expect(span.name.length).toBeLessThanOrEqual(
        "invoke_workflow ".length + MAX_IDENTIFIER_LENGTH,
      );
    }
    expect(
      byName(`execute_node ${"x".repeat(MAX_IDENTIFIER_LENGTH - 1)}…`),
    ).toBeDefined();
  });
});
