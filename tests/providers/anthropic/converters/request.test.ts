import { describe, expect, it } from "bun:test";
import type { LlmRequest } from "@google/adk";
import type { Schema } from "@google/genai";
import { convertAnthropicRequest } from "../../../../src/providers/anthropic/converters/request";

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

describe("convertAnthropicRequest", () => {
  describe("basic message conversion", () => {
    it("converts simple user message", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello, Claude!" }],
          },
        ],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toEqual([
        { type: "text", text: "Hello, Claude!" },
      ]);
    });

    it("converts model response to assistant role", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
          {
            role: "model",
            parts: [{ text: "Hi there!" }],
          },
        ],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].role).toBe("assistant");
    });
  });

  describe("system instruction handling", () => {
    it("extracts system instruction as separate field", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        config: {
          systemInstruction: "You are a helpful assistant.",
        },
      });

      const result = convertAnthropicRequest(request);

      expect(result.system).toBe("You are a helpful assistant.");
      expect(result.messages).toHaveLength(1);
    });

    it("handles system instruction as Content object", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "Hello" }],
          },
        ],
        config: {
          systemInstruction: {
            role: "user",
            parts: [{ text: "You are helpful." }, { text: "Be concise." }],
          },
        },
      });

      const result = convertAnthropicRequest(request);

      expect(result.system).toBe("You are helpful.\nBe concise.");
    });
  });

  describe("tool handling", () => {
    it("converts function declarations to Anthropic tools", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "What's the weather?" }],
          },
        ],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get current weather",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      city: { type: "STRING" },
                    },
                    required: ["city"],
                  } as Schema,
                },
              ],
            },
          ],
        },
      });

      const result = convertAnthropicRequest(request);

      expect(result.tools).toBeDefined();
      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].name).toBe("get_weather");
      expect(result.tools?.[0].description).toBe("Get current weather");
      expect(result.tools?.[0].input_schema).toEqual({
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
      });
    });

    it("normalizes UPPERCASE types to lowercase", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "test" }] }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "test",
                  description: "Test function",
                  parameters: {
                    type: "OBJECT",
                    properties: {
                      name: { type: "STRING" },
                      count: { type: "INTEGER" },
                      active: { type: "BOOLEAN" },
                      items: { type: "ARRAY" },
                    },
                  } as Schema,
                },
              ],
            },
          ],
        },
      });

      const result = convertAnthropicRequest(request);

      const schema = result.tools?.[0].input_schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      const props = schema.properties as Record<string, { type: string }>;
      expect(props.name.type).toBe("string");
      expect(props.count.type).toBe("integer");
      expect(props.active.type).toBe("boolean");
      expect(props.items.type).toBe("array");
    });
  });

  describe("function call handling", () => {
    it("converts function calls to tool_use blocks", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [{ text: "What's the weather in Tokyo?" }],
          },
          {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call_123",
                  name: "get_weather",
                  args: { city: "Tokyo" },
                },
              },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[1].content).toEqual([
        {
          type: "tool_use",
          id: "call_123",
          name: "get_weather",
          input: { city: "Tokyo" },
        },
      ]);
    });

    it("converts function responses to tool_result blocks", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_123",
                  response: { temperature: 25, condition: "sunny" },
                },
              },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages[0].content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: '{"temperature":25,"condition":"sunny"}',
        },
      ]);
    });
  });

  describe("edge cases", () => {
    it("handles empty contents", () => {
      const request = createLlmRequest({
        contents: [],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages).toHaveLength(0);
    });

    it("adds placeholder user message if first message is assistant", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "model",
            parts: [{ text: "Hello!" }],
          },
        ],
      });

      const result = convertAnthropicRequest(request);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content).toBe(
        "[System: Continue conversation]",
      );
      expect(result.messages[1].role).toBe("assistant");
    });

    it("returns undefined for tools when none provided", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      });

      const result = convertAnthropicRequest(request);

      expect(result.tools).toBeUndefined();
    });
  });
});
