import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { LlmRequest } from "@google/adk";
import { FunctionCallingConfigMode, type Schema } from "@google/genai";
import {
  applyAnthropicPromptCaching,
  convertAnthropicGenerationConfig,
  convertAnthropicRequest,
  convertAnthropicStructuredOutput,
  convertAnthropicToolChoice,
} from "../../../../src/providers/anthropic/converters/request";

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

  describe("generation config", () => {
    it("maps sampling fields and clamps temperature >1 to 1", () => {
      // top_p is dropped because temperature is set (Anthropic rejects both
      // together); top_k is preserved. See sampling-reconciliation tests below.
      const request = createLlmRequest({
        config: {
          temperature: 1.5,
          topP: 0.8,
          topK: 40,
          maxOutputTokens: 512,
          stopSequences: ["STOP"],
        },
      });

      expect(convertAnthropicGenerationConfig(request)).toEqual({
        temperature: 1,
        top_k: 40,
        max_tokens: 512,
        stop_sequences: ["STOP"],
      });
    });

    it("does not clamp temperature <=1", () => {
      const request = createLlmRequest({ config: { temperature: 0.6 } });
      expect(convertAnthropicGenerationConfig(request)).toEqual({
        temperature: 0.6,
      });
    });

    it("drops seed/penalties/candidateCount", () => {
      const request = createLlmRequest({
        config: {
          temperature: 0.5,
          seed: 1,
          presencePenalty: 0.2,
          frequencyPenalty: 0.2,
          candidateCount: 3,
        },
      });
      expect(convertAnthropicGenerationConfig(request)).toEqual({
        temperature: 0.5,
      });
    });

    it("returns undefined when no sampling fields set", () => {
      expect(
        convertAnthropicGenerationConfig(createLlmRequest({ config: {} })),
      ).toBeUndefined();
    });

    it("exposes params on the converted request", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        config: { maxOutputTokens: 128 },
      });
      expect(convertAnthropicRequest(request).params).toEqual({
        max_tokens: 128,
      });
    });

    it("omits max_tokens when maxOutputTokens is 0 (Anthropic rejects <1)", () => {
      const request = createLlmRequest({
        config: { maxOutputTokens: 0, temperature: 0.5 },
      });
      expect(convertAnthropicGenerationConfig(request)).toEqual({
        temperature: 0.5,
      });
    });

    it("returns undefined when maxOutputTokens 0 is the only field", () => {
      const request = createLlmRequest({ config: { maxOutputTokens: 0 } });
      expect(convertAnthropicGenerationConfig(request)).toBeUndefined();
    });

    it("omits negative maxOutputTokens", () => {
      const request = createLlmRequest({
        config: { maxOutputTokens: -5, temperature: 0.5 },
      });
      expect(convertAnthropicGenerationConfig(request)).toEqual({
        temperature: 0.5,
      });
    });

    it("preserves maxOutputTokens of 1 (boundary)", () => {
      const request = createLlmRequest({ config: { maxOutputTokens: 1 } });
      expect(convertAnthropicGenerationConfig(request)).toEqual({
        max_tokens: 1,
      });
    });
  });

  describe("extended thinking", () => {
    it("emits thinking param with the configured budget", () => {
      const request = createLlmRequest({
        config: {
          thinkingConfig: { includeThoughts: true, thinkingBudget: 4096 },
        },
      });

      expect(convertAnthropicGenerationConfig(request)?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 4096,
      });
    });

    it("falls back to the minimum budget (1024) when none/too-small is given", () => {
      const noBudget = createLlmRequest({
        config: { thinkingConfig: { includeThoughts: true } },
      });
      expect(convertAnthropicGenerationConfig(noBudget)?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 1024,
      });

      const tooSmall = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 100 } },
      });
      expect(convertAnthropicGenerationConfig(tooSmall)?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 1024,
      });
    });

    it("does not emit thinking when thinkingConfig is absent", () => {
      const request = createLlmRequest({ config: { temperature: 0.5 } });
      expect(
        convertAnthropicGenerationConfig(request)?.thinking,
      ).toBeUndefined();
    });

    it("does not emit thinking when thinkingBudget is 0 (disabled)", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });
      expect(
        convertAnthropicGenerationConfig(request)?.thinking,
      ).toBeUndefined();
    });

    it("does not emit thinking when thinkingBudget is negative (disabled)", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: -1 } },
      });
      expect(
        convertAnthropicGenerationConfig(request)?.thinking,
      ).toBeUndefined();
    });
  });

  describe("sampling reconciliation (combinations Anthropic rejects)", () => {
    it("thinking on + temperature drops a non-1 temperature (omits it)", () => {
      const request = createLlmRequest({
        config: {
          temperature: 0.5,
          thinkingConfig: { includeThoughts: true, thinkingBudget: 2048 },
        },
      });
      const params = convertAnthropicGenerationConfig(request);
      expect(params?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 2048,
      });
      expect(params).not.toHaveProperty("temperature");
    });

    it("thinking on + temperature===1 keeps temperature", () => {
      const request = createLlmRequest({
        config: {
          temperature: 1,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      });
      const params = convertAnthropicGenerationConfig(request);
      expect(params?.temperature).toBe(1);
    });

    it("thinking on drops top_p and top_k entirely", () => {
      const request = createLlmRequest({
        config: {
          topP: 0.9,
          topK: 40,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      });
      const params = convertAnthropicGenerationConfig(request);
      expect(params).not.toHaveProperty("top_p");
      expect(params).not.toHaveProperty("top_k");
      expect(params?.thinking).toEqual({
        type: "enabled",
        budget_tokens: 2048,
      });
    });

    it("temperature + top_p (no thinking): keeps temperature, drops top_p", () => {
      const request = createLlmRequest({
        config: { temperature: 0.7, topP: 0.9 },
      });
      const params = convertAnthropicGenerationConfig(request);
      expect(params?.temperature).toBe(0.7);
      expect(params).not.toHaveProperty("top_p");
    });

    it("top_p alone (no temperature, no thinking) is preserved", () => {
      const request = createLlmRequest({ config: { topP: 0.9 } });
      const params = convertAnthropicGenerationConfig(request);
      expect(params?.top_p).toBe(0.9);
      expect(params).not.toHaveProperty("temperature");
    });

    it("top_k alone (no thinking) is preserved", () => {
      const request = createLlmRequest({ config: { topK: 40 } });
      expect(convertAnthropicGenerationConfig(request)?.top_k).toBe(40);
    });
  });

  describe("tool choice", () => {
    it("maps AUTO to {type:'auto'}", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        },
      });
      expect(convertAnthropicToolChoice(request)).toEqual({ type: "auto" });
    });

    it("maps ANY to {type:'any'}", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      });
      expect(convertAnthropicToolChoice(request)).toEqual({ type: "any" });
    });

    it("maps NONE to {type:'none'}", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
          },
        },
      });
      expect(convertAnthropicToolChoice(request)).toEqual({ type: "none" });
    });

    it("maps ANY with single allowedFunctionName to {type:'tool',name}", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: ["get_weather"],
            },
          },
        },
      });
      expect(convertAnthropicToolChoice(request)).toEqual({
        type: "tool",
        name: "get_weather",
      });
    });

    it("returns undefined when no toolConfig", () => {
      expect(
        convertAnthropicToolChoice(createLlmRequest({ config: {} })),
      ).toBeUndefined();
    });
  });

  describe("structured output", () => {
    it("injects a json_output tool + forces tool_choice for responseSchema", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "give json" }] }],
        config: {
          responseSchema: {
            type: "OBJECT",
            properties: { answer: { type: "STRING" } },
          } as Schema,
        },
      });

      const structured = convertAnthropicStructuredOutput(request);
      expect(structured?.tool.name).toBe("json_output");
      expect(structured?.tool.input_schema).toEqual({
        type: "object",
        properties: { answer: { type: "string" } },
      });
      expect(structured?.toolChoice).toEqual({
        type: "tool",
        name: "json_output",
      });

      const result = convertAnthropicRequest(request);
      expect(result.tools?.some((t) => t.name === "json_output")).toBe(true);
      expect(result.toolChoice).toEqual({ type: "tool", name: "json_output" });
    });

    it("returns undefined when no schema", () => {
      expect(
        convertAnthropicStructuredOutput(createLlmRequest({ config: {} })),
      ).toBeUndefined();
    });

    it("respects an explicit tool_choice NONE — does not force json_output", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "give json" }] }],
        config: {
          responseSchema: {
            type: "OBJECT",
            properties: { answer: { type: "STRING" } },
          } as Schema,
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
          },
        },
      });

      const result = convertAnthropicRequest(request);
      // tool_choice none is preserved; the json_output tool is NOT forced.
      expect(result.toolChoice).toEqual({ type: "none" });
      expect(result.tools?.some((t) => t.name === "json_output")).toBeFalsy();
    });

    it("still forces json_output when tool_choice is AUTO", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "give json" }] }],
        config: {
          responseSchema: {
            type: "OBJECT",
            properties: { answer: { type: "STRING" } },
          } as Schema,
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        },
      });

      const result = convertAnthropicRequest(request);
      expect(result.toolChoice).toEqual({ type: "tool", name: "json_output" });
      expect(result.tools?.some((t) => t.name === "json_output")).toBe(true);
    });
  });

  describe("extended-thinking round-trip (processContent re-emits thoughts)", () => {
    it("re-emits a thought part as a thinking block carrying the signature", () => {
      const request = createLlmRequest({
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          {
            role: "model",
            parts: [
              {
                text: "let me reason about this",
                thought: true,
                thoughtSignature: "sig-abc123",
              },
              { text: "Here is the answer." },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      const assistant = result.messages[1];
      expect(assistant.role).toBe("assistant");
      expect(assistant.content).toEqual([
        {
          type: "thinking",
          thinking: "let me reason about this",
          signature: "sig-abc123",
        },
        { type: "text", text: "Here is the answer." },
      ]);
    });

    it("re-emits a redacted thought part (no text) as redacted_thinking", () => {
      const request = createLlmRequest({
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          {
            role: "model",
            parts: [{ thought: true, thoughtSignature: "encrypted-blob" }],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[1].content).toEqual([
        { type: "redacted_thinking", data: "encrypted-blob" },
      ]);
    });

    it("does not re-emit a thought part as plain text (signature preserved)", () => {
      const request = createLlmRequest({
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          {
            role: "model",
            parts: [
              {
                text: "reasoning",
                thought: true,
                thoughtSignature: "sig-xyz",
              },
            ],
          },
        ],
      });

      const blocks = convertAnthropicRequest(request).messages[1]
        .content as Anthropic.ContentBlockParam[];
      // The thinking text must not leak through as a plain text block.
      expect(blocks.some((b) => b.type === "text")).toBe(false);
      expect(blocks[0]).toEqual({
        type: "thinking",
        thinking: "reasoning",
        signature: "sig-xyz",
      });
    });

    it("drops a thought part with no signature (nothing replayable)", () => {
      const request = createLlmRequest({
        contents: [
          { role: "user", parts: [{ text: "hi" }] },
          {
            role: "model",
            parts: [
              { text: "unsigned reasoning", thought: true },
              { text: "the answer" },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[1].content).toEqual([
        { type: "text", text: "the answer" },
      ]);
    });
  });

  describe("prompt caching (opt-in)", () => {
    const tool = (name: string): Anthropic.Tool => ({
      name,
      description: `${name} tool`,
      input_schema: { type: "object", properties: {} },
    });

    it("wraps system into a cacheable text block", () => {
      const result = applyAnthropicPromptCaching("be helpful", undefined);
      expect(result.system).toEqual([
        {
          type: "text",
          text: "be helpful",
          cache_control: { type: "ephemeral" },
        },
      ]);
      expect(result.tools).toBeUndefined();
    });

    it("attaches cache_control only to the last tool", () => {
      const result = applyAnthropicPromptCaching(undefined, [
        tool("first"),
        tool("second"),
      ]);

      expect(result.system).toBeUndefined();
      expect(result.tools).toHaveLength(2);
      // First tool: no cache_control.
      expect(
        (result.tools?.[0] as { cache_control?: unknown }).cache_control,
      ).toBeUndefined();
      // Last tool: cache_control present.
      expect(
        (result.tools?.[1] as { cache_control?: unknown }).cache_control,
      ).toEqual({ type: "ephemeral" });
    });

    it("does not mutate the input tools", () => {
      const tools = [tool("first"), tool("second")];
      applyAnthropicPromptCaching("sys", tools);
      // Original array entries remain untouched.
      expect(
        (tools[1] as { cache_control?: unknown }).cache_control,
      ).toBeUndefined();
    });

    it("returns empty result when no system or tools", () => {
      expect(applyAnthropicPromptCaching(undefined, undefined)).toEqual({});
      expect(applyAnthropicPromptCaching("", [])).toEqual({});
    });

    it("base conversion never emits cache_control (caching is off by default)", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        config: {
          systemInstruction: "be helpful",
          tools: [
            {
              functionDeclarations: [
                { name: "get_weather", description: "weather" },
              ],
            },
          ],
        },
      });

      const result = convertAnthropicRequest(request);
      // System stays a plain string; tools carry no cache_control.
      expect(typeof result.system).toBe("string");
      expect(
        (result.tools?.[0] as { cache_control?: unknown }).cache_control,
      ).toBeUndefined();
    });
  });

  describe("multimodal input", () => {
    it("maps inlineData image to a base64 image block", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              { text: "what is this" },
              { inlineData: { mimeType: "image/png", data: "AAAA" } },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[0].content).toEqual([
        { type: "text", text: "what is this" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
      ]);
    });

    it("maps inlineData application/pdf to a base64 document block", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "application/pdf", data: "JVBE" } },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[0].content).toEqual([
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "JVBE",
          },
        },
      ]);
    });

    it("maps http fileData image to a url image block", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "image/jpeg",
                  fileUri: "https://example.com/c.jpg",
                },
              },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[0].content).toEqual([
        {
          type: "image",
          source: { type: "url", url: "https://example.com/c.jpg" },
        },
      ]);
    });

    it("drops gs:// fileData URIs", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              { text: "hi" },
              {
                fileData: {
                  mimeType: "image/png",
                  fileUri: "gs://bucket/img.png",
                },
              },
            ],
          },
        ],
      });

      const result = convertAnthropicRequest(request);
      expect(result.messages[0].content).toEqual([
        { type: "text", text: "hi" },
      ]);
    });
  });

  describe("Gemini-only built-in tools", () => {
    function withConsoleWarn<T>(fn: () => T): { result: T; warns: string[] } {
      const warns: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      };
      try {
        const result = fn();
        return { result, warns };
      } finally {
        console.warn = original;
      }
    }

    it("skips a googleSearch tool group and warns once", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [{ googleSearch: {} } as unknown as Record<string, unknown>],
        },
      });

      const { result, warns } = withConsoleWarn(() =>
        convertAnthropicRequest(request),
      );

      expect(result.tools).toBeUndefined();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("googleSearch");
    });

    it("keeps functionDeclarations while dropping a built-in", () => {
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
            { codeExecution: {} } as unknown as Record<string, unknown>,
          ],
        },
      });

      const { result, warns } = withConsoleWarn(() =>
        convertAnthropicRequest(request),
      );

      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].name).toBe("get_weather");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("codeExecution");
    });
  });

  describe("Gemini-only config fields never leak into the body", () => {
    it("never forwards safetySettings / responseModalities / cachedContent / labels / routingConfig", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: {
          temperature: 0.5,
          maxOutputTokens: 100,
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          ],
          responseModalities: ["TEXT"],
          cachedContent: "cachedContents/abc123",
          labels: { team: "research" },
          routingConfig: { autoMode: { modelRoutingPreference: "BALANCED" } },
        } as unknown as LlmRequest["config"],
      });

      const result = convertAnthropicRequest(request);
      const body = {
        ...result.params,
        ...(result.tools ? { tools: result.tools } : {}),
        ...(result.system ? { system: result.system } : {}),
      };

      expect(result.params).toEqual({ temperature: 0.5, max_tokens: 100 });

      for (const forbidden of [
        "safetySettings",
        "safety_settings",
        "responseModalities",
        "response_modalities",
        "cachedContent",
        "cached_content",
        "labels",
        "routingConfig",
        "routing_config",
      ]) {
        expect(body).not.toHaveProperty(forbidden);
        expect(result.params ?? {}).not.toHaveProperty(forbidden);
      }
    });
  });
});
