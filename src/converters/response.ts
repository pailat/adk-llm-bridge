/**
 * Response converter for OpenAI to ADK format.
 *
 * This module handles the conversion of OpenAI API responses to
 * ADK LlmResponse format, supporting both single responses and streaming.
 */

import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import type OpenAI from "openai";
import { PROVIDER_ERROR_NO_CHOICE } from "../core/provider-llm-error.js";
import type { StreamAccumulator, StreamChunkResult } from "../types.js";
import { contentFilteredError, modelVersionOf } from "./finish.js";
import {
  type MalformedToolCall,
  malformedToolCallResponse,
  parseToolArguments,
} from "./tool-arguments.js";
import { generateToolCallId } from "./tool-call-ids.js";

/**
 * Maps an OpenAI `finish_reason` to the ADK/genai {@link FinishReason} enum.
 *
 * @param reason - The OpenAI finish reason (may be null/undefined)
 * @returns The mapped FinishReason, or undefined when unknown
 *
 * @internal
 */
function mapOpenAIFinishReason(
  reason: OpenAI.ChatCompletion.Choice["finish_reason"] | null | undefined,
): FinishReason | undefined {
  if (reason == null) return undefined;
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "function_call":
      return FinishReason.STOP;
    case "length":
      return FinishReason.MAX_TOKENS;
    case "content_filter":
      return FinishReason.SAFETY;
    default: {
      // Every SDK value has a case, so a new one is a compile error here.
      // A gateway can still send other strings: they map to undefined.
      const unknown: never = reason;
      void unknown;
      return undefined;
    }
  }
}

/**
 * Converts an OpenAI chat completion response to ADK LlmResponse format.
 *
 * Handles:
 * - Text content extraction
 * - Tool/function call conversion
 * - Usage metadata mapping
 *
 * @param response - The OpenAI ChatCompletion response
 * @returns The converted ADK LlmResponse; a `NO_CHOICE` error response when
 *   `choices` is empty or missing (some gateways answer HTTP 200 with an
 *   error object)
 *
 * @example
 * ```typescript
 * import { convertResponse } from "adk-llm-bridge";
 *
 * const openaiResponse = await client.chat.completions.create({...});
 * const adkResponse = convertResponse(openaiResponse);
 *
 * if (adkResponse.content?.parts) {
 *   for (const part of adkResponse.content.parts) {
 *     if (part.text) console.log(part.text);
 *     if (part.functionCall) console.log("Tool call:", part.functionCall.name);
 *   }
 * }
 * ```
 */
export function convertResponse(response: OpenAI.ChatCompletion): LlmResponse {
  // Some gateways answer HTTP 200 with an error object and no `choices`.
  const choice = response.choices?.[0];
  if (!choice) {
    return {
      errorCode: PROVIDER_ERROR_NO_CHOICE,
      errorMessage: "No response choice",
      turnComplete: true,
    };
  }

  const parts: Part[] = [];

  // Surface provider reasoning as a thought part before the answer text.
  // OpenAI/OpenRouter use `reasoning`; xAI/DeepSeek use `reasoning_content`;
  // OpenRouter also returns a structured `reasoning_details` array. These fields
  // are not in the OpenAI SDK types, so read them defensively.
  const thoughtPart = buildThoughtPart(choice.message);
  if (thoughtPart) parts.push(thoughtPart);

  if (choice.message.content) {
    parts.push({ text: choice.message.content });
  }

  const malformed: MalformedToolCall[] = [];
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    const parsed = parseToolArguments(tc.function.arguments, tc.function.name);
    if (!parsed.ok) {
      malformed.push(parsed.failure);
      continue;
    }
    parts.push({
      functionCall: {
        // Some gateways send an empty id; ADK pairs the response by id.
        id: tc.id || generateToolCallId(),
        name: tc.function.name,
        args: parsed.args,
      },
    });
  }

  const usageMetadata = response.usage
    ? buildUsageMetadata(response.usage)
    : undefined;
  // Namespaced key so downstream code can read per-token logprobs.
  const customMetadata = choice.logprobs?.content?.length
    ? { logprobs: choice.logprobs }
    : undefined;

  const modelVersion = modelVersionOf(response.model);

  if (malformed.length) {
    return malformedToolCallResponse(parts, malformed, {
      usageMetadata,
      customMetadata,
      ...modelVersion,
    });
  }

  const finishReason = mapOpenAIFinishReason(choice.finish_reason);
  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    finishReason,
    ...contentFilteredError(finishReason, parts.length > 0),
    usageMetadata,
    customMetadata,
    ...modelVersion,
  };
}

/**
 * Reads provider reasoning text from a chat message/delta.
 *
 * Tolerates the two field names emitted across the OpenAI-compatible family
 * (neither is present in the OpenAI SDK types):
 * - `reasoning` (OpenAI, some OpenRouter models)
 * - `reasoning_content` (xAI Grok, DeepSeek, some OpenRouter models)
 *
 * @returns The reasoning string when present and non-empty, otherwise undefined
 *
 * @internal
 */
function extractReasoning(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const obj = source as Record<string, unknown>;
  const value =
    typeof obj.reasoning_content === "string"
      ? obj.reasoning_content
      : typeof obj.reasoning === "string"
        ? obj.reasoning
        : undefined;
  return value ? value : undefined;
}

/**
 * Reads a structured `reasoning_details` array from a chat message/delta.
 *
 * OpenRouter returns reasoning both as a flat string (`reasoning`) AND as a
 * structured array (`reasoning_details`, e.g.
 * `[{ type: "reasoning.text", text, signature, index }]`). The structured array
 * carries the provider signature needed to replay signed reasoning across turns
 * for signature-strict upstreams (Anthropic/Gemini thinking via OpenRouter).
 *
 * Not in the OpenAI SDK types — read defensively.
 *
 * @returns The reasoning_details array when present and non-empty, else undefined
 *
 * @internal
 */
function extractReasoningDetails(
  source: unknown,
): Record<string, unknown>[] | undefined {
  if (!source || typeof source !== "object") return undefined;
  const details = (source as Record<string, unknown>).reasoning_details;
  if (!Array.isArray(details) || details.length === 0) return undefined;
  return details as Record<string, unknown>[];
}

/**
 * Concatenates the human-readable text out of a `reasoning_details` array.
 *
 * Handles the divergent vendor shapes opaquely: `reasoning.text` (anthropic /
 * gemini / glm / deepseek via OpenRouter) and `reasoning.summary` (openai / grok
 * via OpenRouter). Encrypted-only payloads contribute no display text.
 *
 * @internal
 */
function reasoningDetailsText(details: Record<string, unknown>[]): string {
  return details
    .map((d) =>
      typeof d.text === "string"
        ? d.text
        : typeof d.summary === "string"
          ? d.summary
          : "",
    )
    .filter(Boolean)
    .join("");
}

/**
 * Builds the thought {@link Part} for a `reasoning_details` array.
 *
 * `text` is omitted (not `""`) when the details carry no display text, which is
 * the case for encrypted-only payloads (for example xAI Grok). ADK drops any
 * event whose first part has `text === ""` from the conversation history
 * (`shouldIncludeEventInContext`), so an empty-text thought part in front of a
 * function call makes the call disappear and the next turn fail with "No
 * function call event found". The signature still carries the full details for
 * the multi-turn round-trip.
 *
 * @internal
 */
function thoughtPartFromDetails(details: Record<string, unknown>[]): Part {
  const text = reasoningDetailsText(details);
  return {
    ...(text ? { text } : {}),
    thought: true,
    thoughtSignature: JSON.stringify(details),
  };
}

/**
 * Builds the ADK thought {@link Part} for a non-streaming message.
 *
 * Prefers the structured `reasoning_details` array (carries the signature, which
 * is preserved verbatim on `thoughtSignature` for multi-turn round-trip);
 * otherwise falls back to the flat reasoning string. Returns undefined when the
 * message carries no reasoning.
 *
 * @internal
 */
function buildThoughtPart(source: unknown): Part | undefined {
  const details = extractReasoningDetails(source);
  if (details) return thoughtPartFromDetails(details);
  const reasoning = extractReasoning(source);
  if (reasoning) {
    return { text: reasoning, thought: true };
  }
  return undefined;
}

/**
 * Maps an OpenAI usage object to ADK `usageMetadata`.
 *
 * `completion_tokens_details.reasoning_tokens` (present on reasoning models) is
 * surfaced as `thoughtsTokenCount` when available, and
 * `prompt_tokens_details.cached_tokens` as `cachedContentTokenCount`
 * (`promptTokenCount` keeps OpenAI's meaning: it already includes cached tokens).
 *
 * `completion_tokens` includes the reasoning tokens, while genai's
 * `candidatesTokenCount` does not (Gemini reports thoughts apart). So
 * `candidatesTokenCount` is `completion_tokens` minus the reasoning tokens, and
 * candidates plus thoughts equals `completion_tokens`. `totalTokenCount` is the
 * provider's total.
 *
 * @internal
 */
function buildUsageMetadata(
  usage: OpenAI.CompletionUsage,
): NonNullable<LlmResponse["usageMetadata"]> {
  const metadata: NonNullable<LlmResponse["usageMetadata"]> = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined && reasoningTokens !== null) {
    metadata.thoughtsTokenCount = reasoningTokens;
    metadata.candidatesTokenCount = Math.max(
      0,
      usage.completion_tokens - reasoningTokens,
    );
  }
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined && cachedTokens !== null) {
    metadata.cachedContentTokenCount = cachedTokens;
  }
  return metadata;
}

/**
 * Processes a streaming chunk and returns the appropriate response.
 *
 * This function accumulates partial data (text and tool calls) across
 * multiple chunks and returns:
 * - Partial responses for text content (streamed immediately)
 * - Complete responses when finish_reason is received
 *
 * Tool calls are accumulated and only returned in the final response
 * because their arguments arrive in fragments across multiple chunks.
 *
 * @param chunk - The OpenAI streaming chunk
 * @param acc - The stream accumulator for tracking partial data
 * @returns Object containing optional response and completion status
 *
 * @example
 * ```typescript
 * import { createStreamAccumulator, convertStreamChunk } from "adk-llm-bridge";
 *
 * const accumulator = createStreamAccumulator();
 *
 * let finalResponse;
 * for await (const chunk of stream) {
 *   const { response, isComplete } = convertStreamChunk(chunk, accumulator);
 *
 *   if (isComplete) {
 *     // Hold the final response (complete tool calls) but keep draining: with
 *     // `stream_options.include_usage`, a usage-only chunk arrives AFTER the
 *     // finish chunk and lands in `accumulator.usage`.
 *     finalResponse = response;
 *     continue;
 *   }
 *
 *   if (response?.content?.parts?.[0]?.text) {
 *     // Stream text to user immediately
 *     process.stdout.write(response.content.parts[0].text);
 *   }
 * }
 *
 * if (finalResponse) {
 *   if (accumulator.usage) finalResponse.usageMetadata = accumulator.usage;
 *   return finalResponse;
 * }
 * ```
 */
export function convertStreamChunk(
  chunk: OpenAI.ChatCompletionChunk,
  acc: StreamAccumulator,
): StreamChunkResult {
  // The final usage chunk (stream_options.include_usage) has empty choices and
  // carries the cumulative token usage — capture it without completing.
  if (chunk.usage) {
    acc.usage = buildUsageMetadata(chunk.usage);
  }
  if (chunk.model) acc.model = chunk.model;

  const choice = chunk.choices[0];
  if (!choice) return { isComplete: false };

  const delta = choice.delta;

  // A single chunk can legitimately carry a reasoning delta AND a content delta
  // AND/OR tool_call fragments AND/OR a finish_reason. Process every facet of
  // the chunk; never early-return on the first one seen.
  const partialParts: Part[] = [];

  // Stream provider reasoning deltas immediately as thought parts and keep a
  // running copy so the final accumulated response can include them too.
  const reasoningDelta = extractReasoning(delta);
  if (reasoningDelta) {
    acc.reasoning += reasoningDelta;
    partialParts.push({ text: reasoningDelta, thought: true });
  }

  // Accumulate structured reasoning_details fragments by their `index` so the
  // signed reasoning can be reassembled (in order) on finish. Fragments for the
  // same index carry incremental `text` plus a (usually final) `signature`.
  const detailFragments = extractReasoningDetails(delta);
  if (detailFragments) {
    for (const frag of detailFragments) {
      const idx = reasoningDetailKey(acc.reasoningDetails, frag);
      const existing = acc.reasoningDetails.get(idx);
      if (!existing) {
        acc.reasoningDetails.set(idx, { ...frag });
      } else {
        // Merge: append streamed text, overwrite scalar fields (signature, etc.)
        // with the latest non-undefined value.
        for (const [key, value] of Object.entries(frag)) {
          if (key === "text" && typeof value === "string") {
            existing.text =
              (typeof existing.text === "string" ? existing.text : "") + value;
          } else if (value !== undefined) {
            existing[key] = value;
          }
        }
      }
    }
  }

  if (delta?.content) {
    acc.text += delta.content;
    partialParts.push({ text: delta.content });
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = toolCallKey(acc.toolCalls, tc);
      let a = acc.toolCalls.get(idx);
      if (!a) {
        a = { id: "", name: "", arguments: "" };
        acc.toolCalls.set(idx, a);
      }
      if (tc.id) a.id = tc.id;
      const name = tc.function?.name;
      // Most gateways stream the name once or in pieces; some repeat the
      // whole name (or the name so far) on every fragment.
      if (name) a.name = name.startsWith(a.name) ? name : a.name + name;
      if (tc.function?.arguments) a.arguments += tc.function.arguments;
    }
  }

  if (choice.finish_reason) {
    const parts: Part[] = [];
    // Prefer structured reasoning_details (carries the signature for round-trip)
    // over the flat reasoning string when both were streamed.
    if (acc.reasoningDetails.size) {
      const details = Array.from(acc.reasoningDetails.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
      parts.push(thoughtPartFromDetails(details));
    } else if (acc.reasoning) {
      parts.push({ text: acc.reasoning, thought: true });
    }
    if (acc.text) parts.push({ text: acc.text });
    const malformed: MalformedToolCall[] = [];
    for (const tc of Array.from(acc.toolCalls.values())) {
      if (tc.name) {
        const parsed = parseToolArguments(tc.arguments, tc.name);
        if (!parsed.ok) {
          malformed.push(parsed.failure);
          continue;
        }
        parts.push({
          functionCall: {
            id: tc.id || generateToolCallId(),
            name: tc.name,
            args: parsed.args,
          },
        });
      }
    }

    const finishReason = mapOpenAIFinishReason(choice.finish_reason);
    const usageMetadata = acc.usage;
    const modelVersion = modelVersionOf(acc.model);

    acc.text = "";
    acc.reasoning = "";
    acc.reasoningDetails.clear();
    acc.toolCalls.clear();
    acc.usage = undefined;

    if (malformed.length) {
      return {
        response: {
          ...malformedToolCallResponse(parts, malformed, {
            usageMetadata,
            ...modelVersion,
          }),
          partial: false,
        },
        isComplete: true,
      };
    }

    return {
      response: {
        content: parts.length ? { role: "model", parts } : undefined,
        partial: false,
        turnComplete: true,
        finishReason,
        ...contentFilteredError(finishReason, parts.length > 0),
        usageMetadata,
        ...modelVersion,
      },
      isComplete: true,
    };
  }

  // No finish in this chunk: surface any streamed text/reasoning parts as a
  // partial response (tool_call fragments are accumulated, not streamed).
  if (partialParts.length) {
    return {
      response: {
        content: { role: "model", parts: partialParts },
        partial: true,
      },
      isComplete: false,
    };
  }

  return { isComplete: false };
}

/**
 * Creates a new stream accumulator for tracking partial responses.
 *
 * The accumulator stores:
 * - Accumulated text content
 * - Accumulated reasoning text and structured reasoning details
 * - Partial tool call data (indexed by position)
 * - Token usage from the trailing usage chunk
 *
 * Use with {@link convertStreamChunk} to process streaming responses.
 *
 * @returns A fresh StreamAccumulator instance
 *
 * @example
 * ```typescript
 * const accumulator = createStreamAccumulator();
 *
 * for await (const chunk of stream) {
 *   const result = convertStreamChunk(chunk, accumulator);
 *   // accumulator state is updated automatically
 * }
 * ```
 */
export function createStreamAccumulator(): StreamAccumulator {
  return {
    text: "",
    reasoning: "",
    reasoningDetails: new Map(),
    toolCalls: new Map(),
  };
}

/** Last key inserted in a map (maps keep insertion order). */
function lastKey<V>(map: Map<number, V>): number | undefined {
  let last: number | undefined;
  for (const key of map.keys()) last = key;
  return last;
}

/** A key above every key in use. */
function nextKey<V>(map: Map<number, V>): number {
  let max = -1;
  for (const key of map.keys()) max = Math.max(max, key);
  return max + 1;
}

/**
 * Accumulator key of a streamed tool-call fragment.
 *
 * @remarks
 * The fragment's `index` when it has one. Without it, a fragment with no id,
 * or with the id of the last call, continues the last call; a new id starts a
 * new call.
 *
 * @internal
 */
function toolCallKey(
  calls: StreamAccumulator["toolCalls"],
  fragment: { index?: number; id?: string },
): number {
  if (typeof fragment.index === "number") return fragment.index;
  const last = lastKey(calls);
  if (last !== undefined) {
    const lastId = calls.get(last)?.id;
    if (!fragment.id || !lastId || fragment.id === lastId) return last;
  }
  return nextKey(calls);
}

/**
 * Accumulator key of a streamed `reasoning_details` fragment.
 *
 * @remarks
 * The fragment's `index` when it has one. Without it, the fragment continues
 * the last entry unless it names a different `type` (an encrypted block after
 * a text block is a new entry).
 *
 * @internal
 */
function reasoningDetailKey(
  details: StreamAccumulator["reasoningDetails"],
  fragment: Record<string, unknown>,
): number {
  if (typeof fragment.index === "number") return fragment.index;
  const last = lastKey(details);
  if (last !== undefined) {
    const lastType = details.get(last)?.type;
    if (fragment.type === undefined || fragment.type === lastType) return last;
  }
  return nextKey(details);
}
