/**
 * Response converter for Anthropic Messages API to ADK format.
 *
 * This module handles the conversion of Anthropic API responses to
 * ADK LlmResponse format, supporting both single responses and streaming.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { LlmResponse } from "@google/adk";
import { FinishReason, type Part } from "@google/genai";
import {
  type MalformedToolCall,
  malformedToolCallResponse,
  parseToolArguments,
} from "../../../converters/tool-arguments.js";
import { JSON_OUTPUT_TOOL_NAME } from "./request.js";
import { encodeThinkingSignature } from "./thinking-signature.js";

/**
 * Builds the ADK thought part for an Anthropic `thinking` block, or undefined
 * when it carries nothing.
 *
 * ADK drops any history event whose first part has `text === ""`
 * (`shouldIncludeEventInContext`), which would silently remove the whole turn
 * (including its tool calls) from the next request. A thinking block with empty
 * text (reasoning omitted) is therefore stored without `text`, and its
 * signature is marked so the request converter still replays it as a
 * `thinking` block with `thinking: ""`.
 */
function thinkingBlockToPart(
  thinking: string,
  signature: string,
): Part | undefined {
  if (thinking) {
    return {
      text: thinking,
      thought: true,
      ...(signature
        ? { thoughtSignature: encodeThinkingSignature(signature) }
        : undefined),
    };
  }
  if (!signature) return undefined;
  return {
    thought: true,
    thoughtSignature: encodeThinkingSignature(signature, {
      emptyThinking: true,
    }),
  };
}

/**
 * Maps an Anthropic `stop_reason` to the ADK/genai {@link FinishReason} enum.
 *
 * @remarks
 * Every known stop reason has a case, so a new one in the SDK type is a
 * compile error here. A value the SDK does not know yet maps to `undefined`.
 *
 * @param reason - The Anthropic stop reason (may be null/undefined)
 * @returns The mapped FinishReason, or undefined when unknown
 *
 * @internal
 */
function mapAnthropicStopReason(
  reason: Anthropic.StopReason | null | undefined,
): FinishReason | undefined {
  if (reason == null) return undefined;
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "tool_use":
      return FinishReason.STOP;
    case "max_tokens":
    case "model_context_window_exceeded":
      return FinishReason.MAX_TOKENS;
    case "refusal":
      return FinishReason.SAFETY;
    case "pause_turn":
      // A server tool paused a long turn; sending the turn back continues
      // it. It is neither a normal stop nor a cut, so no finish reason.
      return undefined;
    default: {
      const unknown: never = reason;
      void unknown;
      return undefined;
    }
  }
}

/**
 * Tells whether a stop reason means the model was cut off mid-output.
 *
 * @param reason - The Anthropic stop reason.
 * @returns Whether the turn was cut short (output limit or context window), so
 *   the block being generated, a tool call included, is incomplete.
 */
function isTruncatingStop(
  reason: Anthropic.StopReason | null | undefined,
): boolean {
  return reason === "max_tokens" || reason === "model_context_window_exceeded";
}

/**
 * The part for a completed tool call.
 *
 * @remarks
 * Structured output is emulated with a forced synthetic `json_output` tool.
 * ADK's outputKey/outputSchema path reads the text parts and JSON-parses
 * them, and `isFinalResponse` is false when a functionCall is present, so that
 * tool's arguments become a TEXT part (the JSON object), not a functionCall the
 * agent would try to run. Only when `structuredOutput` is on: otherwise a tool
 * of that name is the user's own and is called normally.
 */
function toolCallPart(
  call: { id: string; name: string; args: Record<string, unknown> },
  structuredOutput: boolean,
): Part {
  if (structuredOutput && call.name === JSON_OUTPUT_TOOL_NAME) {
    return { text: JSON.stringify(call.args) };
  }
  return { functionCall: { id: call.id, name: call.name, args: call.args } };
}

/** Options of {@link convertAnthropicResponse}. */
export interface AnthropicResponseOptions {
  /**
   * Whether the request injected the synthetic `json_output` tool (see
   * `convertAnthropicStructuredOutput`).
   *
   * @defaultValue true
   */
  structuredOutput?: boolean;
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
      /** Opaque payload of a `redacted_thinking` block (no text/signature). */
      redacted?: string;
    }
  >;

  /** Current content block index being processed */
  currentBlockIndex: number;

  /** Input tokens from message_start event */
  inputTokens?: number;

  /** Output tokens accumulated during streaming */
  outputTokens?: number;

  /** Tokens served from the prompt cache (`cache_read_input_tokens`) */
  cacheReadTokens?: number;

  /** Tokens written to the prompt cache (`cache_creation_input_tokens`) */
  cacheCreationTokens?: number;

  /** Stop reason captured from the message_delta event */
  stopReason?: Anthropic.StopReason | null;

  /**
   * Whether the request injected the synthetic `json_output` tool; see
   * {@link AnthropicResponseOptions.structuredOutput}. Absent means `true`.
   */
  structuredOutput?: boolean;
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
 * Builds ADK usage metadata from Anthropic token counts.
 *
 * Anthropic reports `input_tokens` EXCLUDING cached tokens, so the real prompt
 * size is `input + cache_read + cache_creation`. ADK reads `promptTokenCount`
 * for compaction thresholds and tracing, so it must be the full prompt size.
 * `cachedContentTokenCount` keeps the cache-read part separately.
 */
function buildUsageMetadata(tokens: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): NonNullable<LlmResponse["usageMetadata"]> {
  const prompt =
    tokens.input + (tokens.cacheRead ?? 0) + (tokens.cacheCreation ?? 0);
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: tokens.output,
    totalTokenCount: prompt + tokens.output,
    ...(tokens.cacheRead !== undefined
      ? { cachedContentTokenCount: tokens.cacheRead }
      : {}),
  };
}

/**
 * Converts an Anthropic Message response to ADK LlmResponse format.
 *
 * @param message - The Anthropic Message response
 * @param options - See {@link AnthropicResponseOptions}
 * @returns The converted ADK LlmResponse
 */
export function convertAnthropicResponse(
  message: Anthropic.Message,
  options: AnthropicResponseOptions = {},
): LlmResponse {
  const structuredOutput = options.structuredOutput ?? true;
  const parts: Part[] = [];
  const malformed: MalformedToolCall[] = [];

  // When the output limit or the context window cuts the turn short, the
  // last block is the one that was being generated; a tool_use there has
  // incomplete arguments even though the API returns it as an object.
  const lastBlock = message.content[message.content.length - 1];
  const truncatedToolUse =
    isTruncatingStop(message.stop_reason) && lastBlock?.type === "tool_use"
      ? lastBlock
      : undefined;

  for (const block of message.content) {
    // Never emit an empty text part: ADK drops events starting with one.
    if (block.type === "text" && block.text) {
      parts.push({ text: block.text });
    }

    // Extended thinking: surface as an ADK thought part. The signature
    // (encrypted full reasoning) is preserved on thoughtSignature so it can be
    // echoed back on multi-turn requests.
    if (block.type === "thinking") {
      const part = thinkingBlockToPart(block.thinking, block.signature);
      if (part) parts.push(part);
    }

    // Redacted thinking carries only opaque encrypted data (no signature/text).
    if (block.type === "redacted_thinking" && block.data) {
      parts.push({
        thought: true,
        thoughtSignature: encodeThinkingSignature(block.data),
      });
    }

    if (block.type === "tool_use") {
      if (block === truncatedToolUse) {
        malformed.push({ name: block.name, reason: "invalid-json" });
        continue;
      }
      // A missing input is a call without arguments; `null`, a scalar or an
      // array is malformed, as `tryParseJson` reports it on the stream.
      const input: unknown = block.input === undefined ? {} : block.input;
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        // Same report as the streaming path: running the tool with `{}`
        // would hide the problem.
        malformed.push({ name: block.name, reason: "not-an-object" });
        continue;
      }
      parts.push(
        toolCallPart(
          {
            id: block.id,
            name: block.name,
            args: input as Record<string, unknown>,
          },
          structuredOutput,
        ),
      );
    }
  }

  const usageMetadata = message.usage
    ? buildUsageMetadata({
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
        cacheRead: message.usage.cache_read_input_tokens ?? undefined,
        cacheCreation: message.usage.cache_creation_input_tokens ?? undefined,
      })
    : undefined;

  if (malformed.length) {
    return malformedToolCallResponse(parts, malformed, { usageMetadata });
  }

  return {
    content: parts.length ? { role: "model", parts } : undefined,
    turnComplete: true,
    finishReason: mapAnthropicStopReason(message.stop_reason),
    usageMetadata,
  };
}

/**
 * Creates a new stream accumulator for Anthropic responses.
 *
 * @param options - See {@link AnthropicResponseOptions}
 */
export function createAnthropicStreamAccumulator(
  options: AnthropicResponseOptions = {},
): AnthropicStreamAccumulator {
  return {
    structuredOutput: options.structuredOutput ?? true,
    text: "",
    toolUses: new Map(),
    thinkingBlocks: new Map(),
    currentBlockIndex: -1,
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
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
      if (event.message?.usage?.cache_read_input_tokens != null) {
        acc.cacheReadTokens = event.message.usage.cache_read_input_tokens;
      }
      if (event.message?.usage?.cache_creation_input_tokens != null) {
        acc.cacheCreationTokens =
          event.message.usage.cache_creation_input_tokens;
      }
      return { isComplete: false };
    }

    case "message_delta": {
      // Capture output tokens from message_delta event
      if (event.usage?.output_tokens) {
        acc.outputTokens = event.usage.output_tokens;
      }
      if (event.usage?.cache_read_input_tokens != null) {
        acc.cacheReadTokens = event.usage.cache_read_input_tokens;
      }
      if (event.usage?.cache_creation_input_tokens != null) {
        acc.cacheCreationTokens = event.usage.cache_creation_input_tokens;
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
        // Also keep it for the final response: only non-partial events are
        // stored in the session, and the block must be replayed next turn.
        if (event.content_block.data) {
          acc.thinkingBlocks.set(event.index, {
            thinking: "",
            signature: "",
            redacted: event.content_block.data,
          });
        }
        return {
          response: {
            content: {
              role: "model",
              parts: [
                {
                  thought: true,
                  thoughtSignature: encodeThinkingSignature(
                    event.content_block.data,
                  ),
                },
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
        if (!delta.text) return { isComplete: false };
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
        if (!delta.thinking) return { isComplete: false };
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
        if (block.redacted) {
          parts.push({
            thought: true,
            thoughtSignature: encodeThinkingSignature(block.redacted),
          });
          continue;
        }
        const part = thinkingBlockToPart(block.thinking, block.signature);
        if (part) parts.push(part);
      }

      if (acc.text) {
        parts.push({ text: acc.text });
      }

      const malformed: MalformedToolCall[] = [];
      const lastToolIndex = Math.max(-1, ...acc.toolUses.keys());
      for (const [index, toolUse] of acc.toolUses) {
        if (toolUse.name) {
          const parsed = parseToolArguments(toolUse.input, toolUse.name);
          // A turn cut short (output limit or context window) leaves its last
          // block incomplete, even when the partial JSON happens to parse.
          const truncated =
            isTruncatingStop(acc.stopReason) &&
            index === lastToolIndex &&
            index === acc.currentBlockIndex;
          if (!parsed.ok || truncated) {
            malformed.push(
              parsed.ok
                ? { name: toolUse.name, reason: "invalid-json" }
                : parsed.failure,
            );
            continue;
          }
          parts.push(
            toolCallPart(
              { id: toolUse.id, name: toolUse.name, args: parsed.args },
              acc.structuredOutput !== false,
            ),
          );
        }
      }

      // Build usage metadata if available
      const hasUsage =
        acc.inputTokens !== undefined || acc.outputTokens !== undefined;
      const usageMetadata = hasUsage
        ? buildUsageMetadata({
            input: acc.inputTokens ?? 0,
            output: acc.outputTokens ?? 0,
            cacheRead: acc.cacheReadTokens,
            cacheCreation: acc.cacheCreationTokens,
          })
        : undefined;

      const finishReason = mapAnthropicStopReason(acc.stopReason);

      // Reset accumulator
      acc.text = "";
      acc.toolUses.clear();
      acc.thinkingBlocks.clear();
      acc.currentBlockIndex = -1;
      acc.inputTokens = undefined;
      acc.outputTokens = undefined;
      acc.cacheReadTokens = undefined;
      acc.cacheCreationTokens = undefined;
      acc.stopReason = undefined;

      if (malformed.length) {
        return {
          response: malformedToolCallResponse(parts, malformed, {
            usageMetadata,
          }),
          isComplete: true,
        };
      }

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
