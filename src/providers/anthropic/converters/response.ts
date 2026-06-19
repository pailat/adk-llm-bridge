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

import type Anthropic from "@anthropic-ai/sdk";
import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import { safeJsonParse } from "../../../utils";

/**
 * Maps an Anthropic `stop_reason` to the ADK/genai {@link FinishReason} enum.
 *
 * @param reason - The Anthropic stop reason (may be null/undefined)
 * @returns The mapped FinishReason, or undefined when unknown
 *
 * @internal
 */
function mapAnthropicStopReason(
  reason: string | null | undefined,
): FinishReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return FinishReason.STOP;
    case "max_tokens":
      return FinishReason.MAX_TOKENS;
    case "refusal":
      return FinishReason.SAFETY;
    default:
      return undefined;
  }
}

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

  /** Accumulated thinking (extended reasoning) blocks, keyed by block index */
  thinkingBlocks: Map<
    number,
    {
      thinking: string;
      signature: string;
    }
  >;

  /** Current content block index being processed */
  currentBlockIndex: number;

  /** Input tokens from message_start event */
  inputTokens?: number;

  /** Output tokens accumulated during streaming */
  outputTokens?: number;

  /** Stop reason captured from the message_delta event */
  stopReason?: string | null;
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

    // Extended thinking: surface as an ADK thought part. The signature
    // (encrypted full reasoning) is preserved on thoughtSignature so it can be
    // echoed back on multi-turn requests.
    if (block.type === "thinking") {
      parts.push({
        text: block.thinking,
        thought: true,
        thoughtSignature: block.signature,
      });
    }

    // Redacted thinking carries only opaque encrypted data (no signature/text).
    if (block.type === "redacted_thinking") {
      parts.push({
        thought: true,
        thoughtSignature: block.data,
      });
    }

    if (block.type === "tool_use") {
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name,
          args: input,
        },
      });
    }
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    finishReason: mapAnthropicStopReason(message.stop_reason),
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
    thinkingBlocks: new Map(),
    currentBlockIndex: -1,
    inputTokens: undefined,
    outputTokens: undefined,
    stopReason: undefined,
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
      // Capture the stop reason (carried on the message_delta).
      if (event.delta?.stop_reason) {
        acc.stopReason = event.delta.stop_reason;
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

      if (event.content_block.type === "thinking") {
        acc.thinkingBlocks.set(event.index, {
          thinking: event.content_block.thinking ?? "",
          signature: event.content_block.signature ?? "",
        });
      }

      // Redacted thinking arrives whole (opaque encrypted data, no deltas).
      if (event.content_block.type === "redacted_thinking") {
        return {
          response: {
            content: {
              role: "model",
              parts: [
                { thought: true, thoughtSignature: event.content_block.data },
              ],
            },
            partial: true,
          },
          isComplete: false,
        };
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
        return { isComplete: false };
      }

      if (delta.type === "thinking_delta") {
        const block = acc.thinkingBlocks.get(event.index) ?? {
          thinking: "",
          signature: "",
        };
        block.thinking += delta.thinking;
        acc.thinkingBlocks.set(event.index, block);
        return {
          response: {
            content: {
              role: "model",
              parts: [{ text: delta.thinking, thought: true }],
            },
            partial: true,
          },
          isComplete: false,
        };
      }

      // The signature arrives after the thinking text; record it for the final
      // assembled thought part (carried on thoughtSignature).
      if (delta.type === "signature_delta") {
        const block = acc.thinkingBlocks.get(event.index) ?? {
          thinking: "",
          signature: "",
        };
        block.signature += delta.signature;
        acc.thinkingBlocks.set(event.index, block);
      }

      return { isComplete: false };
    }

    case "message_stop": {
      // Build final response with accumulated content. Thinking parts are
      // emitted first (in block-index order) so the final assistant turn can be
      // echoed back with signatures intact.
      const parts: Part[] = [];

      for (const index of [...acc.thinkingBlocks.keys()].sort(
        (a, b) => a - b,
      )) {
        const block = acc.thinkingBlocks.get(index);
        if (!block) continue;
        parts.push({
          text: block.thinking,
          thought: true,
          ...(block.signature
            ? { thoughtSignature: block.signature }
            : undefined),
        });
      }

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

      const finishReason = mapAnthropicStopReason(acc.stopReason);

      // Reset accumulator
      acc.text = "";
      acc.toolUses.clear();
      acc.thinkingBlocks.clear();
      acc.currentBlockIndex = -1;
      acc.inputTokens = undefined;
      acc.outputTokens = undefined;
      acc.stopReason = undefined;

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

    default:
      return { isComplete: false };
  }
}
