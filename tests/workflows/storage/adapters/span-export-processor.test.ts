import { describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import {
  BaseAgent,
  createEvent,
  InMemorySessionService,
  type InvocationContext,
  Runner,
} from "@google/adk";
import {
  type Context,
  type ContextManager,
  context,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { defineWorkflow } from "../../../../src/workflows/definition.js";
import { WorkflowEventExportPipeline } from "../../../../src/workflows/storage/event-export-pipeline.js";
import type { WorkflowEventRecord } from "../../../../src/workflows/storage/event-exporter.js";
import { InMemoryWorkflowEventExporter } from "../../../../src/workflows/storage/in-memory-event-exporter.js";
import {
  WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE,
  WORKFLOW_SPAN_EXPORT_DEFAULT_SCOPE,
  type WorkflowReadableSpanLike,
  WorkflowSpanExportProcessor,
  workflowEventRecordFromSpan,
} from "../../../../src/workflows/storage/span-export-processor.js";
import {
  setWorkflowExecutionIdOnActiveSpan,
  withWorkflowSpan,
} from "../../../../src/workflows/telemetry.js";
import { WorkflowAgent } from "../../../../src/workflows/workflow-agent.js";

interface SpanInit {
  name?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  start?: [number, number];
  end?: [number, number];
  attributes?: Record<string, unknown>;
  status?: { code: number; message?: string };
  scope?: string | null;
  sdk?: 1 | 2;
}

/** A hand-built span in the shape of the SDK's `ReadableSpan`. */
function makeSpan(init: SpanInit = {}): WorkflowReadableSpanLike & {
  attributes: Record<string, unknown>;
} {
  const traceId = init.traceId ?? "t".repeat(32);
  const spanId = init.spanId ?? "s".repeat(16);
  const scope = init.scope === undefined ? "gcp.vertex.agent" : init.scope;
  const sdk = init.sdk ?? 2;
  return {
    name: init.name ?? "invoke_agent a",
    spanContext: () => ({ traceId, spanId }),
    ...(init.parentSpanId !== undefined
      ? sdk === 2
        ? { parentSpanContext: { spanId: init.parentSpanId } }
        : { parentSpanId: init.parentSpanId }
      : {}),
    startTime: init.start ?? [1_700_000_000, 0],
    endTime: init.end ?? [1_700_000_001, 500_000_000],
    attributes: init.attributes ?? {},
    status: init.status ?? { code: 0 },
    ...(scope === null
      ? {}
      : sdk === 2
        ? { instrumentationScope: { name: scope } }
        : { instrumentationLibrary: { name: scope } }),
  };
}

function setup(
  options: { scopes?: readonly string[]; maxTrackedTraces?: number } = {},
) {
  const exporter = new InMemoryWorkflowEventExporter();
  const pipeline = new WorkflowEventExportPipeline({ exporter });
  const processor = new WorkflowSpanExportProcessor({ pipeline, ...options });
  return { exporter, pipeline, processor };
}

async function readAll(
  exporter: InMemoryWorkflowEventExporter,
  executionId: string,
): Promise<WorkflowEventRecord[]> {
  const records: WorkflowEventRecord[] = [];
  let after = 0;
  for (;;) {
    const page = await exporter.read({ executionId, afterSequence: after });
    records.push(...page.records);
    if (!page.hasMore) return records;
    after = page.nextAfterSequence;
  }
}

async function executionsOf(exporter: InMemoryWorkflowEventExporter) {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await exporter.listExecutions(cursor ? { cursor } : {});
    out.push(...page.items.map((item) => item.executionId));
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

describe("workflowEventRecordFromSpan", () => {
  test("builds a span record with the span id, trace, parent and end time", () => {
    const span = makeSpan({
      name: "call_llm",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      start: [1_700_000_000, 500_000_000],
      end: [1_700_000_002, 0],
    });

    const record = workflowEventRecordFromSpan(span);

    expect(record.id).toBe(`span:${"b".repeat(16)}`);
    expect(record.kind).toBe("span");
    expect(record.type).toBe("span");
    expect(record.traceId).toBe("a".repeat(32));
    expect(record.spanId).toBe("b".repeat(16));
    expect(record.parentSpanId).toBe("c".repeat(16));
    expect(record.timestamp).toBe(1_700_000_002_000);
    expect(record.payload.name).toBe("call_llm");
    const values = Object.values(record.payload);
    expect(values).toContain(1_700_000_000_500);
    expect(values).toContain(1_700_000_002_000);
    expect(values).toContain(1_500);
  });

  test("reads the parent from SDK 1.x spans too", () => {
    const record = workflowEventRecordFromSpan(
      makeSpan({ sdk: 1, parentSpanId: "d".repeat(16) }),
    );

    expect(record.parentSpanId).toBe("d".repeat(16));
  });

  test("picks the execution id: argument, then attribute, then the trace", () => {
    const traceId = "e".repeat(32);
    const withAttribute = makeSpan({
      traceId,
      attributes: { [WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]: "exec-attr" },
    });

    expect(
      workflowEventRecordFromSpan(withAttribute, "exec-arg").executionId,
    ).toBe("exec-arg");
    expect(workflowEventRecordFromSpan(withAttribute).executionId).toBe(
      "exec-attr",
    );
    expect(workflowEventRecordFromSpan(makeSpan({ traceId })).executionId).toBe(
      `trace:${traceId}`,
    );
  });

  test("keeps primitive and primitive-array attributes and drops other values", () => {
    const record = workflowEventRecordFromSpan(
      makeSpan({
        attributes: {
          str: "x",
          num: 3,
          bool: false,
          strings: ["a", "b"],
          numbers: [1, 2],
          bools: [true],
          object: { a: 1 },
          nested: [[1]],
          mixed: [{ a: 1 }],
          fn: () => 1,
          undef: undefined,
          nul: null,
          sym: Symbol("s"),
        },
      }),
    );

    const attributes = JSON.stringify(record.payload);
    expect(record.payload.attributes).toMatchObject({
      str: "x",
      num: 3,
      bool: false,
      strings: ["a", "b"],
      numbers: [1, 2],
      bools: [true],
    });
    const kept = record.payload.attributes as Record<string, unknown>;
    for (const dropped of ["object", "nested", "mixed", "fn", "undef", "sym"]) {
      expect(dropped in kept).toBe(false);
    }
    expect(() => JSON.stringify(record)).not.toThrow();
    expect(attributes).not.toContain('"a":1');
  });

  test("records the error status", () => {
    const record = workflowEventRecordFromSpan(
      makeSpan({ status: { code: 2, message: "tool failed" } }),
    );

    expect(JSON.stringify(record.payload)).toContain("tool failed");
  });
});

describe("WorkflowSpanExportProcessor", () => {
  test("exports spans of the default scope and skips other scopes", async () => {
    const { exporter, processor } = setup();
    const kept = makeSpan({ spanId: "1".repeat(16), traceId: "a".repeat(32) });
    const kept1x = makeSpan({
      spanId: "2".repeat(16),
      traceId: "a".repeat(32),
      sdk: 1,
    });
    const skipped = makeSpan({
      spanId: "3".repeat(16),
      traceId: "a".repeat(32),
      scope: "http",
    });
    const noScope = makeSpan({
      spanId: "4".repeat(16),
      traceId: "a".repeat(32),
      scope: null,
    });

    for (const span of [kept, kept1x, skipped, noScope]) processor.onEnd(span);
    await processor.forceFlush();

    expect(WORKFLOW_SPAN_EXPORT_DEFAULT_SCOPE).toBe("gcp.vertex.agent");
    const records = await readAll(exporter, `trace:${"a".repeat(32)}`);
    expect(records.map((record) => record.id)).toEqual([
      `span:${"1".repeat(16)}`,
      `span:${"2".repeat(16)}`,
    ]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
  });

  test("exports the scopes given in the options instead of the default", async () => {
    const { exporter, processor } = setup({ scopes: ["my.scope"] });
    const traceId = "b".repeat(32);

    processor.onEnd(makeSpan({ traceId, spanId: "1".repeat(16) }));
    processor.onEnd(
      makeSpan({ traceId, spanId: "2".repeat(16), scope: "my.scope" }),
    );
    await processor.forceFlush();

    expect(
      (await readAll(exporter, `trace:${traceId}`)).map((record) => record.id),
    ).toEqual([`span:${"2".repeat(16)}`]);
  });

  test("exports the spans of a workflow trace under the workflow execution id", async () => {
    const { exporter, processor } = setup();
    const traceId = "c".repeat(32);
    const workflow = makeSpan({
      name: "invoke_workflow wf",
      traceId,
      spanId: "1".repeat(16),
    });
    const child = makeSpan({
      name: "invoke_agent a",
      traceId,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
    });
    const grandchild = makeSpan({
      name: "call_llm",
      traceId,
      spanId: "3".repeat(16),
      parentSpanId: "2".repeat(16),
    });

    processor.onStart(workflow);
    // The runtime names the execution after the span started.
    workflow.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-1";
    processor.onStart(child);
    processor.onStart(grandchild);
    processor.onEnd(grandchild);
    processor.onEnd(child);
    processor.onEnd(workflow);
    await processor.forceFlush();

    const records = await readAll(exporter, "exec-1");
    expect(records.map((record) => record.id)).toEqual([
      `span:${"3".repeat(16)}`,
      `span:${"2".repeat(16)}`,
      `span:${"1".repeat(16)}`,
    ]);
    expect(await executionsOf(exporter)).toEqual(["exec-1"]);
  });

  test("keeps a workflow nested in a step of another workflow under its own execution", async () => {
    const { exporter, processor } = setup();
    const traceId = "d".repeat(32);
    const id = (n: number) => String(n).repeat(16);
    const outer = makeSpan({
      name: "invoke_workflow outer",
      traceId,
      spanId: id(1),
    });
    const step = makeSpan({
      name: "execute_node s1",
      traceId,
      spanId: id(2),
      parentSpanId: id(1),
    });
    const inner = makeSpan({
      name: "invoke_workflow inner",
      traceId,
      spanId: id(3),
      parentSpanId: id(2),
    });
    const innerStep = makeSpan({
      name: "execute_node t1",
      traceId,
      spanId: id(4),
      parentSpanId: id(3),
    });
    const innerAgent = makeSpan({
      name: "invoke_agent a",
      traceId,
      spanId: id(5),
      parentSpanId: id(4),
    });
    const laterStep = makeSpan({
      name: "execute_node s2",
      traceId,
      spanId: id(6),
      parentSpanId: id(1),
    });

    processor.onStart(outer);
    outer.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-outer";
    processor.onStart(step);
    processor.onStart(inner);
    inner.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-inner";
    processor.onStart(innerStep);
    processor.onStart(innerAgent);
    processor.onEnd(innerAgent);
    processor.onEnd(innerStep);
    processor.onEnd(inner);
    processor.onEnd(step);
    processor.onStart(laterStep);
    processor.onEnd(laterStep);
    // A span of the trace whose parent was never seen belongs to the outer one.
    const orphan = makeSpan({
      name: "call_llm",
      traceId,
      spanId: id(7),
      parentSpanId: id(9),
    });
    processor.onEnd(orphan);
    processor.onEnd(outer);
    await processor.forceFlush();

    const ids = async (execution: string) =>
      (await readAll(exporter, execution)).map((record) => record.spanId);
    expect(await ids("exec-inner")).toEqual([id(5), id(4), id(3)]);
    expect(await ids("exec-outer")).toEqual([id(2), id(6), id(7), id(1)]);
    expect(await executionsOf(exporter)).toHaveLength(2);
  });

  test("keeps a step span that ends after its workflow span under that workflow", async () => {
    const { exporter, processor } = setup();
    const traceId = "1".repeat(32);
    const id = (n: number) => String(n).repeat(16);
    const outer = makeSpan({
      name: "invoke_workflow outer",
      traceId,
      spanId: id(1),
    });
    const outerStep = makeSpan({
      name: "execute_node o",
      traceId,
      spanId: id(4),
      parentSpanId: id(1),
    });
    const inner = makeSpan({
      name: "invoke_workflow inner",
      traceId,
      spanId: id(2),
      parentSpanId: id(1),
    });
    const step = makeSpan({
      name: "execute_node s",
      traceId,
      spanId: id(3),
      parentSpanId: id(2),
    });

    processor.onStart(outer);
    outer.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-outer";
    processor.onStart(outerStep);
    processor.onStart(inner);
    inner.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-inner";
    processor.onStart(step);
    processor.onEnd(inner);
    processor.onEnd(step);
    processor.onEnd(outerStep);
    processor.onEnd(outer);
    await processor.forceFlush();

    expect(
      (await readAll(exporter, "exec-inner")).map((r) => r.spanId),
    ).toEqual([id(2), id(3)]);
    expect(
      (await readAll(exporter, "exec-outer")).map((r) => r.spanId),
    ).toEqual([id(4), id(1)]);
  });

  test("resolves spans that started before the execution id was set through their ancestors", async () => {
    const { exporter, processor } = setup();
    const traceId = "2".repeat(32);
    const workflow = makeSpan({
      name: "invoke_workflow wf",
      traceId,
      spanId: "a".repeat(16),
    });
    const child = makeSpan({
      name: "execute_node s",
      traceId,
      spanId: "b".repeat(16),
      parentSpanId: "a".repeat(16),
    });
    const grandchild = makeSpan({
      name: "call_llm",
      traceId,
      spanId: "c".repeat(16),
      parentSpanId: "b".repeat(16),
    });

    processor.onStart(workflow);
    processor.onStart(child);
    processor.onStart(grandchild);
    workflow.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-late";
    processor.onEnd(grandchild);
    processor.onEnd(child);
    processor.onEnd(workflow);
    await processor.forceFlush();

    expect(await executionsOf(exporter)).toEqual(["exec-late"]);
    expect(await readAll(exporter, "exec-late")).toHaveLength(3);
  });

  test("keeps spans that started inside a nested workflow before its execution id was set under the nested execution", async () => {
    const { exporter, processor } = setup();
    const traceId = "7".repeat(32);
    const outer = makeSpan({
      name: "invoke_workflow outer",
      traceId,
      spanId: "1".repeat(16),
      attributes: { [WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]: "exec-outer" },
    });
    const outerStep = makeSpan({
      name: "execute_node run_inner",
      traceId,
      spanId: "2".repeat(16),
      parentSpanId: "1".repeat(16),
    });
    const inner = makeSpan({
      name: "invoke_workflow inner",
      traceId,
      spanId: "3".repeat(16),
      parentSpanId: "2".repeat(16),
    });
    const innerStep = makeSpan({
      name: "execute_node s",
      traceId,
      spanId: "4".repeat(16),
      parentSpanId: "3".repeat(16),
    });
    const innerCall = makeSpan({
      name: "call_llm",
      traceId,
      spanId: "5".repeat(16),
      parentSpanId: "4".repeat(16),
    });

    processor.onStart(outer);
    processor.onStart(outerStep);
    processor.onStart(inner);
    // Both start while the nested workflow has no execution id yet.
    processor.onStart(innerStep);
    processor.onStart(innerCall);
    inner.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE] = "exec-inner";
    processor.onEnd(innerCall);
    processor.onEnd(innerStep);
    processor.onEnd(inner);
    processor.onEnd(outerStep);
    processor.onEnd(outer);
    await processor.forceFlush();

    const names = async (executionId: string) =>
      (await readAll(exporter, executionId)).map(
        (record) => (record.payload as { name?: string }).name,
      );
    expect(await names("exec-inner")).toEqual([
      "call_llm",
      "execute_node s",
      "invoke_workflow inner",
    ]);
    expect(await names("exec-outer")).toEqual([
      "execute_node run_inner",
      "invoke_workflow outer",
    ]);
  });

  test("returns from spans whose parents form a cycle", async () => {
    const { exporter, processor } = setup();
    const traceId = "3".repeat(32);
    const a = makeSpan({
      traceId,
      spanId: "a".repeat(16),
      parentSpanId: "b".repeat(16),
    });
    const b = makeSpan({
      traceId,
      spanId: "b".repeat(16),
      parentSpanId: "a".repeat(16),
    });
    const self = makeSpan({
      traceId,
      spanId: "c".repeat(16),
      parentSpanId: "c".repeat(16),
    });

    for (const span of [a, b, self]) processor.onStart(span);
    for (const span of [a, b, self]) processor.onEnd(span);
    await processor.forceFlush();

    expect(await readAll(exporter, `trace:${traceId}`)).toHaveLength(3);
  });

  test("a cycle in the span ancestry ends within a time limit (checked in a child process, so an endless climb fails instead of hanging the run)", () => {
    // An endless climb is a synchronous loop that no test timeout can stop;
    // a child process with a time limit turns it into a failure.
    const source = new URL(
      "../../../../src/workflows/storage/",
      import.meta.url,
    );
    const script = `
const { WorkflowEventExportPipeline } = await import(${JSON.stringify(fileURLToPath(new URL("event-export-pipeline.ts", source)))});
const { InMemoryWorkflowEventExporter } = await import(${JSON.stringify(fileURLToPath(new URL("in-memory-event-exporter.ts", source)))});
const { WorkflowSpanExportProcessor } = await import(${JSON.stringify(fileURLToPath(new URL("span-export-processor.ts", source)))});
const pipeline = new WorkflowEventExportPipeline({ exporter: new InMemoryWorkflowEventExporter() });
const processor = new WorkflowSpanExportProcessor({ pipeline });
const span = (spanId, parent) => ({
  name: "call_llm",
  spanContext: () => ({ traceId: "9".repeat(32), spanId }),
  parentSpanContext: { spanId: parent },
  startTime: [1, 0],
  endTime: [2, 0],
  attributes: {},
  status: { code: 0 },
  instrumentationScope: { name: "gcp.vertex.agent" },
});
const spans = [span("a".repeat(16), "b".repeat(16)), span("b".repeat(16), "a".repeat(16)), span("c".repeat(16), "c".repeat(16))];
for (const s of spans) processor.onStart(s);
for (const s of spans) processor.onEnd(s);
await pipeline.close(1000);
console.log("returned");
`;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    expect({
      timedOut: result.exitedDueToTimeout === true,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }).toEqual({ timedOut: false, stdout: "returned\n", stderr: "" });
  }, 20_000);

  test("keeps traces apart", async () => {
    const { exporter, processor } = setup();
    const first = makeSpan({
      traceId: "1".repeat(32),
      spanId: "a".repeat(16),
      attributes: { [WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]: "exec-a" },
    });
    const second = makeSpan({
      traceId: "2".repeat(32),
      spanId: "b".repeat(16),
      attributes: { [WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]: "exec-b" },
    });
    const other = makeSpan({ traceId: "3".repeat(32), spanId: "c".repeat(16) });

    for (const span of [first, second, other]) processor.onStart(span);
    for (const span of [first, second, other]) processor.onEnd(span);
    await processor.forceFlush();

    expect((await executionsOf(exporter)).sort()).toEqual(
      ["exec-a", "exec-b", `trace:${"3".repeat(32)}`].sort(),
    );
  });

  test("remembers at most maxTrackedTraces traces, dropping the oldest", async () => {
    const { exporter, processor } = setup({ maxTrackedTraces: 2 });
    const traces = [1, 2, 3].map((n) => String(n).repeat(32));
    for (const [index, traceId] of traces.entries()) {
      processor.onStart(
        makeSpan({
          traceId,
          spanId: String(index + 1).repeat(16),
          attributes: {
            [WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]: `exec-${index + 1}`,
          },
        }),
      );
    }

    for (const [index, traceId] of traces.entries()) {
      processor.onEnd(
        makeSpan({ traceId, spanId: String(index + 4).repeat(16) }),
      );
    }
    await processor.forceFlush();

    expect((await executionsOf(exporter)).sort()).toEqual(
      [`trace:${traces[0]}`, "exec-2", "exec-3"].sort(),
    );
  });

  test("never throws, whatever it is given", async () => {
    const { processor } = setup();
    const hostile = {
      name: "x",
      spanContext() {
        throw new Error("no context");
      },
      get attributes(): never {
        throw new Error("no attributes");
      },
    } as unknown as WorkflowReadableSpanLike;
    const inputs: unknown[] = [
      null,
      undefined,
      42,
      "span",
      {},
      { spanContext: () => null },
      { name: "x", spanContext: () => ({ traceId: 1, spanId: 2 }) },
      hostile,
    ];

    for (const input of inputs) {
      expect(() => processor.onStart(input)).not.toThrow();
      expect(() =>
        processor.onEnd(input as WorkflowReadableSpanLike),
      ).not.toThrow();
    }
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  test("never throws when the pipeline throws or rejects", async () => {
    const pipeline = {
      offer() {
        throw new Error("offer broke");
      },
      offerAdkEvent() {
        throw new Error("offer broke");
      },
      flush: () => Promise.reject(new Error("flush broke")),
      close: () => Promise.reject(new Error("close broke")),
    } as unknown as WorkflowEventExportPipeline;
    const processor = new WorkflowSpanExportProcessor({ pipeline });
    const span = makeSpan();

    expect(() => processor.onStart(span)).not.toThrow();
    expect(() => processor.onEnd(span)).not.toThrow();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  test("shutdown flushes and leaves the pipeline open", async () => {
    const { exporter, pipeline, processor } = setup();
    const traceId = "d".repeat(32);
    processor.onEnd(makeSpan({ traceId, spanId: "1".repeat(16) }));

    await processor.shutdown();

    expect(await readAll(exporter, `trace:${traceId}`)).toHaveLength(1);
    expect(
      pipeline.offer({
        id: "after-shutdown",
        executionId: "exec-x",
        kind: "agent_run",
        type: "adk_event",
        timestamp: 1,
        payload: {},
      }),
    ).toBe(true);
  });

  test("keeps the shape of the SDK span processor", () => {
    const { processor } = setup();
    // Compile-time check: the processor stays assignable to this shape.
    const asSdkShape: {
      onStart(span: never, parentContext: never): void;
      onEnd(span: WorkflowReadableSpanLike): void;
      forceFlush(): Promise<void>;
      shutdown(): Promise<void>;
    } = processor;
    expect(asSdkShape).toBe(processor);

    expect(typeof processor.onStart).toBe("function");
    expect(typeof processor.onEnd).toBe("function");
    expect(typeof processor.forceFlush).toBe("function");
    expect(typeof processor.shutdown).toBe("function");
  });
});

/** Loads the tracer SDK when it resolves; the package does not depend on it. */
async function loadSdk(): Promise<
  | {
      BasicTracerProvider: new (options: {
        spanProcessors: unknown[];
      }) => {
        forceFlush(): Promise<void>;
        shutdown(): Promise<void>;
      } & Record<string, unknown>;
    }
  | undefined
> {
  try {
    return (await import("@opentelemetry/sdk-trace-base")) as never;
  } catch {
    return undefined;
  }
}

const sdk = await loadSdk();

/** Minimal context manager: spans only nest when a manager is registered. */
class LocalContextManager implements ContextManager {
  readonly #storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.#storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.#storage.run(ctx, () => fn.call(thisArg, ...args));
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

class EchoAgent extends BaseAgent {
  constructor() {
    super({ name: "echo" });
  }

  protected async *runAsyncImpl(invocation: InvocationContext) {
    yield createEvent({
      invocationId: invocation.invocationId,
      author: this.name,
      content: { role: "model", parts: [{ text: "ok" }] },
    });
  }

  protected async *runLiveImpl() {}
}

describe.skipIf(sdk === undefined)("with a real tracer provider", () => {
  test("exports the spans of a workflow run under the workflow execution id", async () => {
    const { exporter, pipeline, processor } = setup();
    const captured: Array<{
      traceId: string;
      name: string;
      attributes: Record<string, unknown>;
    }> = [];
    const provider = new (sdk as NonNullable<typeof sdk>).BasicTracerProvider({
      spanProcessors: [
        processor,
        {
          onStart() {},
          onEnd(span: WorkflowReadableSpanLike) {
            captured.push({
              traceId: span.spanContext().traceId,
              name: span.name,
              attributes: { ...span.attributes },
            });
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        },
      ],
    });
    context.setGlobalContextManager(new LocalContextManager());
    trace.setGlobalTracerProvider(provider as never);
    try {
      const workflow = new WorkflowAgent({
        name: "wf",
        subAgents: [new EchoAgent()],
        definition: defineWorkflow({
          id: "traced",
          version: "1",
          handler: async (ctx) => {
            const result = await ctx.run({
              id: "echo",
              agentName: "echo",
              input: ctx.inputText,
            });
            return result.output;
          },
        }),
      });
      const sessions = new InMemorySessionService();
      const runner = new Runner({
        appName: "app",
        agent: workflow,
        sessionService: sessions,
      });
      const { id } = await sessions.createSession({
        appName: "app",
        userId: "u",
      });
      for await (const _event of runner.runAsync({
        userId: "u",
        sessionId: id,
        newMessage: { role: "user", parts: [{ text: "go" }] },
      })) {
        // drain
      }
      await provider.forceFlush();
      await pipeline.flush();

      const workflowSpan = captured.find((span) =>
        span.name.startsWith("invoke_workflow"),
      );
      const executionId =
        workflowSpan?.attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE];
      expect(typeof executionId).toBe("string");
      const records = (await readAll(exporter, executionId as string)).filter(
        (record) => record.kind === "span",
      );
      // ADK's own runner spans start in other traces; only the spans of the
      // workflow trace belong to the execution.
      const inTrace = captured.filter(
        (span) => span.traceId === workflowSpan?.traceId,
      );
      expect(inTrace.length).toBeGreaterThan(1);
      expect(records.length).toBe(inTrace.length);
      expect(records.map((record) => record.payload.name).sort()).toEqual(
        inTrace.map((span) => span.name).sort(),
      );
      const others = (await executionsOf(exporter)).filter(
        (id) => id !== executionId,
      );
      expect(others.every((id) => id.startsWith("trace:"))).toBe(true);
    } finally {
      trace.disable();
      context.disable();
    }
  });
});

describe("the execution id attribute of the invoke_workflow span", () => {
  test("is written exactly as given, even past 128 characters", async () => {
    const attributes: Record<string, unknown> = {};
    const span = {
      setAttributes: (values: Record<string, unknown>) =>
        Object.assign(attributes, values),
      setAttribute: (key: string, value: unknown) => {
        attributes[key] = value;
      },
      setStatus() {},
      end() {},
      spanContext: () => ({ traceId: "f".repeat(32), spanId: "f".repeat(16) }),
      isRecording: () => true,
    };
    const manager = new LocalContextManager();
    context.setGlobalContextManager(manager);
    trace.setGlobalTracerProvider({
      getTracer: () => ({ startSpan: () => span, startActiveSpan: () => span }),
    } as never);
    try {
      const longId = `exec-${"x".repeat(200)}`;
      await withWorkflowSpan({ workflowName: "wf" }, async () => {
        setWorkflowExecutionIdOnActiveSpan(longId);
      });

      expect(attributes[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE]).toBe(longId);
    } finally {
      trace.disable();
      context.disable();
    }
  });
});
