/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Response converter for OpenAI to ADK format.
 *
 * This module handles the conversion of OpenAI API responses to
 * ADK LlmResponse format, supporting both single responses and streaming.
 *
 * @module converters/response
 */

import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import type OpenAI from "openai";
import type { StreamAccumulator, StreamChunkResult } from "../types";
import { safeJsonParse } from "../utils";

/**
 * Maps an OpenAI `finish_reason` to the ADK/genai {@link FinishReason} enum.
 *
 * @param reason - The OpenAI finish reason (may be null/undefined)
 * @returns The mapped FinishReason, or undefined when unknown
 *
 * @internal
 */
function mapOpenAIFinishReason(
  reason: string | null | undefined,
): FinishReason | undefined {
  switch (reason) {
    case "stop":
    case "tool_calls":
    case "function_call":
      return FinishReason.STOP;
    case "length":
      return FinishReason.MAX_TOKENS;
    case "content_filter":
      return FinishReason.SAFETY;
    default:
      return undefined;
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
 * @returns The converted ADK LlmResponse
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
  const choice = response.choices[0];
  if (!choice) {
    return {
      errorCode: "NO_CHOICE",
      errorMessage: "No response choice",
      turnComplete: true,
    };
  }

  const parts: Part[] = [];

  // Surface provider reasoning text as a thought part before the answer text.
  // OpenAI/OpenRouter use `reasoning`; xAI/DeepSeek use `reasoning_content`.
  // These fields are not in the OpenAI SDK types, so read them defensively.
  const reasoning = extractReasoning(choice.message);
  if (reasoning) {
    parts.push({ text: reasoning, thought: true });
  }

  if (choice.message.content) {
    parts.push({ text: choice.message.content });
  }

  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== "function") continue;
    parts.push({
      functionCall: {
        id: tc.id,
        name: tc.function.name,
        args: safeJsonParse(tc.function.arguments),
      },
    });
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    finishReason: mapOpenAIFinishReason(choice.finish_reason),
    usageMetadata: response.usage
      ? buildUsageMetadata(response.usage)
      : undefined,
    // Surface per-token logprobs (when the caller requested them) under a
    // namespaced key so downstream code can read them off the response.
    customMetadata: choice.logprobs?.content?.length
      ? { logprobs: choice.logprobs }
      : undefined,
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
 * Maps an OpenAI usage object to ADK `usageMetadata`.
 *
 * `completion_tokens_details.reasoning_tokens` (present on reasoning models) is
 * surfaced as `thoughtsTokenCount` when available.
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
 * for await (const chunk of stream) {
 *   const { response, isComplete } = convertStreamChunk(chunk, accumulator);
 *
 *   if (response?.content?.parts?.[0]?.text) {
 *     // Stream text to user immediately
 *     process.stdout.write(response.content.parts[0].text);
 *   }
 *
 *   if (isComplete) {
 *     // Final response with complete tool calls
 *     return response;
 *   }
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

  if (delta?.content) {
    acc.text += delta.content;
    partialParts.push({ text: delta.content });
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? acc.toolCalls.size;
      let a = acc.toolCalls.get(idx);
      if (!a) {
        a = { id: "", name: "", arguments: "" };
        acc.toolCalls.set(idx, a);
      }
      if (tc.id) a.id = tc.id;
      if (tc.function?.name) a.name += tc.function.name;
      if (tc.function?.arguments) a.arguments += tc.function.arguments;
    }
  }

  if (choice.finish_reason) {
    const parts: Part[] = [];
    if (acc.reasoning) parts.push({ text: acc.reasoning, thought: true });
    if (acc.text) parts.push({ text: acc.text });
    for (const tc of Array.from(acc.toolCalls.values())) {
      if (tc.name) {
        parts.push({
          functionCall: {
            id: tc.id,
            name: tc.name,
            args: safeJsonParse(tc.arguments),
          },
        });
      }
    }

    const finishReason = mapOpenAIFinishReason(choice.finish_reason);
    const usageMetadata = acc.usage;

    acc.text = "";
    acc.reasoning = "";
    acc.toolCalls.clear();
    acc.usage = undefined;

    return {
      response: {
        content: parts.length ? { role: "model", parts } : undefined,
        turnComplete: true,
        finishReason,
        usageMetadata,
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
 * - Partial tool call data (indexed by position)
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
  return { text: "", reasoning: "", toolCalls: new Map() };
}
