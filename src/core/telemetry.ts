/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenTelemetry helpers shared by every LLM provider.
 *
 * ADK wraps each model call in a `call_llm` span and always labels it
 * `gen_ai.system="gcp.vertex.agent"`, so a trace cannot tell OpenAI from
 * Anthropic from OpenRouter, and a provider failure that we convert into an
 * error response leaves the span `OK`. These helpers enrich the **active**
 * span from inside `generateContentAsync` (which ADK runs within that span).
 * Both are no-ops when no span is active (no OTel SDK, or called outside ADK).
 *
 * Nothing sensitive is recorded: only the host of the endpoint (never the full
 * URL, which may embed credentials), identifiers and error classes. Exception
 * messages are attached through `recordException`, as ADK does for its own
 * errors.
 *
 * @module core/telemetry
 */

import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";

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
 * Annotates the active `call_llm` span with provider-level GenAI attributes:
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
 * nothing user-provided leaks through it.
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

  span.recordException(error instanceof Error ? error : String(error));
  span.setAttribute("error.type", errorType);
  span.setStatus({ code: SpanStatusCode.ERROR });
}
