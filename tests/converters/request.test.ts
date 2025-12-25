import { describe, expect, it } from "bun:test";
import type { LlmRequest } from "@google/adk";
import { convertRequest } from "../../src/converters/request";

function createLlmRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

describe("convertRequest", () => {
  describe("system instruction", () => {
    it("converts string system instruction", () => {
      const request = createLlmRequest({
        config: { systemInstruction: "You are helpful." },
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({
        role: "system",
        content: "You are helpful.",
      });
    });

    it("handles missing system instruction", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({ role: "user", content: "Hello" });
    });
  });

  describe("user messages", () => {
    it("converts user text content", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello!" }] }],
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({ role: "user", content: "Hello!" });
    });

    it("concatenates multiple text parts", () => {
      const request = createLlmRequest({
        contents: [
          { role: "user", parts: [{ text: "First." }, { text: "Second." }] },
        ],
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({
        role: "user",
        content: "First.\nSecond.",
      });
    });
  });

  describe("model/assistant messages", () => {
    it("converts model role to assistant", () => {
      const request = createLlmRequest({
        contents: [{ role: "model", parts: [{ text: "Hello!" }] }],
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({
        role: "assistant",
        content: "Hello!",
      });
    });

    it("converts function call", () => {
      const request = createLlmRequest({
        contents: [
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

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      });
    });
  });

  describe("function responses", () => {
    it("converts to tool message", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call_789",
                  name: "get_weather",
                  response: { temperature: 22 },
                },
              },
            ],
          },
        ],
      });

      const result = convertRequest(request);

      expect(result.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "call_789",
        content: '{"temperature":22}',
      });
    });
  });

  describe("tools conversion", () => {
    it("converts function declarations", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get weather",
                  parameters: { type: "object", properties: {} } as Record<
                    string,
                    unknown
                  >,
                },
              ],
            },
          ],
        },
      });

      const result = convertRequest(request);

      expect(result.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ]);
    });

    it("returns undefined when no tools", () => {
      const request = createLlmRequest({ contents: [] });
      const result = convertRequest(request);
      expect(result.tools).toBeUndefined();
    });
  });
});
