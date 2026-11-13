/**
 * ADK `LlmResponse` shape parity for the Anthropic converter: a refusal with
 * no content carries `errorCode: "SAFETY"`, `modelVersion` is the model the
 * API reports, and the final streamed response says `partial: false`.
 */

import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { FinishReason } from "@google/genai";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "../../../../src/providers/anthropic/converters/response.js";

function message(
  content: unknown[],
  stopReason: Anthropic.StopReason,
  model = "claude-sonnet-4-5-20250929",
): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function streamTurn(
  events: Anthropic.MessageStreamEvent[],
  acc = createAnthropicStreamAccumulator(),
) {
  const results = events.map((event) =>
    convertAnthropicStreamEvent(event, acc),
  );
  return results[results.length - 1];
}

function start(model = "claude-sonnet-4-5-20250929") {
  return {
    type: "message_start",
    message: message([], "end_turn", model),
  } as unknown as Anthropic.MessageStreamEvent;
}

function stop(reason: Anthropic.StopReason) {
  return {
    type: "message_delta",
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 0 },
  } as unknown as Anthropic.MessageStreamEvent;
}

const END = { type: "message_stop" } as Anthropic.MessageStreamEvent;

function textBlock(text: string): Anthropic.MessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
  ] as Anthropic.MessageStreamEvent[];
}

describe("refusal with no content", () => {
  it("non-streaming: carries errorCode SAFETY and a message", () => {
    const response = convertAnthropicResponse(message([], "refusal"));
    expect(response.content).toBeUndefined();
    expect(response.finishReason).toBe(FinishReason.SAFETY);
    expect(response.errorCode).toBe(FinishReason.SAFETY);
    expect(response.errorMessage).toBe(
      "The provider blocked the response (content filter) and returned no content.",
    );
  });

  it("streaming: carries errorCode SAFETY", () => {
    const final = streamTurn([start(), stop("refusal"), END]);
    expect(final?.isComplete).toBe(true);
    expect(final?.response?.errorCode).toBe(FinishReason.SAFETY);
  });

  it("keeps content and no errorCode when text came before the refusal", () => {
    const response = convertAnthropicResponse(
      message([{ type: "text", text: "I can't" }], "refusal"),
    );
    expect(response.errorCode).toBeUndefined();
    const final = streamTurn([
      start(),
      ...textBlock("I can't"),
      stop("refusal"),
      END,
    ]);
    expect(final?.response?.content?.parts).toEqual([{ text: "I can't" }]);
    expect(final?.response?.errorCode).toBeUndefined();
  });

  it("end_turn with no content keeps no errorCode", () => {
    expect(convertAnthropicResponse(message([], "end_turn")).errorCode).toBe(
      undefined,
    );
  });
});

describe("modelVersion", () => {
  it("non-streaming: is the model the API reports", () => {
    const response = convertAnthropicResponse(
      message([{ type: "text", text: "hi" }], "end_turn", "claude-opus-4-1"),
    );
    expect(response.modelVersion).toBe("claude-opus-4-1");
  });

  it("streaming: the final response carries message_start's model", () => {
    const final = streamTurn([
      start("claude-haiku-4-5"),
      ...textBlock("hi"),
      stop("end_turn"),
      END,
    ]);
    expect(final?.response?.modelVersion).toBe("claude-haiku-4-5");
  });

  it("a reused accumulator does not keep the previous turn's model", () => {
    const acc = createAnthropicStreamAccumulator();
    streamTurn([start("m1"), ...textBlock("a"), stop("end_turn"), END], acc);
    const final = streamTurn([...textBlock("b"), stop("end_turn"), END], acc);
    expect(final?.response && "modelVersion" in final.response).toBe(false);
  });
});

describe("final streamed response", () => {
  it("says partial: false", () => {
    const final = streamTurn([
      start(),
      ...textBlock("hi"),
      stop("end_turn"),
      END,
    ]);
    expect(final?.response?.partial).toBe(false);
  });

  it("says partial: false on a malformed tool-call final", () => {
    const final = streamTurn([
      start(),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "f", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      { type: "content_block_stop", index: 0 },
      stop("tool_use"),
      END,
    ] as Anthropic.MessageStreamEvent[]);
    expect(final?.response?.errorCode).toBe(
      FinishReason.MALFORMED_FUNCTION_CALL,
    );
    expect(final?.response?.partial).toBe(false);
  });
});
