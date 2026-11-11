import { createEvent, type Event, type InvocationContext } from "@google/adk";
import type {
  Content,
  GenerateContentResponseUsageMetadata,
} from "@google/genai";
import {
  type Context as OtelContext,
  context as otelContext,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
// One copy of the capture rules (OTel GenAI variable, then the ADK 2.4 one).
import { shouldCaptureMessageContent } from "../core/telemetry.js";
import { AGENT_KIND_ATTRIBUTE } from "../runtime/agent-kind.js";
import {
  itemTitle,
  stringOrEmpty,
  toolDetail,
  truncate,
} from "./event-titles.js";
import {
  EXTERNAL_AGENT_ERROR,
  type ExternalAgentCompletedEvent,
  type ExternalAgentEvent,
  type ExternalAgentModelInfo,
  type ExternalAgentUsage,
} from "./events.js";
import type { ExternalAgentToolsReport } from "./tools/adk-tool-bridge.js";

const tracerName = "gcp.vertex.agent";
const tracerVersion = "adk-llm-bridge";

/** Bridge-specific attributes live next to the existing external-agent ones. */
const EXT = "gcp.vertex.agent.external_agent";

/**
 * Spans of one `ExternalAgent` run, all children of the agent's
 * `invoke_agent` span (the OTel context active when the run started).
 *
 * - `call_llm`: one per model call. A call starts when the run starts (or the
 *   runtime reports `started`), or when the last tool result of the previous
 *   step arrives, and ends at the first model output of that step: a final
 *   text, a tool call or a delegation. Later output of the same step (a second
 *   text block, parallel tool calls) belongs to the same call. An `error`
 *   event ends the open call with an error status (or, when none is open, is
 *   recorded as a zero-length `call_llm`). Runtimes report usage per run, not
 *   per call, so token counts go on `invoke_agent`, not on `call_llm`.
 * - `execute_tool <name>`: from a `tool_call` to the `tool_result` with the
 *   same `callId` (or, with no id, the oldest open call of the same name). A
 *   result with no matching call is a zero-length span; calls still open when
 *   the run ends are ended then.
 * - `execute_tool transfer_to_agent` (`run_adk_subagent` in the metadata-rich shape):
 *   the whole delegation. The sub-agent's `invoke_agent` span is its child.
 *
 * Times come from the driver's event `timestamp` (milliseconds), falling back
 * to the time the event is observed.
 *
 * @internal
 */
export class ExternalAgentRunTracer {
  readonly #context: InvocationContext;
  readonly #providerId: string;
  readonly #requestModel?: string;
  readonly #parent: OtelContext;
  readonly #agentSpan?: Span;
  #responseModel?: string;
  #turnStart: number;
  /** A model call is in progress: no output of the current step yet. */
  #turnOpen = true;
  readonly #openTools: OpenTool[] = [];
  /** First progress time of each Codex item, by item id. */
  readonly #progressStart = new Map<string, number>();
  #finished = false;

  /**
   * Creates the span recorder of one external-agent run.
   *
   * @param options - The invocation context, the provider id, and the model
   * the driver was configured with (written to `gen_ai.request.model`).
   */
  constructor({
    context,
    providerId,
    requestModel,
  }: {
    context: InvocationContext;
    providerId: string;
    requestModel?: string;
  }) {
    this.#context = context;
    this.#providerId = providerId;
    this.#requestModel = requestModel || undefined;
    this.#parent = otelContext.active();
    this.#agentSpan = trace.getSpan(this.#parent);
    this.#turnStart = Date.now();
    this.#agentSpan?.setAttribute(AGENT_KIND_ATTRIBUTE, "external");
    if (this.#requestModel) {
      this.#agentSpan?.setAttribute("gen_ai.request.model", this.#requestModel);
    }
  }

  /**
   * Records one runtime event. `adkEvent` is the ADK event it was mapped to,
   * if any (it supplies ids, titles and the captured response).
   *
   * @param event - The runtime event.
   * @param adkEvent - The ADK event `event` was mapped to.
   */
  onDriverEvent(event: ExternalAgentEvent, adkEvent?: Event): void {
    if (this.#finished) return;
    const time = eventTime(event.timestamp);
    switch (event.type) {
      case "started":
        if (event.model) this.#setResponseModel(event.model);
        if (event.timestamp !== undefined) this.#turnStart = time;
        return;
      case "output": {
        const itemType = stringOrEmpty(event.metadata?.itemType);
        if (isToolProgressItemType(itemType)) {
          // Codex tool progress (item.started/updated): the model chose a
          // tool, so its call is over. The tool span itself comes from the
          // builtin tool_call/tool_result pair the driver emits on
          // item.completed; the first progress event of an item (matched by
          // `metadata.itemId`) gives that span its start time.
          this.#endModelCall(time, adkEvent);
          const itemId = stringOrEmpty(event.metadata?.itemId);
          if (itemId && !this.#progressStart.has(itemId)) {
            this.#progressStart.set(itemId, time);
          }
          return;
        }
        if (!event.partial) this.#endModelCall(time, adkEvent);
        return;
      }
      case "tool_call": {
        this.#endModelCall(time, adkEvent);
        const progressStart = event.callId
          ? this.#progressStart.get(event.callId)
          : undefined;
        if (event.callId) this.#progressStart.delete(event.callId);
        this.#openTools.push({
          callId: event.callId,
          name: event.name,
          start: Math.min(progressStart ?? time, time),
          builtin: event.metadata?.builtin === true,
          event: adkEvent,
        });
        return;
      }
      case "tool_result": {
        const index = this.#openTools.findIndex((open) =>
          event.callId
            ? open.callId === event.callId
            : !open.callId && open.name === event.name,
        );
        const open =
          index >= 0 ? this.#openTools.splice(index, 1)[0] : undefined;
        this.#toolSpan({
          name: event.name,
          callId: event.callId,
          start: open?.start ?? time,
          end: time,
          builtin: open?.builtin ?? event.metadata?.builtin === true,
          callEvent: open?.event,
          resultEvent: adkEvent,
          error: event.error !== undefined,
        });
        // The next model call starts once the results are back.
        this.#turnStart = time;
        this.#turnOpen = true;
        return;
      }
      case "error":
        if (this.#turnOpen) {
          this.#endModelCall(time, adkEvent);
        } else {
          this.#llmSpan(time, time, adkEvent);
        }
        return;
      case "state_delta":
        return;
      case "completed":
        this.finish(event);
        return;
    }
  }

  /**
   * Zero-length span for an event the bridge emits itself (a confirmation
   * request, consumed answers). Events with no tool call or tool response get
   * no span.
   *
   * @param event - The ADK event the bridge emitted.
   */
  traceMarker(event: Event): void {
    const capture = shouldCaptureMessageContent();
    const spanName = spanNameForEvent(event, capture);
    if (!spanName) return;
    const time = eventTime(event.timestamp);
    const span = this.#startSpan(spanName, time);
    try {
      span.setAttributes(this.#baseAttributes(event, capture));
      span.setAttribute("gen_ai.operation.name", "execute_tool");
      applyToolAttributes(span, event, capture);
      applyEventError(span, event);
    } finally {
      span.end(time);
    }
  }

  /**
   * Runs a delegation inside its `execute_tool` span, so the sub-agent's
   * `invoke_agent` span nests under it. The delegation is model output: it
   * ends the open model call, and the next call starts when it returns.
   *
   * @param info - Call id, tool name, target agent and arguments.
   * @param run - Performs the delegation.
   * @returns The result of `run`.
   * @throws Rethrows whatever `run` throws, after marking the span as failed.
   */
  async traceDelegation<T extends DelegationOutcome>(
    info: DelegationTraceInfo,
    run: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    const capture = shouldCaptureMessageContent();
    const callEvent = createEvent({
      invocationId: this.#context.invocationId,
      author: this.#context.agent?.name,
      branch: this.#context.branch,
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: info.callId,
              name: info.toolName,
              args: info.args,
            },
          },
        ],
      },
    });
    this.#endModelCall(start, callEvent);
    const spanName =
      info.toolName === "transfer_to_agent"
        ? "execute_tool transfer_to_agent"
        : `execute_tool ${info.toolName} → ${info.agentName}`;
    const span = this.#startSpan(spanName, start);
    span.setAttributes({
      ...this.#baseAttributes(callEvent, capture),
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": info.toolName,
      "gen_ai.tool.call.id": info.callId,
      "gcp.vertex.agent.subagent.name": info.agentName,
      "gcp.vertex.agent.llm_request": "{}",
      "gcp.vertex.agent.llm_response": "{}",
      "gcp.vertex.agent.tool_call_args": captureJson(info.args, capture),
    });
    try {
      const result = await otelContext.with(
        trace.setSpan(this.#parent, span),
        run,
      );
      const { stateDelta: _stateDelta, ...response } = result;
      span.setAttribute(
        "gcp.vertex.agent.tool_response",
        captureJson(response, capture),
      );
      if (result.interrupt) {
        span.setAttribute(`${EXT}.interrupt`, result.interrupt.kind);
      } else if (result.error) {
        span.setAttribute("error.type", "SUBAGENT_ERROR");
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "SUBAGENT_ERROR",
        });
      }
      return result;
    } catch (error) {
      const type = error instanceof Error ? error.name || "Error" : "_OTHER";
      span.setAttribute("error.type", type);
      span.setStatus({ code: SpanStatusCode.ERROR, message: type });
      throw error;
    } finally {
      const end = Math.max(start, Date.now());
      span.end(end);
      this.#turnStart = end;
      this.#turnOpen = true;
    }
  }

  /**
   * Ends the run: writes the model, usage, cost and turns the runtime
   * reported to the `invoke_agent` span and ends tool calls still open.
   * Idempotent.
   *
   * @param completed - The `completed` event, when the runtime sent one.
   */
  finish(completed?: ExternalAgentCompletedEvent): void {
    if (this.#finished) return;
    this.#finished = true;
    const time = eventTime(completed?.timestamp);
    if (completed?.model) this.#setResponseModel(completed.model);
    for (const open of this.#openTools.splice(0)) {
      this.#toolSpan({
        name: open.name,
        callId: open.callId,
        start: open.start,
        end: Math.max(open.start, time),
        builtin: open.builtin,
        callEvent: open.event,
        incomplete: true,
      });
    }
    if (completed && this.#agentSpan) {
      this.#agentSpan.setAttributes(runAttributes(completed));
    }
  }

  /**
   * Records the tools an effective `read-only` policy hid, as attributes of
   * the agent span. Empty lists set nothing.
   *
   * @param report - The run's tools report.
   */
  traceToolsReport(report: ExternalAgentToolsReport): void {
    if (!this.#agentSpan) return;
    const lists: Array<[string, readonly string[] | undefined]> = [
      [`${EXT}.tools.hidden`, report.hidden],
      [`${EXT}.tools.ambiguous`, report.ambiguous],
      [`${EXT}.tools.unmatched_read_only`, report.unmatchedReadOnlyTools],
    ];
    for (const [key, names] of lists) {
      if (names && names.length > 0) {
        this.#agentSpan.setAttribute(key, [...names]);
      }
    }
  }

  /**
   * Writes the run's model report to the `invoke_agent` span: the small/fast
   * pin, every model the run billed, and the ones nobody asked for (only when
   * there are some).
   *
   * @param info - The run's {@link ExternalAgentModelInfo}.
   */
  onModelInfo(info: ExternalAgentModelInfo): void {
    const span = this.#agentSpan;
    if (!span) return;
    if (info.smallFast !== undefined) {
      span.setAttribute(`${EXT}.model.small_fast`, info.smallFast);
    }
    if (info.used !== undefined) {
      span.setAttribute(`${EXT}.models.used`, [...info.used]);
    }
    if (info.unexpected !== undefined && info.unexpected.length > 0) {
      span.setAttribute(`${EXT}.models.unexpected`, [...info.unexpected]);
    }
  }

  #setResponseModel(model: string): void {
    this.#responseModel = model;
    this.#agentSpan?.setAttribute("gen_ai.response.model", model);
  }

  #endModelCall(time: number, event: Event | undefined): void {
    if (!this.#turnOpen) return;
    this.#turnOpen = false;
    this.#llmSpan(Math.min(this.#turnStart, time), time, event);
  }

  #llmSpan(start: number, end: number, event: Event | undefined): void {
    const capture = shouldCaptureMessageContent();
    const span = this.#startSpan("call_llm", start);
    try {
      span.setAttributes({
        ...this.#baseAttributes(event, capture),
        "gen_ai.operation.name": "call_llm",
        "gcp.vertex.agent.llm_request": captureJson(
          buildSyntheticAdkLlmRequest(
            this.#context,
            this.#requestModel ?? this.#responseModel,
          ),
          capture,
        ),
        "gcp.vertex.agent.llm_response": event
          ? captureJson(event, capture)
          : "{}",
      });
      if (event) applyEventError(span, event);
    } finally {
      span.end(end);
    }
  }

  #toolSpan(tool: {
    name: string;
    callId?: string;
    start: number;
    end: number;
    builtin: boolean;
    callEvent?: Event;
    resultEvent?: Event;
    error?: boolean;
    incomplete?: boolean;
  }): void {
    const capture = shouldCaptureMessageContent();
    const named = tool.callEvent ?? tool.resultEvent;
    const spanName =
      (named && spanNameForEvent(named, capture)) ||
      `execute_tool ${tool.name}`;
    const span = this.#startSpan(spanName, tool.start);
    try {
      span.setAttributes({
        ...this.#baseAttributes(named, capture),
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": tool.name,
        "gcp.vertex.agent.llm_request": "{}",
        "gcp.vertex.agent.llm_response": "{}",
      });
      if (tool.callEvent) applyToolAttributes(span, tool.callEvent, capture);
      if (tool.resultEvent) {
        applyToolAttributes(span, tool.resultEvent, capture);
      }
      span.setAttribute(
        "gen_ai.tool.call.id",
        tool.callId ?? named?.id ?? "<not specified>",
      );
      if (tool.builtin) span.setAttribute(`${EXT}.builtin_tool`, true);
      if (tool.incomplete) span.setAttribute(`${EXT}.tool_incomplete`, true);
      if (tool.error) {
        span.setAttribute("error.type", "TOOL_ERROR");
        span.setStatus({ code: SpanStatusCode.ERROR, message: "TOOL_ERROR" });
      }
    } finally {
      span.end(Math.max(tool.start, tool.end));
    }
  }

  #startSpan(name: string, startTime: number): Span {
    return trace
      .getTracer(tracerName, tracerVersion)
      .startSpan(name, { startTime }, this.#parent);
  }

  #baseAttributes(
    event: Event | undefined,
    capture: boolean,
  ): Record<string, string> {
    const metadata = event ? readCustomMetadata(event) : {};
    const author = event?.author ?? this.#context.agent?.name;
    return {
      "gen_ai.system": "gcp.vertex.agent",
      "gen_ai.agent.name": author ?? "external_agent",
      ...(this.#requestModel
        ? { "gen_ai.request.model": this.#requestModel }
        : {}),
      ...(this.#responseModel
        ? { "gen_ai.response.model": this.#responseModel }
        : {}),
      "gcp.vertex.agent.invocation_id": this.#context.invocationId,
      "gcp.vertex.agent.session_id": readSessionId(this.#context),
      "gcp.vertex.agent.event_id": event?.id ?? "",
      "gcp.vertex.agent.provider_id": this.#providerId,
      [`${EXT}.name`]: author ?? "",
      "gcp.vertex.agent.event_title": event
        ? readableEventTitle(event, capture)
        : (author ?? "external_agent"),
      "gcp.vertex.agent.branch": event?.branch ?? this.#context.branch ?? "",
      "gcp.vertex.agent.subagent.name": stringOrEmpty(metadata.subAgentName),
      "gcp.vertex.agent.parent_tool.name": stringOrEmpty(
        metadata.parentToolName,
      ),
      "gcp.vertex.agent.parent_tool.call_id": stringOrEmpty(
        metadata.parentToolCallId,
      ),
    };
  }
}

/**
 * What the tracer needs to know about a delegation.
 *
 * @internal
 */
export interface DelegationTraceInfo {
  /** Id of the delegation call on the timeline. */
  callId: string;
  /** Name of the sub-agent that receives the task. */
  agentName: string;
  /** `transfer_to_agent` (native shape) or `run_adk_subagent` (metadata-rich shape). */
  toolName: string;
  /** The call arguments as emitted on the timeline (captured per the rules). */
  args: Record<string, unknown>;
}

/**
 * The parts of a delegation result the tracer reads.
 *
 * @internal
 */
export interface DelegationOutcome {
  /** Error message when the sub-agent failed. */
  error?: string;
  /** Set when the sub-agent paused on the user; `kind` names why. */
  interrupt?: { kind: string };
  /** State changes of the sub-agent. Not recorded on the span. */
  stateDelta?: unknown;
}

interface OpenTool {
  callId?: string;
  name: string;
  start: number;
  builtin: boolean;
  event?: Event;
}

/**
 * ADK usage metadata for a run, following the Anthropic provider:
 * `promptTokenCount` is the full prompt (input plus cache read and cache
 * creation), `cachedContentTokenCount` the cache-read part. `undefined` when
 * the runtime reported no token counts.
 *
 * @param usage - Usage the runtime reported for the run.
 * @returns The ADK usage metadata, or `undefined` without token counts.
 * @internal
 */
export function usageMetadataFor(
  usage: ExternalAgentUsage | undefined,
): GenerateContentResponseUsageMetadata | undefined {
  if (!usage) return undefined;
  const prompt = promptTokens(usage);
  const output = usage.outputTokens;
  if (prompt === undefined && output === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { promptTokenCount: prompt } : {}),
    ...(output !== undefined ? { candidatesTokenCount: output } : {}),
    totalTokenCount: (prompt ?? 0) + (output ?? 0),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cachedContentTokenCount: usage.cacheReadInputTokens }
      : {}),
  };
}

function promptTokens(usage: ExternalAgentUsage): number | undefined {
  const parts = [
    usage.inputTokens,
    usage.cacheReadInputTokens,
    usage.cacheCreationInputTokens,
  ].filter((value): value is number => typeof value === "number");
  return parts.length > 0
    ? parts.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/** Run-level attributes for the `invoke_agent` span. */
function runAttributes(
  completed: ExternalAgentCompletedEvent,
): Record<string, string | number> {
  const usage = completed.usage;
  const attributes: Record<string, string | number> = {};
  if (usage) {
    const prompt = promptTokens(usage);
    if (prompt !== undefined) {
      attributes["gen_ai.usage.input_tokens"] = prompt;
    }
    if (usage.outputTokens !== undefined) {
      attributes["gen_ai.usage.output_tokens"] = usage.outputTokens;
    }
    if (usage.cacheReadInputTokens !== undefined) {
      attributes["gen_ai.usage.cache_read.input_tokens"] =
        usage.cacheReadInputTokens;
    }
    if (usage.cacheCreationInputTokens !== undefined) {
      attributes["gen_ai.usage.cache_creation.input_tokens"] =
        usage.cacheCreationInputTokens;
    }
    if (usage.totalCostUsd !== undefined) {
      attributes[`${EXT}.usage.cost_usd`] = usage.totalCostUsd;
    }
    if (usage.byModel && Object.keys(usage.byModel).length > 0) {
      attributes[`${EXT}.usage.by_model`] = safeJsonSerialize(usage.byModel);
    }
  }
  if (completed.numTurns !== undefined) {
    attributes[`${EXT}.num_turns`] = completed.numTurns;
  }
  if (completed.durationMs !== undefined) {
    attributes[`${EXT}.duration_ms`] = completed.durationMs;
  }
  return attributes;
}

/** Event time in epoch milliseconds; a seconds value is converted. */
function eventTime(timestamp: number | undefined): number {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return Date.now();
  }
  if (timestamp <= 0) return Date.now();
  return timestamp < 1e11 ? timestamp * 1000 : timestamp;
}

function applyToolAttributes(span: Span, event: Event, capture: boolean): void {
  const metadataSubAgentName = stringOrEmpty(
    readCustomMetadata(event).subAgentName,
  );
  const functionCall = event.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionCall) {
    span.setAttributes({
      "gen_ai.tool.name": functionCall.name ?? "run_adk_subagent",
      "gen_ai.tool.call.id": functionCall.id ?? event.id,
      "gcp.vertex.agent.tool_call_args": captureJson(
        functionCall.args ?? {},
        capture,
      ),
      "gcp.vertex.agent.subagent.name":
        stringOrEmpty(delegationTarget(functionCall.args)) ||
        metadataSubAgentName,
    });
  }
  if (functionResponse) {
    span.setAttributes({
      "gen_ai.tool.name": functionResponse.name ?? "run_adk_subagent",
      "gen_ai.tool.call.id": functionResponse.id ?? event.id,
      "gcp.vertex.agent.tool_response": captureJson(
        functionResponse.response ?? {},
        capture,
      ),
      "gcp.vertex.agent.subagent.name":
        delegationTarget(functionResponse.response) || metadataSubAgentName,
    });
  }
}

function applyEventError(span: Span, event: Event): void {
  if (event.errorCode) {
    // Same criterion as ADK's tracing: error type only, never the message.
    span.setAttribute("error.type", event.errorCode);
    span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorCode });
  }
}

function buildSyntheticAdkLlmRequest(
  context: InvocationContext,
  model: string | undefined,
): { model?: string; contents: Content[] } {
  const userContent = (context as { userContent?: Content }).userContent;
  return {
    ...(model ? { model } : {}),
    contents: userContent ? [contentForTrace(userContent)] : [],
  };
}

function contentForTrace(content: Content): Content {
  return {
    role: content.role,
    parts: content.parts?.filter((part) => !part.inlineData) ?? [],
  };
}

/**
 * Span names are exported like any attribute, so tool arguments (a shell
 * command, a search query) only appear in them when message content capture is
 * on. With capture off the name carries the tool name and nothing else.
 */
function spanNameForEvent(event: Event, capture: boolean): string | undefined {
  const functionCall = event.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  if (functionCall) {
    const subAgentName = delegationTarget(functionCall.args);
    return functionCall.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent → ${subAgentName}`
      : `execute_tool ${functionCall.name ?? "<unknown>"}${capture ? toolDetail(functionCall.args) : ""}`;
  }

  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionResponse) {
    const subAgentName = delegationTarget(functionResponse.response);
    return functionResponse.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent ← ${subAgentName}`
      : `execute_tool ${functionResponse.name ?? "<unknown>"}${capture ? toolDetail(functionResponse.response) : ""}`;
  }

  return undefined;
}

function isToolProgressItemType(value: string): boolean {
  return (
    value === "command_execution" ||
    value === "web_search" ||
    value === "mcp_tool_call"
  );
}

function readableEventTitle(event: Event, capture: boolean): string {
  const metadata = readCustomMetadata(event);
  // Driver-provided titles embed tool arguments, and text titles embed the
  // model output, so neither is used when content capture is off.
  const metadataTitle = capture ? stringOrEmpty(metadata.title) : "";
  if (metadataTitle) {
    return metadataTitle;
  }

  const functionCall = event.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  if (functionCall?.name) {
    return `functionCall:${functionCall.name}`;
  }

  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionResponse?.name) {
    return `functionResponse:${functionResponse.name}`;
  }

  const text = event.content?.parts
    ?.map((part) => part.text)
    .find(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
  if (text) {
    return capture
      ? truncate(text, 80)
      : `${event.author ?? "external_agent"}: response`;
  }

  const itemType = stringOrEmpty(metadata.itemType);
  const subAgentName = stringOrEmpty(metadata.subAgentName) || event.author;
  if (itemType && subAgentName) {
    return itemTitle(subAgentName, itemType, stringOrEmpty(metadata.status));
  }

  return event.errorMessage
    ? `error:${event.errorCode ?? EXTERNAL_AGENT_ERROR}`
    : (event.author ?? "external_agent");
}

function readCustomMetadata(event: Event): Record<string, unknown> {
  return (
    (event as { customMetadata?: Record<string, unknown> }).customMetadata ?? {}
  );
}

function readSessionId(context: InvocationContext): string {
  const session = (context as { session?: { id?: unknown } }).session;
  return typeof session?.id === "string" ? session.id : "";
}

/** Sub-agent named by a delegation call: `agent_name` (native) or `agentName` (metadata-rich shape). */
function delegationTarget(args: unknown): string {
  const record = (args ?? {}) as { agent_name?: unknown; agentName?: unknown };
  return stringOrEmpty(record.agent_name) || stringOrEmpty(record.agentName);
}

function captureJson(value: unknown, capture: boolean): string {
  return capture ? safeJsonSerialize(value) : "{}";
}

function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<not serializable>";
  }
}
