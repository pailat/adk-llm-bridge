import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { FinishReason } from "@google/genai";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "../../../../src/providers/anthropic/converters/response.js";

// Helper to create Anthropic Message with required fields
function createMessage(overrides: {
  content: Anthropic.Message["content"];
  usage: { input_tokens: number; output_tokens: number };
  id?: string;
  stop_reason?: Anthropic.Message["stop_reason"];
  stop_sequence?: string | null;
  model?: string;
}): Anthropic.Message {
  return {
    id: overrides.id ?? "msg_123",
    type: "message",
    role: "assistant",
    model: overrides.model ?? "claude-sonnet-4-5-20250929",
    stop_reason: overrides.stop_reason ?? "end_turn",
    stop_sequence: overrides.stop_sequence ?? null,
    content: overrides.content,
    usage: {
      input_tokens: overrides.usage.input_tokens,
      output_tokens: overrides.usage.output_tokens,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

describe("convertAnthropicResponse", () => {
  describe("text response handling", () => {
    it("converts text block to ADK response", () => {
      const message = createMessage({
        content: [{ type: "text", text: "Hello, world!", citations: null }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.content).toBeDefined();
      expect(result.content?.role).toBe("model");
      expect(result.content?.parts).toHaveLength(1);
      expect(result.content?.parts?.[0].text).toBe("Hello, world!");
      expect(result.turnComplete).toBe(true);
    });

    it("includes usage metadata", () => {
      const message = createMessage({
        content: [{ type: "text", text: "Hi", citations: null }],
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.usageMetadata).toBeDefined();
      expect(result.usageMetadata?.promptTokenCount).toBe(100);
      expect(result.usageMetadata?.candidatesTokenCount).toBe(50);
      expect(result.usageMetadata?.totalTokenCount).toBe(150);
    });
  });

  describe("tool use handling", () => {
    it("converts tool_use block to function call", () => {
      const message = createMessage({
        content: [
          {
            type: "tool_use",
            id: "call_456",
            name: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.content?.parts).toHaveLength(1);
      expect(result.content?.parts?.[0].functionCall).toBeDefined();
      expect(result.content?.parts?.[0].functionCall?.id).toBe("call_456");
      expect(result.content?.parts?.[0].functionCall?.name).toBe("get_weather");
      expect(result.content?.parts?.[0].functionCall?.args).toEqual({
        city: "Tokyo",
      });
    });

    it("handles mixed text and tool_use blocks", () => {
      const message = createMessage({
        content: [
          { type: "text", text: "Let me check the weather.", citations: null },
          {
            type: "tool_use",
            id: "call_456",
            name: "get_weather",
            input: { city: "Tokyo" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 30 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.content?.parts).toHaveLength(2);
      expect(result.content?.parts?.[0].text).toBe("Let me check the weather.");
      expect(result.content?.parts?.[1].functionCall?.name).toBe("get_weather");
    });
  });

  describe("edge cases", () => {
    it("handles empty content", () => {
      const message = createMessage({
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.content).toBeUndefined();
      expect(result.turnComplete).toBe(true);
    });
  });

  describe("finishReason mapping (non-stream)", () => {
    function withStop(reason: Anthropic.Message["stop_reason"]) {
      return convertAnthropicResponse(
        createMessage({
          content: [{ type: "text", text: "x", citations: null }],
          stop_reason: reason,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    }

    it("maps end_turn to STOP", () => {
      expect(withStop("end_turn").finishReason).toBe(FinishReason.STOP);
    });

    it("maps max_tokens to MAX_TOKENS", () => {
      expect(withStop("max_tokens").finishReason).toBe(FinishReason.MAX_TOKENS);
    });

    it("maps tool_use to STOP", () => {
      expect(withStop("tool_use").finishReason).toBe(FinishReason.STOP);
    });

    it("maps refusal to SAFETY", () => {
      expect(withStop("refusal").finishReason).toBe(FinishReason.SAFETY);
    });
  });
});

describe("createAnthropicStreamAccumulator", () => {
  it("creates empty accumulator", () => {
    const acc = createAnthropicStreamAccumulator();

    expect(acc.text).toBe("");
    expect(acc.toolUses.size).toBe(0);
    expect(acc.currentBlockIndex).toBe(-1);
    expect(acc.inputTokens).toBeUndefined();
    expect(acc.outputTokens).toBeUndefined();
  });
});

describe("convertAnthropicStreamEvent", () => {
  describe("text streaming", () => {
    it("handles text_delta events", () => {
      const acc = createAnthropicStreamAccumulator();
      const event: Anthropic.MessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(false);
      expect(result.response?.content?.parts?.[0].text).toBe("Hello");
      expect(result.response?.partial).toBe(true);
      expect(acc.text).toBe("Hello");
    });

    it("accumulates text across multiple deltas", () => {
      const acc = createAnthropicStreamAccumulator();

      convertAnthropicStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello" },
        },
        acc,
      );

      convertAnthropicStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: ", world!" },
        },
        acc,
      );

      expect(acc.text).toBe("Hello, world!");
    });
  });

  describe("tool use streaming", () => {
    it("handles content_block_start for tool_use", () => {
      const acc = createAnthropicStreamAccumulator();
      const event: Anthropic.MessageStreamEvent = {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_123",
          name: "get_weather",
          input: {},
        },
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(false);
      expect(acc.toolUses.get(0)).toBeDefined();
      expect(acc.toolUses.get(0)?.id).toBe("call_123");
      expect(acc.toolUses.get(0)?.name).toBe("get_weather");
    });

    it("handles input_json_delta events", () => {
      const acc = createAnthropicStreamAccumulator();

      // First, start the tool use block
      convertAnthropicStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "call_123",
            name: "get_weather",
            input: {},
          },
        },
        acc,
      );

      // Then receive JSON delta
      const event: Anthropic.MessageStreamEvent = {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: '{"city": "Tokyo"}',
        },
      };

      convertAnthropicStreamEvent(event, acc);

      expect(acc.toolUses.get(0)?.input).toBe('{"city": "Tokyo"}');
    });
  });

  describe("message_stop handling", () => {
    it("returns complete response with accumulated text", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.text = "Hello, world!";

      const event: Anthropic.MessageStreamEvent = {
        type: "message_stop",
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(true);
      expect(result.response?.turnComplete).toBe(true);
      expect(result.response?.content?.parts?.[0].text).toBe("Hello, world!");
    });

    it("returns complete response with accumulated tool calls", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.toolUses.set(0, {
        id: "call_123",
        name: "get_weather",
        input: '{"city":"Tokyo"}',
      });

      const event: Anthropic.MessageStreamEvent = {
        type: "message_stop",
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(true);
      expect(result.response?.content?.parts?.[0].functionCall).toBeDefined();
      expect(result.response?.content?.parts?.[0].functionCall?.name).toBe(
        "get_weather",
      );
      expect(result.response?.content?.parts?.[0].functionCall?.args).toEqual({
        city: "Tokyo",
      });
    });

    it("clears accumulator after message_stop", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.text = "Hello";
      acc.toolUses.set(0, { id: "call_123", name: "test", input: "{}" });

      convertAnthropicStreamEvent({ type: "message_stop" }, acc);

      expect(acc.text).toBe("");
      expect(acc.toolUses.size).toBe(0);
    });
  });

  describe("message_start handling", () => {
    it("captures input_tokens from message_start event", () => {
      const acc = createAnthropicStreamAccumulator();
      const event: Anthropic.MessageStreamEvent = {
        type: "message_start",
        message: createMessage({
          content: [],
          stop_reason: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        }),
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(false);
      expect(result.response).toBeUndefined();
      expect(acc.inputTokens).toBe(100);
    });
  });

  describe("message_delta handling", () => {
    it("captures output_tokens from message_delta event", () => {
      const acc = createAnthropicStreamAccumulator();
      const event: Anthropic.MessageStreamEvent = {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 50,
          input_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          server_tool_use: null,
        },
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(false);
      expect(acc.outputTokens).toBe(50);
    });
  });

  describe("usage metadata in final response", () => {
    it("includes usage metadata in message_stop response", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.text = "Hello";
      acc.inputTokens = 100;
      acc.outputTokens = 50;

      const event: Anthropic.MessageStreamEvent = {
        type: "message_stop",
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.isComplete).toBe(true);
      expect(result.response?.usageMetadata).toBeDefined();
      expect(result.response?.usageMetadata?.promptTokenCount).toBe(100);
      expect(result.response?.usageMetadata?.candidatesTokenCount).toBe(50);
      expect(result.response?.usageMetadata?.totalTokenCount).toBe(150);
    });

    it("resets usage tokens after message_stop", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.inputTokens = 100;
      acc.outputTokens = 50;

      convertAnthropicStreamEvent({ type: "message_stop" }, acc);

      expect(acc.inputTokens).toBeUndefined();
      expect(acc.outputTokens).toBeUndefined();
    });

    it("omits usage metadata when no tokens captured", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.text = "Hello";

      const event: Anthropic.MessageStreamEvent = {
        type: "message_stop",
      };

      const result = convertAnthropicStreamEvent(event, acc);

      expect(result.response?.usageMetadata).toBeUndefined();
    });
  });

  describe("finishReason mapping (stream)", () => {
    it("captures stop_reason from message_delta and emits it on message_stop", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.text = "done";

      convertAnthropicStreamEvent(
        {
          type: "message_delta",
          delta: { stop_reason: "max_tokens", stop_sequence: null },
          usage: {
            output_tokens: 5,
            input_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        },
        acc,
      );

      const result = convertAnthropicStreamEvent({ type: "message_stop" }, acc);

      expect(result.response?.finishReason).toBe(FinishReason.MAX_TOKENS);
      expect(acc.stopReason).toBeUndefined();
    });

    it("maps tool_use stop_reason to STOP", () => {
      const acc = createAnthropicStreamAccumulator();
      acc.toolUses.set(0, {
        id: "c1",
        name: "get_weather",
        input: "{}",
      });

      convertAnthropicStreamEvent(
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: {
            output_tokens: 5,
            input_tokens: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            server_tool_use: null,
          },
        },
        acc,
      );

      const result = convertAnthropicStreamEvent({ type: "message_stop" }, acc);
      expect(result.response?.finishReason).toBe(FinishReason.STOP);
    });
  });

  describe("extended thinking (non-streaming)", () => {
    it("converts a thinking block to a thought part with signature", () => {
      const message = createMessage({
        content: [
          {
            type: "thinking",
            thinking: "Let me reason about this...",
            signature: "sig-abc-123",
          },
          { type: "text", text: "The answer is 42.", citations: null },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

      const result = convertAnthropicResponse(message);

      expect(result.content?.parts).toHaveLength(2);
      const thought = result.content?.parts?.[0];
      expect(thought?.thought).toBe(true);
      expect(thought?.text).toBe("Let me reason about this...");
      expect(thought?.thoughtSignature).toBe("sig-abc-123");
      expect(result.content?.parts?.[1].text).toBe("The answer is 42.");
    });

    it("converts a redacted_thinking block to a thought part carrying data", () => {
      const message = createMessage({
        content: [
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "Done.", citations: null },
        ],
        usage: { input_tokens: 5, output_tokens: 5 },
      });

      const result = convertAnthropicResponse(message);

      const thought = result.content?.parts?.[0];
      expect(thought?.thought).toBe(true);
      expect(thought?.thoughtSignature).toBe("encrypted-blob");
      expect(thought?.text).toBeUndefined();
    });
  });

  describe("extended thinking (streaming)", () => {
    it("emits a partial thought part for thinking_delta and assembles signature", () => {
      const acc = createAnthropicStreamAccumulator();

      convertAnthropicStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        acc,
      );

      const deltaResult = convertAnthropicStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Step 1..." },
        },
        acc,
      );

      const part = deltaResult.response?.content?.parts?.[0];
      expect(deltaResult.response?.partial).toBe(true);
      expect(part?.thought).toBe(true);
      expect(part?.text).toBe("Step 1...");

      convertAnthropicStreamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-xyz" },
        },
        acc,
      );

      expect(acc.thinkingBlocks.get(0)?.thinking).toBe("Step 1...");
      expect(acc.thinkingBlocks.get(0)?.signature).toBe("sig-xyz");

      const final = convertAnthropicStreamEvent({ type: "message_stop" }, acc);
      const thought = final.response?.content?.parts?.[0];
      expect(thought?.thought).toBe(true);
      expect(thought?.text).toBe("Step 1...");
      expect(thought?.thoughtSignature).toBe("sig-xyz");
      expect(acc.thinkingBlocks.size).toBe(0);
    });

    it("emits a partial thought for a redacted_thinking content_block_start", () => {
      const acc = createAnthropicStreamAccumulator();

      const result = convertAnthropicStreamEvent(
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "redacted_thinking", data: "enc-blob" },
        },
        acc,
      );

      const part = result.response?.content?.parts?.[0];
      expect(result.response?.partial).toBe(true);
      expect(part?.thought).toBe(true);
      expect(part?.thoughtSignature).toBe("enc-blob");
    });
  });
});

describe("structured output (json_output synthetic tool)", () => {
  it("non-streaming: json_output tool_use surfaces as TEXT, not functionCall", () => {
    const message = createMessage({
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "json_output",
          input: { city: "Tokyo", temp: 21 },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = convertAnthropicResponse(message);

    expect(result.content?.parts).toHaveLength(1);
    expect(result.content?.parts?.[0].functionCall).toBeUndefined();
    expect(result.content?.parts?.[0].text).toBe(
      JSON.stringify({ city: "Tokyo", temp: 21 }),
    );
    expect(JSON.parse(result.content?.parts?.[0].text as string)).toEqual({
      city: "Tokyo",
      temp: 21,
    });
  });

  it("non-streaming: a REAL tool still emits a functionCall (regression guard)", () => {
    const message = createMessage({
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "Tokyo" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = convertAnthropicResponse(message);

    expect(result.content?.parts?.[0].functionCall?.name).toBe("get_weather");
    expect(result.content?.parts?.[0].text).toBeUndefined();
  });

  it("streaming: json_output tool surfaces as TEXT at message_stop", () => {
    const acc = createAnthropicStreamAccumulator();
    acc.toolUses.set(0, { id: "c1", name: "json_output", input: '{"answer":42}' });

    const result = convertAnthropicStreamEvent({ type: "message_stop" }, acc);

    expect(result.isComplete).toBe(true);
    const part = result.response?.content?.parts?.[0];
    expect(part?.functionCall).toBeUndefined();
    expect(JSON.parse(part?.text as string)).toEqual({ answer: 42 });
  });

  it("streaming: real tool still emits functionCall at message_stop (regression guard)", () => {
    const acc = createAnthropicStreamAccumulator();
    acc.toolUses.set(0, {
      id: "c1",
      name: "get_weather",
      input: '{"city":"Tokyo"}',
    });

    const result = convertAnthropicStreamEvent({ type: "message_stop" }, acc);

    expect(result.response?.content?.parts?.[0].functionCall?.name).toBe(
      "get_weather",
    );
    expect(result.response?.content?.parts?.[0].text).toBeUndefined();
  });

  it("produces ADK-parseable JSON text with no functionCall (outputKey contract)", () => {
    const message = createMessage({
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "json_output",
          input: { a: 1, b: "two" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = convertAnthropicResponse(message);
    const parts = result.content?.parts ?? [];

    // isFinalResponse would be true: no functionCall parts present.
    expect(parts.every((p) => p.functionCall === undefined)).toBe(true);
    // maybeSaveOutputToState reads parts.map(p=>p.text).join("") and JSON.parses.
    const resultStr = parts.map((p) => p.text ?? "").join("");
    expect(() => JSON.parse(resultStr)).not.toThrow();
    expect(JSON.parse(resultStr)).toEqual({ a: 1, b: "two" });
  });
});
