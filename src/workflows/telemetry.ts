/**
 * OpenTelemetry spans for workflow runs, following ADK 2.4's conventions.
 *
 * ADK's own `Workflow` emits `invoke_workflow <name>` and `execute_node <name>`
 * spans (`telemetry/tracing.ts`: `traceWorkflowInvocation`,
 * `traceNodeExecution`; `workflow/node_runner.ts`). Those helpers are not part
 * of the public API, so this module reproduces the span names and attribute
 * keys for our workflow runtime, using only `@opentelemetry/api`:
 *
 * - `invoke_workflow <workflowName>`: `gen_ai.operation.name=invoke_workflow`,
 *   `gen_ai.conversation.id`, `adk.workflow.name`, `adk.node.path`.
 * - `adk_llm_bridge.workflow.execution_id` is also set on the
 *   `invoke_workflow` span once the execution id is resolved, exactly as
 *   given (never shortened), so a span processor can join the spans of a
 *   trace to the workflow's events.
 * - `execute_node <name>`: `gen_ai.operation.name=execute_node`,
 *   `adk.node.path`, `adk.node.run_id`, `adk.node.attempt`, `adk.node.status`
 *   (`completed` | `waiting` | `failed`, and `cancelled` for an abandoned
 *   event stream), `adk.node.interrupt_count`.
 *
 * Spans use the same tracer name as ADK (`gcp.vertex.agent`) and run the
 * wrapped work inside the span's context, so spans created by ADK underneath
 * (`invoke_agent`, the model-call span `call_llm` / ADK 2.5
 * `generate_content {model}`, `execute_tool`) nest under the step span.
 *
 * Nothing sensitive is recorded: names, paths, ids and counts only, never node
 * input/output or error messages, in span names as much as in attributes. These
 * spans therefore carry no message content under any capture setting
 * (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=NO_CONTENT`,
 * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`, ...), and the capture variables
 * have nothing to gate here. Callers must pass identifiers (workflow and step
 * ids), never user text; as a safety net every identifier is bounded to
 * {@link MAX_IDENTIFIER_LENGTH} characters so free-form text cannot ride along
 * in a span name. Failures set `error.type` (the error class name, or `status`
 * of an API error) and the span status `ERROR`, whose message is only that
 * type, never the error message. Everything is a no-op without an
 * OpenTelemetry SDK.
 */

import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

import { WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE } from "./storage/span-export-processor.js";

const TRACER_NAME = "gcp.vertex.agent";
const TRACER_VERSION = "adk-llm-bridge";

/**
 * Outcome of one workflow step, as ADK reports it in `adk.node.status`
 * (`cancelled` is ADK's `NodeStatus.CANCELLED`: a step whose event stream
 * was abandoned before it ended).
 *
 * @internal
 */
export type WorkflowStepStatus =
  | "completed"
  | "waiting"
  | "failed"
  | "cancelled";

/**
 * Identifies a workflow run for {@link withWorkflowSpan}.
 *
 * @internal
 */
export interface WorkflowSpanMeta {
  /** Workflow name; used in the span name and `adk.workflow.name`. */
  workflowName: string;
  /** Path of the workflow node (empty for a root workflow). */
  nodePath?: string;
  /** Session id, recorded as `gen_ai.conversation.id`. */
  sessionId?: string;
}

/**
 * Identifies a workflow step for {@link withStepSpan}.
 *
 * @internal
 */
export interface WorkflowStepSpanMeta {
  /** Step/node name; used in the span name, like ADK's `execute_node <name>`. */
  name: string;
  /** Full node path (`adk.node.path`). Defaults to `name`. */
  nodePath?: string;
  /** Run id of the node execution (`adk.node.run_id`). */
  runId?: string;
  /** Attempt number, starting at 0 (`adk.node.attempt`). Defaults to 0. */
  attempt?: number;
}

/**
 * Lets the wrapped work refine what is recorded on its step span.
 *
 * @internal
 */
export interface WorkflowStepSpanHandle {
  /** The underlying span, for extra attributes. */
  readonly span: Span;
  /** Marks the step as waiting on input (HITL); the span is not an error. */
  waiting(interruptCount?: number): void;
  /** Updates the attempt number (for example before a retry). */
  setAttempt(attempt: number): void;
  /** Updates the number of pending interrupts. */
  setInterruptCount(count: number): void;
}

/**
 * Longest identifier written to a span name or attribute.
 *
 * @internal
 */
export const MAX_IDENTIFIER_LENGTH = 128;

function ident(value: string): string {
  return value.length > MAX_IDENTIFIER_LENGTH
    ? `${value.slice(0, MAX_IDENTIFIER_LENGTH - 1)}…`
    : value;
}

function getTracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/** `error.type` without the message: API `status`, else the error class name. */
function errorType(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return String(status);
    if (error instanceof Error && error.name) return error.name;
    const name = (error as { constructor?: { name?: unknown } }).constructor
      ?.name;
    if (typeof name === "string" && name) return name;
  }
  return "_OTHER";
}

function markFailed(span: Span, error: unknown): string {
  const type = errorType(error);
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
  return type;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Adds an event to the active span, when there is one. Attributes must not
 * carry step input, output or any other content.
 *
 * @internal
 */
export function recordWorkflowSpanEvent(
  name: string,
  attributes: Record<string, string | number | boolean>,
): void {
  const span = trace.getActiveSpan();
  if (span !== undefined && typeof span.addEvent === "function") {
    span.addEvent(name, attributes);
  }
}

/**
 * Runs `fn` inside an `invoke_workflow <workflowName>` span.
 *
 * The span starts synchronously, so its parent is the span active when this is
 * called. A thrown error marks the span failed (`error.type`, status `ERROR`)
 * and is rethrown unchanged; an `AbortError` is rethrown without marking.
 *
 * @param meta - Workflow identity recorded on the span.
 * @param fn - Work to run inside the span; receives the span.
 * @returns The value `fn` resolves to.
 *
 * @internal
 */
export function withWorkflowSpan<T>(
  meta: WorkflowSpanMeta,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const span = getTracer().startSpan(
    `invoke_workflow ${ident(meta.workflowName)}`,
  );
  span.setAttributes({
    "gen_ai.operation.name": "invoke_workflow",
    "adk.workflow.name": ident(meta.workflowName),
    "adk.node.path": ident(meta.nodePath ?? ""),
    ...(meta.sessionId
      ? { "gen_ai.conversation.id": ident(meta.sessionId) }
      : {}),
  });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await fn(span);
    } catch (error) {
      if (!isAbort(error)) markFailed(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Records the workflow execution id on the active `invoke_workflow` span, so
 * a span processor can export the spans of the trace under that execution.
 * A no-op without an active span.
 *
 * @param executionId - The resolved execution id.
 *
 * @internal
 */
export function setWorkflowExecutionIdOnActiveSpan(executionId: string): void {
  trace
    .getActiveSpan()
    ?.setAttribute(WORKFLOW_EXECUTION_ID_SPAN_ATTRIBUTE, executionId);
}

class StepState implements WorkflowStepSpanHandle {
  status: WorkflowStepStatus = "completed";
  attempt: number;
  interruptCount = 0;

  constructor(
    readonly span: Span,
    attempt: number,
  ) {
    this.attempt = attempt;
  }

  waiting(interruptCount = 1): void {
    this.status = "waiting";
    this.interruptCount = interruptCount;
  }

  setAttempt(attempt: number): void {
    this.attempt = attempt;
  }

  setInterruptCount(count: number): void {
    this.interruptCount = count;
  }

  finish(status: WorkflowStepStatus): void {
    this.span.setAttributes({
      "adk.node.attempt": this.attempt,
      "adk.node.status": status,
      "adk.node.interrupt_count": this.interruptCount,
    });
  }
}

function startStep(meta: WorkflowStepSpanMeta): StepState {
  const span = getTracer().startSpan(`execute_node ${ident(meta.name)}`);
  span.setAttributes({
    "gen_ai.operation.name": "execute_node",
    "adk.node.path": ident(meta.nodePath ?? meta.name),
    ...(meta.runId ? { "adk.node.run_id": ident(meta.runId) } : {}),
  });
  return new StepState(span, meta.attempt ?? 0);
}

/**
 * Runs `fn` inside an `execute_node <name>` span.
 *
 * The span starts synchronously (its parent is the span active when this is
 * called, so concurrent steps scheduled from the same place are siblings) and
 * `fn` runs in its context, so ADK spans created underneath nest under it.
 * The span ends with `adk.node.status` `completed` (or `waiting` when `fn`
 * called `handle.waiting()`), or `failed` plus `error.type` and status `ERROR`
 * when `fn` throws. An `AbortError` is rethrown and recorded as `failed`
 * without an error status.
 *
 * @param meta - Step identity recorded on the span.
 * @param fn - Work to run inside the span; receives a handle to refine the span.
 * @returns The value `fn` resolves to.
 *
 * @internal
 */
export function withStepSpan<T>(
  meta: WorkflowStepSpanMeta,
  fn: (handle: WorkflowStepSpanHandle) => Promise<T> | T,
): Promise<T> {
  const step = startStep(meta);
  return context.with(trace.setSpan(context.active(), step.span), async () => {
    try {
      const result = await fn(step);
      step.finish(step.status);
      return result;
    } catch (error) {
      step.finish("failed");
      if (!isAbort(error)) markFailed(step.span, error);
      throw error;
    } finally {
      step.span.end();
    }
  });
}

/**
 * Like {@link withStepSpan} for work that yields events: wraps the async
 * iterable returned by `factory` so the step span stays open until the
 * iteration finishes, fails or is abandoned (`return()`), and every `next()`
 * runs in the span's context (the pattern of ADK's
 * `runAsyncGeneratorWithOtelContext`). An abandoned stream ends with
 * `adk.node.status` `cancelled`, without an error status, unless the handle
 * marked the step `waiting`.
 *
 * @param meta - Step identity recorded on the span.
 * @param factory - Creates the event stream; receives a handle to refine the span.
 * @returns An async generator yielding the events of the wrapped stream.
 *
 * @internal
 */
export async function* withStepSpanStream<T>(
  meta: WorkflowStepSpanMeta,
  factory: (handle: WorkflowStepSpanHandle) => AsyncIterable<T>,
): AsyncGenerator<T, void, void> {
  const step = startStep(meta);
  const spanContext = trace.setSpan(context.active(), step.span);
  let failed = false;
  let exhausted = false;
  let iterator: AsyncIterator<T> | undefined;
  try {
    iterator = context.with(spanContext, () =>
      factory(step)[Symbol.asyncIterator](),
    );
    while (true) {
      const result = await context.with(spanContext, () =>
        (iterator as AsyncIterator<T>).next(),
      );
      if (result.done) {
        exhausted = true;
        break;
      }
      yield result.value;
    }
  } catch (error) {
    failed = true;
    if (!isAbort(error)) markFailed(step.span, error);
    throw error;
  } finally {
    // Reached on completion, error, or the consumer calling return().
    if (iterator?.return && !failed && !exhausted) {
      await context.with(spanContext, async () => {
        await iterator?.return?.();
      });
    }
    // A stream abandoned before it ended did not complete, unless the step
    // was waiting for input, which ends the stream on purpose.
    step.finish(
      failed
        ? "failed"
        : exhausted || step.status === "waiting"
          ? step.status
          : "cancelled",
    );
    step.span.end();
  }
}
