import type { WorkflowEventExportPipeline } from "./event-export-pipeline.js";
import type { WorkflowEventRecordInput } from "./event-exporter.js";
import type { WorkflowStorageJsonObject } from "./support.js";

/**
 * Span attribute that carries the workflow execution id. The workflow
 * runtime sets it on its `invoke_workflow` span; spans of the same trace are
 * exported under that execution.
 */
export const WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE =
  "adk_llm_bridge.workflow.execution_id";

/** Instrumentation scope of the spans ADK and this package create. */
export const WORKFLOW_SPAN_EXPORT_DEFAULT_SCOPE = "gcp.vertex.agent";

/**
 * The fields of an OpenTelemetry `ReadableSpan` the processor reads.
 * `ReadableSpan` of `@opentelemetry/sdk-trace-base` 1.x and 2.x is assignable
 * to it, so this package needs no dependency on the SDK.
 *
 * @experimental
 */
export interface WorkflowReadableSpanLike {
  /** Span name. */
  readonly name: string;
  /** Returns the trace id and span id. */
  spanContext(): { traceId: string; spanId: string };
  /** Parent span context (SDK 2.x). */
  readonly parentSpanContext?: { spanId: string };
  /** Parent span id (SDK 1.x). */
  readonly parentSpanId?: string;
  /** Start time as `[seconds, nanoseconds]`. */
  readonly startTime: readonly [number, number];
  /** End time as `[seconds, nanoseconds]`. */
  readonly endTime: readonly [number, number];
  /** Span attributes. */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** Span status; code `2` is an error. */
  readonly status: { code: number; message?: string };
  /** Instrumentation scope (SDK 2.x). */
  readonly instrumentationScope?: { name: string };
  /** Instrumentation scope (SDK 1.x). */
  readonly instrumentationLibrary?: { name: string };
}

/**
 * Options of {@link WorkflowSpanExportProcessor}.
 *
 * @experimental
 */
export interface WorkflowSpanExportProcessorOptions {
  /** Pipeline to feed; usually the one of the `WorkflowEventExportPlugin`. */
  pipeline: WorkflowEventExportPipeline;
  /**
   * Instrumentation scopes whose spans are exported.
   *
   * @defaultValue `["gcp.vertex.agent"]`
   */
  scopes?: readonly string[];
  /**
   * Largest number of trace-to-execution associations remembered.
   *
   * @defaultValue 10000
   */
  maxTrackedTraces?: number;
}

/**
 * Turns a finished span into a record of kind `span`.
 *
 * @remarks
 * The payload holds the span name, start and end time in epoch milliseconds,
 * the duration, the status and the attributes with primitive or
 * primitive-array values. The record id is `span:` plus the span id. The
 * execution id is `executionId` when given, else the value of the
 * {@link WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE} attribute, else `trace:` plus
 * the trace id.
 *
 * @param span - The finished span.
 * @param executionId - Execution the span belongs to, when known.
 * @returns The record, not clipped.
 *
 * @experimental
 */
export function workflowEventRecordFromSpan(
  span: WorkflowReadableSpanLike,
  executionId?: string,
): WorkflowEventRecordInput {
  const { traceId, spanId } = span.spanContext();
  const startMs = timeToMillis(span.startTime);
  const endMs = timeToMillis(span.endTime);
  const parentSpanId =
    span.parentSpanContext?.spanId ?? span.parentSpanId ?? undefined;
  const fromAttribute = span.attributes?.[WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE];
  const resolved =
    executionId ??
    (typeof fromAttribute === "string" && fromAttribute !== ""
      ? fromAttribute
      : `trace:${traceId}`);
  const message = span.status?.message;
  const status: WorkflowStorageJsonObject = {
    code: finiteOr(span.status?.code, 0),
    ...(typeof message === "string" && message !== "" ? { message } : {}),
  };
  return {
    id: `span:${spanId}`,
    executionId: resolved,
    kind: "span",
    type: "span",
    timestamp: endMs,
    traceId,
    spanId,
    ...(typeof parentSpanId === "string" && parentSpanId !== ""
      ? { parentSpanId }
      : {}),
    payload: {
      name: String(span.name),
      startTimeMs: startMs,
      endTimeMs: endMs,
      durationMs: Math.max(0, endMs - startMs),
      status,
      attributes: primitiveAttributes(span.attributes),
    },
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Converts an OpenTelemetry `[seconds, nanoseconds]` time to epoch ms. */
function timeToMillis(time: readonly [number, number] | undefined): number {
  if (!Array.isArray(time)) return 0;
  return Math.round(finiteOr(time[0], 0) * 1000 + finiteOr(time[1], 0) / 1e6);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Keeps primitive values and arrays of primitives; drops everything else. */
function primitiveAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): WorkflowStorageJsonObject {
  const out: Record<
    string,
    string | number | boolean | Array<string | number | boolean>
  > = {};
  if (typeof attributes !== "object" || attributes === null) return out;
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (isPrimitive(value)) out[key] = value;
    else if (Array.isArray(value) && value.every(isPrimitive)) {
      out[key] = [...value];
    }
  }
  return out;
}

function scopeName(span: WorkflowReadableSpanLike): string | undefined {
  const name =
    span.instrumentationScope?.name ?? span.instrumentationLibrary?.name;
  return typeof name === "string" ? name : undefined;
}

const DEFAULT_MAX_TRACKED_TRACES = 10_000;
const FLUSH_TIMEOUT_MS = 5000;

interface TrackedSpan {
  executionId?: string;
  /** Live `invoke_workflow` span whose attribute is set after it starts. */
  live?: WorkflowReadableSpanLike;
  parentSpanId?: string;
  traceId: string;
}

/** Deepest span ancestry followed when looking for an execution. */
const MAX_ANCESTRY_DEPTH = 64;

function parentOf(span: WorkflowReadableSpanLike): string | undefined {
  const id = span.parentSpanContext?.spanId ?? span.parentSpanId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Inserts into a map as the newest entry and evicts the oldest over `max`. */
function remember<V>(map: Map<string, V>, key: string, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function executionIdOf(span: unknown): string | undefined {
  const value = (span as WorkflowReadableSpanLike | undefined)?.attributes?.[
    WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE
  ];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * OpenTelemetry span processor that exports the spans ADK and this package
 * create (`invoke_workflow`, the step spans, `invoke_agent`, `call_llm`,
 * `execute_tool`) as records of kind `span`, through the same pipeline as the
 * events.
 *
 * @remarks
 * It has the shape of the SDK's `SpanProcessor`. Register it where the host
 * builds its tracer provider, or through ADK:
 * `maybeSetOtelProviders([{ spanProcessors: [processor] }])`. It only reads
 * spans, never throws, and adds nothing when no tracer provider is
 * registered.
 *
 * @experimental
 */
export class WorkflowSpanExportProcessor {
  /** The pipeline this processor feeds. */
  readonly pipeline: WorkflowEventExportPipeline;
  readonly #scopes: ReadonlySet<string>;
  readonly #maxTrackedTraces: number;
  /**
   * Open spans by span id: the execution each one belongs to. Entries are
   * removed when the span ends; the table reuses `maxTrackedTraces` as its
   * bound.
   */
  readonly #spans = new Map<string, TrackedSpan>();
  /** First execution seen per trace, for spans whose ancestry is unknown. */
  readonly #traces = new Map<string, string>();

  /**
   * Creates the processor.
   *
   * @param options - Pipeline, scopes and the size of the trace table.
   */
  constructor(options: WorkflowSpanExportProcessorOptions) {
    this.pipeline = options.pipeline;
    this.#scopes = new Set(
      options.scopes ?? [WORKFLOW_SPAN_EXPORT_DEFAULT_SCOPE],
    );
    const max = options.maxTrackedTraces;
    this.#maxTrackedTraces =
      typeof max === "number" && Number.isInteger(max) && max >= 1
        ? max
        : DEFAULT_MAX_TRACKED_TRACES;
  }

  /** Execution of a started span: its own, else its nearest ancestor's. */
  #lookup(spanId: string | undefined): string | undefined {
    let id = spanId;
    for (
      let depth = 0;
      id !== undefined && depth < MAX_ANCESTRY_DEPTH;
      depth++
    ) {
      const entry = this.#spans.get(id);
      if (entry === undefined) return undefined;
      if (entry.executionId === undefined && entry.live !== undefined) {
        const late = executionIdOf(entry.live);
        if (late !== undefined) {
          entry.executionId = late;
          entry.live = undefined;
          // Workflows resolve outermost first, so this is the trace's outer one.
          this.#rememberTrace(entry.traceId, late);
        }
      }
      if (entry.executionId !== undefined) return entry.executionId;
      id = entry.parentSpanId;
    }
    return undefined;
  }

  #rememberTrace(traceId: string, executionId: string): void {
    if (this.#traces.has(traceId)) return;
    remember(this.#traces, traceId, executionId, this.#maxTrackedTraces);
  }

  /**
   * Remembers the execution a started span belongs to: its own, or the one
   * of its parent span, so a workflow nested in a step of another workflow
   * keeps its own execution.
   *
   * @param span - The started span.
   * @param parentContext - The parent OpenTelemetry context; not used.
   */
  onStart(span: unknown, parentContext?: unknown): void {
    void parentContext;
    try {
      const live = span as WorkflowReadableSpanLike;
      const { traceId, spanId } = live.spanContext();
      const parentSpanId = parentOf(live);
      const own = executionIdOf(live);
      const entry: TrackedSpan = {
        traceId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      };
      if (own !== undefined) entry.executionId = own;
      else if (
        typeof live.name === "string" &&
        live.name.startsWith("invoke_workflow")
      ) {
        // The runtime names the execution after the span started: read the
        // attribute from the live span later.
        entry.live = live;
      } else {
        const inherited = this.#lookup(parentSpanId);
        if (inherited !== undefined) entry.executionId = inherited;
      }
      remember(this.#spans, spanId, entry, this.#maxTrackedTraces);
      if (own !== undefined) this.#rememberTrace(traceId, own);
    } catch {
      // A span processor never throws into the tracer.
    }
  }

  /**
   * Queues the record of a finished span.
   *
   * @param span - The finished span.
   */
  onEnd(span: WorkflowReadableSpanLike): void {
    try {
      const { traceId, spanId } = span.spanContext();
      const known = this.#lookup(spanId);
      this.#spans.delete(spanId);
      const scope = scopeName(span);
      if (scope === undefined || !this.#scopes.has(scope)) return;
      const own = executionIdOf(span);
      const executionId =
        own ??
        known ??
        this.#lookup(parentOf(span)) ??
        this.#traces.get(traceId);
      if (own !== undefined) this.#rememberTrace(traceId, own);
      this.pipeline.offer(workflowEventRecordFromSpan(span, executionId));
    } catch {
      // A span processor never throws into the tracer.
    }
  }

  /** Waits for the buffered records, for at most 5 seconds. */
  async forceFlush(): Promise<void> {
    try {
      await this.pipeline.flush(FLUSH_TIMEOUT_MS);
    } catch {
      // Flushing never fails the tracer provider.
    }
  }

  /** Flushes; the pipeline and the exporter stay open for the plugin. */
  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}
