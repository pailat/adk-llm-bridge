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
import type { Part } from "@google/genai";
import type OpenAI from "openai";
import type { StreamAccumulator, StreamChunkResult } from "../types";

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

  if (choice.message.content) {
    parts.push({ text: choice.message.content });
  }

  for (const tc of choice.message.tool_calls ?? []) {
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
    usageMetadata: response.usage
      ? {
          promptTokenCount: response.usage.prompt_tokens,
          candidatesTokenCount: response.usage.completion_tokens,
          totalTokenCount: response.usage.total_tokens,
        }
      : undefined,
  };
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
  const choice = chunk.choices[0];
  if (!choice) return { isComplete: false };

  const delta = choice.delta;

  if (delta?.content) {
    acc.text += delta.content;
    return {
      response: {
        content: { role: "model", parts: [{ text: delta.content }] },
        partial: true,
      },
      isComplete: false,
    };
  }

  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
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

    acc.text = "";
    acc.toolCalls.clear();

    return {
      response: {
        content: parts.length ? { role: "model", parts } : undefined,
        turnComplete: true,
      },
      isComplete: true,
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
  return { text: "", toolCalls: new Map() };
}

/**
 * Safely parses a JSON string, returning an empty object on failure.
 *
 * Used for parsing function call arguments which may be malformed
 * in edge cases.
 *
 * @param str - The JSON string to parse
 * @returns The parsed object, or empty object if parsing fails
 *
 * @internal
 */
function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
