/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenTelemetry helpers shared by every LLM provider.
 *
 * ADK wraps each model call in a span (`call_llm` in ADK 2.4, renamed
 * `generate_content {model}` in ADK 2.5) and always labels it
 * `gen_ai.system="gcp.vertex.agent"`, so a trace cannot tell OpenAI from
 * Anthropic from OpenRouter, and a provider failure that we convert into an
 * error response leaves the span `OK`. These helpers enrich the **active**
 * span from inside `generateContentAsync` (which ADK runs within that span).
 * Both are no-ops when no span is active (no OTel SDK, or called outside ADK).
 *
 * Nothing sensitive is recorded: only the host of the endpoint (never the full
 * URL, which may embed credentials), identifiers and error classes. Span names
 * are never touched and no prompt or response text is written. Provider error
 * messages can echo user content (content-filter or validation errors), so
 * they are attached through `recordException` only while message-content
 * capture is on (see {@link shouldCaptureMessageContent}); otherwise just the
 * error class is recorded.
 *
 * @module core/telemetry
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Whether message content may be written to spans.
 *
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` wins when set
 * (`SPAN_ONLY`, `SPAN_AND_EVENT`, `true` and `1` capture; `NO_CONTENT`,
 * `EVENT_ONLY` and anything else do not). Otherwise the ADK 2.4 variable
 * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` applies, capturing unless it is set
 * to something other than `true`/`1`. Also used by `src/agents/telemetry.ts`.
 */
export function shouldCaptureMessageContent(): boolean {
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

/** Attributes describing the provider that served a model call. */
export interface LlmSpanInfo {
  /** Provider id, e.g. `openai`, `anthropic`, `xai`, `openrouter`, `ai-gateway`, `custom`. */
  provider: string;
  /** Model reported by the provider in its response (may differ from the request). */
  model?: string;
  /** Provider-assigned response/completion id. */
  responseId?: string;
  /** Endpoint base URL; only its host (and port) is recorded. */
  baseURL?: string;
}

/**
 * Extracts `host` and `port` from a base URL without ever returning
 * credentials, path or query. Returns an empty object for invalid URLs.
 */
export function serverAddress(baseURL: string | undefined): {
  address?: string;
  port?: number;
} {
  if (!baseURL) return {};
  try {
    const url = new URL(baseURL);
    const port = url.port ? Number(url.port) : undefined;
    return { address: url.hostname || undefined, port };
  } catch {
    return {};
  }
}

/**
 * Annotates the active model-call span (ADK 2.4 `call_llm`, ADK 2.5
 * `generate_content {model}`; found as the active span, never by name) with
 * provider-level GenAI attributes:
 * `gen_ai.provider.name`, `gen_ai.response.model`, `gen_ai.response.id`,
 * `server.address` and `server.port`. Undefined values are skipped, so it is
 * safe to call more than once (for example once the response id is known).
 *
 * @param info - What is known about the call so far
 * @param span - Span to annotate; defaults to the active span
 */
export function annotateLlmSpan(
  info: LlmSpanInfo,
  span: Span | undefined = trace.getActiveSpan(),
): void {
  if (!span) return;
  const { address, port } = serverAddress(info.baseURL);
  const attributes: Record<string, string | number> = {
    "gen_ai.provider.name": info.provider,
  };
  if (info.model) attributes["gen_ai.response.model"] = info.model;
  if (info.responseId) attributes["gen_ai.response.id"] = info.responseId;
  if (address) attributes["server.address"] = address;
  if (port !== undefined && Number.isFinite(port)) {
    attributes["server.port"] = port;
  }
  span.setAttributes(attributes);
}

/**
 * Marks the active span as failed: records the exception, sets `error.type`
 * (the HTTP status when the error carries a numeric `status`, otherwise the
 * error class name) and the `ERROR` status. The status carries no message, so
 * nothing user-provided leaks through it; the exception event carries the
 * message only while content capture is enabled.
 *
 * Call it in the provider's `catch`, before converting the error into an
 * `LlmResponse` (and never for caller-initiated aborts).
 *
 * @param error - The caught value
 * @param span - Span to mark; defaults to the active span
 */
export function recordLlmError(
  error: unknown,
  span: Span | undefined = trace.getActiveSpan(),
): void {
  if (!span) return;
  const status =
    error !== null && typeof error === "object" && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  const errorType =
    typeof status === "number"
      ? String(status)
      : error instanceof Error
        ? error.name || "Error"
        : "_OTHER";

  if (shouldCaptureMessageContent()) {
    span.recordException(error instanceof Error ? error : String(error));
  } else {
    // The message may quote prompt or response text: record the class only.
    span.recordException({ name: errorType });
  }
  span.setAttribute("error.type", errorType);
  span.setStatus({ code: SpanStatusCode.ERROR });
}
