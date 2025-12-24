/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Response converter for Anthropic Messages API to ADK format.
 *
 * This module handles the conversion of Anthropic API responses to
 * ADK LlmResponse format, supporting both single responses and streaming.
 *
 * @module providers/anthropic/converters/response
 */

import type { LlmResponse } from "@google/adk";
import type { Part } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Accumulator for Anthropic streaming responses.
 */
export interface AnthropicStreamAccumulator {
  /** Accumulated text content */
  text: string;

  /** Accumulated tool uses */
  toolUses: Map<
    number,
    {
      id: string;
      name: string;
      input: string;
    }
  >;

  /** Current content block index being processed */
  currentBlockIndex: number;

  /** Input tokens from message_start event */
  inputTokens?: number;

  /** Output tokens accumulated during streaming */
  outputTokens?: number;
}

/**
 * Result from processing an Anthropic stream event.
 */
export interface AnthropicStreamResult {
  /** The LLM response, if any */
  response?: LlmResponse;

  /** Whether the stream is complete */
  isComplete: boolean;
}

/**
 * Converts an Anthropic Message response to ADK LlmResponse format.
 *
 * @param message - The Anthropic Message response
 * @returns The converted ADK LlmResponse
 */
export function convertAnthropicResponse(
  message: Anthropic.Message,
): LlmResponse {
  const parts: Part[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ text: block.text });
    }

    if (block.type === "tool_use") {
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        },
      });
    }
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    usageMetadata: message.usage
      ? {
          promptTokenCount: message.usage.input_tokens,
          candidatesTokenCount: message.usage.output_tokens,
          totalTokenCount:
            message.usage.input_tokens + message.usage.output_tokens,
        }
      : undefined,
  };
}

/**
 * Creates a new stream accumulator for Anthropic responses.
 */
export function createAnthropicStreamAccumulator(): AnthropicStreamAccumulator {
  return {
    text: "",
    toolUses: new Map(),
    currentBlockIndex: -1,
    inputTokens: undefined,
    outputTokens: undefined,
  };
}

/**
 * Processes an Anthropic streaming event and returns the appropriate response.
 *
 * @param event - The Anthropic stream event
 * @param acc - The stream accumulator
 * @returns Object containing optional response and completion status
 */
export function convertAnthropicStreamEvent(
  event: Anthropic.MessageStreamEvent,
  acc: AnthropicStreamAccumulator,
): AnthropicStreamResult {
  switch (event.type) {
    case "message_start": {
      // Capture input tokens from message_start event
      if (event.message?.usage?.input_tokens) {
        acc.inputTokens = event.message.usage.input_tokens;
      }
      return { isComplete: false };
    }

    case "message_delta": {
      // Capture output tokens from message_delta event
      if (event.usage?.output_tokens) {
        acc.outputTokens = event.usage.output_tokens;
      }
      return { isComplete: false };
    }

    case "content_block_start": {
      acc.currentBlockIndex = event.index;

      if (event.content_block.type === "tool_use") {
        acc.toolUses.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          input: "",
        });
      }

      return { isComplete: false };
    }

    case "content_block_delta": {
      const delta = event.delta;

      if (delta.type === "text_delta") {
        acc.text += delta.text;
        return {
          response: {
            content: { role: "model", parts: [{ text: delta.text }] },
            partial: true,
          },
          isComplete: false,
        };
      }

      if (delta.type === "input_json_delta") {
        const toolUse = acc.toolUses.get(event.index);
        if (toolUse) {
          toolUse.input += delta.partial_json;
        }
      }

      return { isComplete: false };
    }

    case "message_stop": {
      // Build final response with accumulated content
      const parts: Part[] = [];

      if (acc.text) {
        parts.push({ text: acc.text });
      }

      for (const toolUse of acc.toolUses.values()) {
        if (toolUse.name) {
          parts.push({
            functionCall: {
              id: toolUse.id,
              name: toolUse.name,
              args: safeJsonParse(toolUse.input),
            },
          });
        }
      }

      // Build usage metadata if available
      const hasUsage =
        acc.inputTokens !== undefined || acc.outputTokens !== undefined;
      const usageMetadata = hasUsage
        ? {
            promptTokenCount: acc.inputTokens ?? 0,
            candidatesTokenCount: acc.outputTokens ?? 0,
            totalTokenCount: (acc.inputTokens ?? 0) + (acc.outputTokens ?? 0),
          }
        : undefined;

      // Reset accumulator
      acc.text = "";
      acc.toolUses.clear();
      acc.currentBlockIndex = -1;
      acc.inputTokens = undefined;
      acc.outputTokens = undefined;

      return {
        response: {
          content: parts.length ? { role: "model", parts } : undefined,
          turnComplete: true,
          usageMetadata,
        },
        isComplete: true,
      };
    }

    default:
      return { isComplete: false };
  }
}

/**
 * Safely parses a JSON string, returning an empty object on failure.
 */
function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}
