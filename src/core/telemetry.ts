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
 */

import type { LlmResponse } from "@google/adk";
import { type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  CACHE_CREATION_METADATA_KEY,
  COST_METADATA_KEY,
} from "../converters/cache-usage.js";
import { LogCode, warnOnce } from "../utils/log.js";
import { httpStatusOf } from "./provider-llm-error.js";

/**
 * Whether message content may be written to spans, by ADK's rules.
 *
 * Only `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` set to `SPAN_ONLY`
 * or `SPAN_AND_EVENT` (any case) captures. Unset, `NO_CONTENT`, `EVENT_ONLY`
 * and anything else do not; the boolean values `true` and `1` mean
 * `EVENT_ONLY`, so they keep content off spans too.
 * `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` turns nothing on (ADK applies it to
 * live runs only); when it asks for content and the OTel variable is unset,
 * a warning names the variable to set, once per process. Also used by
 * `src/agents/telemetry.ts`.
 */
export function shouldCaptureMessageContent(): boolean {
  const otel = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
  const mode = (otel ?? "").trim().toUpperCase();
  if (mode === "") warnIfOldCaptureVariableSet();
  return mode === "SPAN_ONLY" || mode === "SPAN_AND_EVENT";
}

function warnIfOldCaptureVariableSet(): void {
  const old = (process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS ?? "")
    .trim()
    .toLowerCase();
  if (old !== "true" && old !== "1") return;
  // Variable names and the documented value only, never the old value.
  warnOnce(
    LogCode.SPAN_CONTENT_CAPTURE_VARIABLE_IGNORED,
    "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS is no longer read, so no message " +
      "content is captured on spans; set " +
      "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=SPAN_ONLY to " +
      "capture message content on spans.",
  );
}

/**
 * Bridge provider ids whose OpenTelemetry GenAI semantic-convention
 * `gen_ai.provider.name` value differs from the id.
 */
const SEMCONV_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  xai: "x_ai",
};

/**
 * The `gen_ai.provider.name` value for a bridge provider id.
 *
 * @remarks
 * Uses the OpenTelemetry GenAI semantic-convention value where one exists:
 * `openai`, `anthropic` and `x_ai` (for the bridge's `xai`). Providers with
 * no semconv value keep the bridge id, as the convention allows:
 * `openrouter`, `ai-gateway`, `custom`, or the `providerId` of a custom
 * provider.
 *
 * @param provider - The bridge provider id.
 * @returns The value to record.
 */
export function genAiProviderName(provider: string): string {
  return Object.hasOwn(SEMCONV_PROVIDER_NAMES, provider)
    ? (SEMCONV_PROVIDER_NAMES[provider] as string)
    : provider;
}

/** Attributes describing the provider that served a model call. */
export interface LlmSpanInfo {
  /**
   * Bridge provider id, e.g. `openai`, `anthropic`, `xai`, `openrouter`,
   * `ai-gateway`, `custom`; recorded through {@link genAiProviderName}.
   */
  provider: string;
  /** Model reported by the provider in its response (may differ from the request). */
  model?: string;
  /** Provider-assigned response/completion id. */
  responseId?: string;
  /** Endpoint base URL; only its host (and port) is recorded. */
  baseURL?: string;
  /** Prompt tokens served from the cache (`gen_ai.usage.cache_read.input_tokens`). */
  cacheReadTokens?: number;
  /** Prompt tokens written to the cache (`gen_ai.usage.cache_creation.input_tokens`). */
  cacheCreationTokens?: number;
  /** Cost the provider reported for the call (`adk_llm_bridge.usage.cost_usd`). */
  costUsd?: number;
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
 * Records the cache usage of a finished call on the active model-call span:
 * the cache-read tokens from `usageMetadata.cachedContentTokenCount` and the
 * cache-write tokens from `customMetadata.cacheCreationTokenCount`. Attributes
 * the provider did not report are skipped. The cost the provider reported
 * (`customMetadata.costUsd`) goes on the same span as
 * `adk_llm_bridge.usage.cost_usd`.
 *
 * @param provider - Bridge provider id
 * @param response - The converted response of the call
 */
export function annotateCacheUsage(
  provider: string,
  response: Pick<LlmResponse, "usageMetadata" | "customMetadata">,
): void {
  const read = response.usageMetadata?.cachedContentTokenCount;
  const written = response.customMetadata?.[CACHE_CREATION_METADATA_KEY];
  const cost = response.customMetadata?.[COST_METADATA_KEY];
  if (
    read === undefined &&
    typeof written !== "number" &&
    typeof cost !== "number"
  ) {
    return;
  }
  annotateLlmSpan({
    provider,
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
    ...(read !== undefined ? { cacheReadTokens: read } : {}),
    ...(typeof written === "number" ? { cacheCreationTokens: written } : {}),
  });
}

/**
 * Annotates the active model-call span (ADK 2.4 `call_llm`, ADK 2.5
 * `generate_content {model}`; found as the active span, never by name) with
 * provider-level GenAI attributes:
 * `gen_ai.provider.name` (see {@link genAiProviderName}), `gen_ai.response.model`, `gen_ai.response.id`,
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
    "gen_ai.provider.name": genAiProviderName(info.provider),
  };
  if (info.model) attributes["gen_ai.response.model"] = info.model;
  if (info.responseId) attributes["gen_ai.response.id"] = info.responseId;
  if (info.cacheReadTokens !== undefined) {
    attributes["gen_ai.usage.cache_read.input_tokens"] = info.cacheReadTokens;
  }
  if (info.cacheCreationTokens !== undefined) {
    attributes["gen_ai.usage.cache_creation.input_tokens"] =
      info.cacheCreationTokens;
  }
  if (info.costUsd !== undefined) {
    attributes["adk_llm_bridge.usage.cost_usd"] = info.costUsd;
  }
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
  const status = httpStatusOf(error);
  const errorType =
    status !== undefined
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
