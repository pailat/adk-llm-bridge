/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Event, InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import { SpanStatusCode, trace } from "@opentelemetry/api";

const tracerName = "gcp.vertex.agent";
const tracerVersion = "adk-llm-bridge";

/**
 * Whether message content may be written to spans.
 *
 * ADK >= 2.5 (google/adk-js#1168) controls this with
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`
 * (`NO_CONTENT` | `EVENT_ONLY` | `SPAN_ONLY` | `SPAN_AND_EVENT`), while
 * ADK 2.4 uses `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS`. The OTel variable wins
 * when set (`true`/`1` count as `SPAN_ONLY`); otherwise the legacy variable
 * applies, capturing unless it is set to something other than `true`/`1`.
 */
function shouldCaptureMessageContent(): boolean {
  const otel = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  if (otel !== undefined && otel.trim() !== "") {
    const mode = otel.trim().toUpperCase();
    return (
      mode === "SPAN_ONLY" ||
      mode === "SPAN_AND_EVENT" ||
      mode === "TRUE" ||
      mode === "1"
    );
  }
  const value = process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS || "true";
  return value === "true" || value === "1";
}

export function traceAdkEvent({
  event,
  context,
  providerId,
}: {
  event: Event;
  context: InvocationContext;
  providerId: string;
}): void {
  const spanName = spanNameForEvent(event);
  const tracer = trace.getTracer(tracerName, tracerVersion);
  const span = tracer.startSpan(spanName);
  try {
    const title = readableEventTitle(event);
    const metadata = readCustomMetadata(event);
    const llmRequest = buildSyntheticAdkLlmRequest(context, providerId);
    const parentToolName = stringValue(metadata.parentToolName);
    const parentToolCallId = stringValue(metadata.parentToolCallId);
    const metadataSubAgentName = stringValue(metadata.subAgentName);
    span.setAttributes({
      "gen_ai.system": "gcp.vertex.agent",
      "gen_ai.agent.name":
        event.author ?? context.agent?.name ?? "external_agent",
      "gen_ai.operation.name":
        spanName === "call_llm" ? "call_llm" : "execute_tool",
      "gen_ai.request.model": providerId,
      "gcp.vertex.agent.invocation_id": context.invocationId,
      "gcp.vertex.agent.session_id": readSessionId(context),
      "gcp.vertex.agent.event_id": event.id,
      "gcp.vertex.agent.provider_id": providerId,
      "gcp.vertex.agent.external_agent.name": event.author ?? "",
      "gcp.vertex.agent.event_title": title,
      "gcp.vertex.agent.branch": event.branch ?? "",
      "gcp.vertex.agent.subagent.name": metadataSubAgentName,
      "gcp.vertex.agent.parent_tool.name": parentToolName,
      "gcp.vertex.agent.parent_tool.call_id": parentToolCallId,
      "gcp.vertex.agent.llm_request": captureJson(llmRequest),
      "gcp.vertex.agent.llm_response": captureJson(event),
    });

    if (event.errorCode) {
      // Same criterion as ADK's tracing: error type only, never the message.
      span.setAttribute("error.type", event.errorCode);
      span.setStatus({ code: SpanStatusCode.ERROR, message: event.errorCode });
    }

    const functionCall = event.content?.parts?.find(
      (part) => part.functionCall,
    )?.functionCall;
    const functionResponse = event.content?.parts?.find(
      (part) => part.functionResponse,
    )?.functionResponse;
    if (functionCall) {
      span.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": functionCall.name ?? "run_adk_subagent",
        "gen_ai.tool.call.id": functionCall.id ?? event.id,
        "gcp.vertex.agent.tool_call_args": captureJson(functionCall.args ?? {}),
        "gcp.vertex.agent.subagent.name":
          stringValue(delegationTarget(functionCall.args)) ||
          metadataSubAgentName,
      });
    }
    if (functionResponse) {
      span.setAttributes({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": functionResponse.name ?? "run_adk_subagent",
        "gen_ai.tool.call.id": functionResponse.id ?? event.id,
        "gcp.vertex.agent.tool_response": captureJson(
          functionResponse.response ?? {},
        ),
        "gcp.vertex.agent.subagent.name":
          delegationTarget(functionResponse.response) || metadataSubAgentName,
      });
    }
  } finally {
    span.end();
  }
}

function buildSyntheticAdkLlmRequest(
  context: InvocationContext,
  providerId: string,
): { model: string; contents: Content[] } {
  const userContent = (context as { userContent?: Content }).userContent;
  return {
    model: providerId,
    contents: userContent ? [contentForTrace(userContent)] : [],
  };
}

function contentForTrace(content: Content): Content {
  return {
    role: content.role,
    parts: content.parts?.filter((part) => !part.inlineData) ?? [],
  };
}

function spanNameForEvent(event: Event): string {
  const functionCall = event.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  if (functionCall) {
    const subAgentName = delegationTarget(functionCall.args);
    return functionCall.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent → ${subAgentName}`
      : `execute_tool ${functionCall.name ?? "<unknown>"}${toolDetail(functionCall.args)}`;
  }

  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionResponse) {
    const subAgentName = delegationTarget(functionResponse.response);
    return functionResponse.name === "run_adk_subagent" && subAgentName
      ? `execute_tool run_adk_subagent ← ${subAgentName}`
      : `execute_tool ${functionResponse.name ?? "<unknown>"}${toolDetail(functionResponse.response)}`;
  }

  const toolProgressSpanName = spanNameForToolProgress(event);
  if (toolProgressSpanName) {
    return toolProgressSpanName;
  }

  return "call_llm";
}

function spanNameForToolProgress(event: Event): string | undefined {
  const metadata = readCustomMetadata(event);
  const itemType = stringValue(metadata.itemType);
  if (!isToolProgressItemType(itemType)) {
    return undefined;
  }
  return `execute_tool ${itemType}${toolDetail(metadata)}`;
}

function isToolProgressItemType(value: string): boolean {
  return (
    value === "command_execution" ||
    value === "web_search" ||
    value === "mcp_tool_call"
  );
}

export function toolDetail(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const command = stringValue(record.command);
  const status = stringValue(record.status);
  const query = stringValue(record.query);
  const toolName = stringValue(record.toolName);
  const detail = command || query || toolName || status;
  return detail ? `: ${truncate(detail, 72)}` : "";
}

function readableEventTitle(event: Event): string {
  const metadata = readCustomMetadata(event);
  const metadataTitle = stringValue(metadata.title);
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
    return truncate(text, 80);
  }

  const itemType = stringValue(metadata.itemType);
  const status = stringValue(metadata.status);
  const subAgentName = stringValue(metadata.subAgentName) || event.author;
  if (itemType && subAgentName) {
    return `${subAgentName}: ${itemType}${status ? ` ${status}` : ""}`;
  }

  return event.errorMessage
    ? `error:${event.errorCode ?? "EXTERNAL_AGENT_ERROR"}`
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

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Sub-agent named by a delegation call: `agent_name` (native) or legacy `agentName`. */
function delegationTarget(args: unknown): string {
  const record = (args ?? {}) as { agent_name?: unknown; agentName?: unknown };
  return stringValue(record.agent_name) || stringValue(record.agentName);
}

function captureJson(value: unknown): string {
  return shouldCaptureMessageContent() ? safeJsonSerialize(value) : "{}";
}

function safeJsonSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "<not serializable>";
  }
}
