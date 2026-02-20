import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "../../../../src/providers/anthropic/converters/response";

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

    it("preserves large integer IDs as strings in streamed tool call arguments", () => {
      // Anthropic streaming sends raw JSON fragments via input_json_delta.
      // Claude may emit the number without quotes even when schema says "type": "string".
      // A 19-digit ID exceeds Number.MAX_SAFE_INTEGER and would be rounded by JSON.parse.
      const zohoTicketId = "1021987000032211189";
      const acc = createAnthropicStreamAccumulator();
      acc.toolUses.set(0, {
        id: "call_456",
        name: "get_ticket",
        input: `{"ticketId": ${zohoTicketId}}`,
      });

      const result = convertAnthropicStreamEvent({ type: "message_stop" }, acc);

      const args = result.response?.content?.parts?.[0]?.functionCall?.args;
      expect(args?.ticketId).toBe(zohoTicketId);
      expect(typeof args?.ticketId).toBe("string");
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
});
