import { describe, expect, it, spyOn } from "bun:test";
import type { LlmRequest } from "@google/adk";
import { FunctionCallingConfigMode } from "@google/genai";
import {
  convertGenerationConfig,
  convertLogprobsConfig,
  convertReasoningConfig,
  convertRequest,
  convertStructuredOutput,
  convertToolChoice,
} from "../../src/converters/request.js";

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

    it("drops image parts on a model/assistant turn and warns", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const request = createLlmRequest({
          contents: [
            {
              role: "model",
              parts: [
                { text: "Here is the image" },
                { inlineData: { mimeType: "image/png", data: "AAAA" } },
              ],
            },
          ],
        });

        const result = convertRequest(request);

        // Assistant message keeps text only; the image is dropped.
        expect(result.messages[0]).toEqual({
          role: "assistant",
          content: "Here is the image",
        });
        const warned = warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("dropping image part"),
        );
        expect(warned).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("keeps image parts on a user turn (regression guard)", () => {
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const request = createLlmRequest({
          contents: [
            {
              role: "user",
              parts: [
                { text: "What is this?" },
                { inlineData: { mimeType: "image/png", data: "AAAA" } },
              ],
            },
          ],
        });

        const result = convertRequest(request);

        expect(result.messages[0]).toEqual({
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        });
        const warned = warnSpy.mock.calls.some((c) =>
          String(c[0]).includes("dropping image part"),
        );
        expect(warned).toBe(false);
      } finally {
        warnSpy.mockRestore();
      }
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

    it("skips function declarations with empty name", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "",
                  description: "No name tool",
                  parameters: { type: "object", properties: {} } as Record<
                    string,
                    unknown
                  >,
                },
                {
                  name: "valid_tool",
                  description: "Has a name",
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

      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].function.name).toBe("valid_tool");
    });

    it("skips function declarations with undefined name", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  description: "No name at all",
                  parameters: { type: "object", properties: {} } as Record<
                    string,
                    unknown
                  >,
                } as unknown as {
                  name: string;
                  description: string;
                  parameters: Record<string, unknown>;
                },
              ],
            },
          ],
        },
      });

      const result = convertRequest(request);

      expect(result.tools).toBeUndefined();
    });
  });

  describe("generation config", () => {
    it("maps each sampling field to its OpenAI key", () => {
      const request = createLlmRequest({
        config: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 256,
          stopSequences: ["END"],
          seed: 42,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3,
          candidateCount: 2,
        },
      });

      expect(convertGenerationConfig(request)).toEqual({
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 256,
        stop: ["END"],
        seed: 42,
        presence_penalty: 0.5,
        frequency_penalty: 0.3,
        n: 2,
      });
    });

    it("drops topK (no OpenAI equivalent)", () => {
      const request = createLlmRequest({
        config: { temperature: 0.5, topK: 40 },
      });

      const result = convertGenerationConfig(request);
      expect(result).toEqual({ temperature: 0.5 });
      expect(result).not.toHaveProperty("top_k");
    });

    it("omits undefined fields", () => {
      const request = createLlmRequest({ config: { temperature: 0.2 } });
      expect(convertGenerationConfig(request)).toEqual({ temperature: 0.2 });
    });

    it("returns empty object for empty config", () => {
      expect(convertGenerationConfig(createLlmRequest({ config: {} }))).toEqual(
        {},
      );
      expect(convertGenerationConfig(createLlmRequest({}))).toEqual({});
    });

    it("folds generation params into convertRequest result", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: { temperature: 0.1, maxOutputTokens: 10 },
      });

      const result = convertRequest(request);
      expect(result.params).toEqual({ temperature: 0.1, max_tokens: 10 });
    });

    it("leaves params undefined when no config fields are set", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      });
      expect(convertRequest(request).params).toBeUndefined();
    });
  });

  describe("tool choice", () => {
    it("maps AUTO to 'auto'", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
          },
        },
      });
      expect(convertToolChoice(request)).toBe("auto");
    });

    it("maps NONE to 'none'", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
          },
        },
      });
      expect(convertToolChoice(request)).toBe("none");
    });

    it("maps ANY to 'required'", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      });
      expect(convertToolChoice(request)).toBe("required");
    });

    it("maps VALIDATED to 'required'", () => {
      const request = createLlmRequest({
        config: {
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.VALIDATED,
            },
          },
        },
      });
      expect(convertToolChoice(request)).toBe("required");
    });

    it("maps ANY with single allowedFunctionName to a function tool_choice", () => {
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
      expect(convertToolChoice(request)).toEqual({
        type: "function",
        function: { name: "get_weather" },
      });
    });

    it("returns undefined when no toolConfig present", () => {
      expect(
        convertToolChoice(createLlmRequest({ config: {} })),
      ).toBeUndefined();
    });
  });

  describe("structured output", () => {
    it("maps responseSchema to a normalized json_schema response_format", () => {
      const request = createLlmRequest({
        config: {
          responseSchema: {
            type: "OBJECT",
            properties: { answer: { type: "STRING" } },
          },
        },
      });

      expect(convertStructuredOutput(request)).toEqual({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "response",
            strict: false,
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
            },
          },
        },
      });
    });

    it("maps responseMimeType only to json_object", () => {
      const request = createLlmRequest({
        config: { responseMimeType: "application/json" },
      });

      expect(convertStructuredOutput(request)).toEqual({
        response_format: { type: "json_object" },
      });
    });

    it("passes responseJsonSchema through unchanged", () => {
      const schema = {
        type: "object",
        properties: { x: { type: "number" } },
      };
      const request = createLlmRequest({
        config: { responseJsonSchema: schema },
      });

      expect(convertStructuredOutput(request)).toEqual({
        response_format: {
          type: "json_schema",
          json_schema: { name: "response", strict: false, schema },
        },
      });
    });

    it("returns empty object when no structured output config", () => {
      expect(convertStructuredOutput(createLlmRequest({ config: {} }))).toEqual(
        {},
      );
    });
  });

  describe("multimodal input", () => {
    it("maps inlineData image to an image_url data URL content part", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              { text: "What is this?" },
              {
                inlineData: { mimeType: "image/png", data: "AAAA" },
              },
            ],
          },
        ],
      });

      const result = convertRequest(request);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA" },
          },
        ],
      });
    });

    it("maps http fileData image to an image_url url content part", () => {
      const request = createLlmRequest({
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: "image/jpeg",
                  fileUri: "https://example.com/cat.jpg",
                },
              },
            ],
          },
        ],
      });

      const result = convertRequest(request);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/cat.jpg" },
          },
        ],
      });
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

      const result = convertRequest(request);
      // No image present -> falls back to string content path.
      expect(result.messages[0]).toEqual({ role: "user", content: "hi" });
    });

    it("keeps text-only path as string content (back-compat)", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "plain text" }] }],
      });

      const result = convertRequest(request);
      expect(result.messages[0]).toEqual({
        role: "user",
        content: "plain text",
      });
    });
  });

  describe("reasoning_effort (thinkingConfig)", () => {
    it("does NOT emit reasoning_effort when thinkingConfig is absent", () => {
      const request = createLlmRequest({ config: { temperature: 0.5 } });
      const result = convertRequest(request);
      expect(result.params?.reasoning_effort).toBeUndefined();
    });

    it("defaults to medium when thinkingConfig is set without a budget", () => {
      const request = createLlmRequest({ config: { thinkingConfig: {} } });
      const result = convertRequest(request);
      expect(result.params?.reasoning_effort).toBe("medium");
    });

    it("maps a small budget to low", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 1000 } },
      });
      expect(convertReasoningConfig(request)).toEqual({
        reasoning_effort: "low",
      });
    });

    it("maps a mid budget to medium", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 4096 } },
      });
      expect(convertReasoningConfig(request)).toEqual({
        reasoning_effort: "medium",
      });
    });

    it("maps a large budget to high", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 20000 } },
      });
      expect(convertReasoningConfig(request)).toEqual({
        reasoning_effort: "high",
      });
    });

    it("emits nothing when the budget disables thinking (<= 0)", () => {
      const request = createLlmRequest({
        config: { thinkingConfig: { thinkingBudget: 0 } },
      });
      expect(convertReasoningConfig(request)).toEqual({});
    });

    it("emits nothing when there is no config at all", () => {
      expect(convertReasoningConfig(createLlmRequest({}))).toEqual({});
    });
  });

  describe("provider API combination gating (model-aware)", () => {
    describe("max_tokens vs max_completion_tokens", () => {
      it("emits max_completion_tokens for gpt-5 reasoning models", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 256 },
        });
        const result = convertGenerationConfig(request, "gpt-5");
        expect(result.max_completion_tokens).toBe(256);
        expect(result).not.toHaveProperty("max_tokens");
      });

      it("emits max_completion_tokens for o-series (o1/o3/o4)", () => {
        for (const model of ["o1", "o1-mini", "o3-mini", "o4-mini"]) {
          const request = createLlmRequest({
            config: { maxOutputTokens: 100 },
          });
          const result = convertGenerationConfig(request, model);
          expect(result.max_completion_tokens).toBe(100);
          expect(result).not.toHaveProperty("max_tokens");
        }
      });

      it("emits max_completion_tokens for provider-prefixed openai/gpt-5", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 64 },
        });
        const result = convertGenerationConfig(request, "openai/gpt-5-mini");
        expect(result.max_completion_tokens).toBe(64);
        expect(result).not.toHaveProperty("max_tokens");
      });

      it("keeps max_tokens for gpt-4.1 (non-reasoning)", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 256 },
        });
        const result = convertGenerationConfig(request, "gpt-4.1");
        expect(result.max_tokens).toBe(256);
        expect(result).not.toHaveProperty("max_completion_tokens");
      });

      it("does NOT mistake gpt-4o for an o-series model", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 256 },
        });
        const result = convertGenerationConfig(request, "gpt-4o");
        expect(result.max_tokens).toBe(256);
        expect(result).not.toHaveProperty("max_completion_tokens");
      });

      it("keeps max_tokens for xAI grok-4", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 512 },
        });
        const result = convertGenerationConfig(request, "grok-4");
        expect(result.max_tokens).toBe(512);
        expect(result).not.toHaveProperty("max_completion_tokens");
      });

      it("keeps max_tokens when no model is supplied (legacy)", () => {
        const request = createLlmRequest({
          config: { maxOutputTokens: 10 },
        });
        expect(convertGenerationConfig(request).max_tokens).toBe(10);
      });
    });

    describe("sampling / penalties / stop dropped for reasoning models", () => {
      it("drops stop / presence_penalty / frequency_penalty / temperature / top_p for gpt-5", () => {
        const request = createLlmRequest({
          config: {
            stopSequences: ["END"],
            presencePenalty: 0.5,
            frequencyPenalty: 0.3,
            temperature: 0.4,
            topP: 0.9,
          },
        });
        const result = convertGenerationConfig(request, "gpt-5");
        expect(result).not.toHaveProperty("stop");
        expect(result).not.toHaveProperty("presence_penalty");
        expect(result).not.toHaveProperty("frequency_penalty");
        // Reasoning models reject temperature/top_p outright (400) — drop them.
        expect(result).not.toHaveProperty("temperature");
        expect(result).not.toHaveProperty("top_p");
      });

      it("drops temperature / top_p for the o-series (o1/o3/o4)", () => {
        for (const model of ["o1", "o1-mini", "o3-mini", "o4-mini"]) {
          const request = createLlmRequest({
            config: { temperature: 0.7, topP: 0.8 },
          });
          const result = convertGenerationConfig(request, model);
          expect(result).not.toHaveProperty("temperature");
          expect(result).not.toHaveProperty("top_p");
        }
      });

      it("drops temperature / top_p for provider-prefixed openai/gpt-5-mini", () => {
        const request = createLlmRequest({
          config: { temperature: 0.5, topP: 0.6 },
        });
        const result = convertGenerationConfig(request, "openai/gpt-5-mini");
        expect(result).not.toHaveProperty("temperature");
        expect(result).not.toHaveProperty("top_p");
      });

      it("keeps stop / penalties / temperature / top_p for gpt-4.1", () => {
        const request = createLlmRequest({
          config: {
            stopSequences: ["END"],
            presencePenalty: 0.5,
            frequencyPenalty: 0.3,
            temperature: 0.4,
            topP: 0.9,
          },
        });
        const result = convertGenerationConfig(request, "gpt-4.1");
        expect(result.stop).toEqual(["END"]);
        expect(result.presence_penalty).toBe(0.5);
        expect(result.frequency_penalty).toBe(0.3);
        expect(result.temperature).toBe(0.4);
        expect(result.top_p).toBe(0.9);
      });

      it("keeps temperature / top_p for non-OpenAI providers (grok-4)", () => {
        const request = createLlmRequest({
          config: { temperature: 0.7, topP: 0.8 },
        });
        const result = convertGenerationConfig(request, "x-ai/grok-4");
        expect(result.temperature).toBe(0.7);
        expect(result.top_p).toBe(0.8);
      });

      it("drops n (candidateCount) for gpt-5 reasoning models", () => {
        const request = createLlmRequest({ config: { candidateCount: 2 } });
        const result = convertGenerationConfig(request, "gpt-5");
        expect(result).not.toHaveProperty("n");
      });

      it("drops n for o-series and provider-prefixed reasoning models", () => {
        for (const model of ["o1", "o3-mini", "o4-mini", "openai/gpt-5-mini"]) {
          const request = createLlmRequest({ config: { candidateCount: 3 } });
          const result = convertGenerationConfig(request, model);
          expect(result).not.toHaveProperty("n");
        }
      });

      it("keeps n (candidateCount) for non-reasoning models (gpt-4.1)", () => {
        const request = createLlmRequest({ config: { candidateCount: 2 } });
        const result = convertGenerationConfig(request, "gpt-4.1");
        expect(result.n).toBe(2);
      });

      it("end-to-end: gpt-5 request carries no temperature/top_p/logprobs but keeps reasoning_effort", () => {
        const request = createLlmRequest({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          config: {
            temperature: 0.5,
            topP: 0.9,
            maxOutputTokens: 100,
            responseLogprobs: true,
            logprobs: 3,
            thinkingConfig: { thinkingBudget: 1000 },
          },
        });
        const result = convertRequest(request, "gpt-5");
        expect(result.params).not.toHaveProperty("temperature");
        expect(result.params).not.toHaveProperty("top_p");
        expect(result.params).not.toHaveProperty("logprobs");
        expect(result.params).not.toHaveProperty("top_logprobs");
        expect(result.params?.max_completion_tokens).toBe(100);
        expect(result.params?.reasoning_effort).toBe("low");
      });
    });

    describe("reasoning_effort model gating", () => {
      it("emits reasoning_effort for gpt-5 with thinkingConfig", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 1000 } },
        });
        expect(convertReasoningConfig(request, "gpt-5")).toEqual({
          reasoning_effort: "low",
        });
      });

      it("emits reasoning_effort for o3-mini", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: {} },
        });
        expect(convertReasoningConfig(request, "o3-mini")).toEqual({
          reasoning_effort: "medium",
        });
      });

      it("does NOT emit reasoning_effort for gpt-4.1 even with thinkingConfig", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 4096 } },
        });
        expect(convertReasoningConfig(request, "gpt-4.1")).toEqual({});
      });

      it("does NOT emit reasoning_effort for plain grok-4", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 4096 } },
        });
        expect(convertReasoningConfig(request, "grok-4")).toEqual({});
      });

      it("emits reasoning_effort for grok reasoning variants", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 4096 } },
        });
        expect(convertReasoningConfig(request, "grok-3-mini")).toEqual({
          reasoning_effort: "medium",
        });
        expect(
          convertReasoningConfig(request, "grok-4-fast-reasoning"),
        ).toEqual({ reasoning_effort: "medium" });
      });

      it("end-to-end: reasoning model uses max_completion_tokens AND reasoning_effort via convertRequest", () => {
        const request = createLlmRequest({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          config: {
            maxOutputTokens: 200,
            thinkingConfig: { thinkingBudget: 5000 },
          },
        });
        const result = convertRequest(request, "gpt-5");
        expect(result.params?.max_completion_tokens).toBe(200);
        expect(result.params).not.toHaveProperty("max_tokens");
        expect(result.params?.reasoning_effort).toBe("medium");
      });

      it("end-to-end: gpt-4.1 keeps max_tokens and drops reasoning_effort", () => {
        const request = createLlmRequest({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          config: {
            maxOutputTokens: 200,
            thinkingConfig: { thinkingBudget: 5000 },
          },
        });
        const result = convertRequest(request, "gpt-4.1");
        expect(result.params?.max_tokens).toBe(200);
        expect(result.params).not.toHaveProperty("max_completion_tokens");
        expect(result.params?.reasoning_effort).toBeUndefined();
      });
    });

    describe("openrouter reasoning style (provider-aware)", () => {
      const OR = { reasoning: { style: "openrouter" as const } };

      it("emits native reasoning.max_tokens from budget for a vendor/model id", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 5000 } },
        });
        const result = convertReasoningConfig(request, "z-ai/glm-5.2", OR);
        // Only max_tokens (not effort) — OpenRouter 400s if both are present.
        expect(result).toEqual({ reasoning: { max_tokens: 5000 } });
      });

      it("ignores the model-name gate (sends reasoning to non-reasoning ids)", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 1000 } },
        });
        // openai/gpt-4o-mini would be gated out under the strict path, but the
        // openrouter style always sends the native reasoning object.
        const result = convertReasoningConfig(
          request,
          "openai/gpt-4o-mini",
          OR,
        );
        expect(result).toEqual({ reasoning: { max_tokens: 1000 } });
      });

      it("maps includeThoughts:false to reasoning.exclude:true", () => {
        const request = createLlmRequest({
          config: {
            thinkingConfig: { includeThoughts: false, thinkingBudget: 3000 },
          },
        });
        const result = convertReasoningConfig(request, "deepseek/deepseek-r1", OR);
        expect(result).toEqual({
          reasoning: { max_tokens: 3000, exclude: true },
        });
      });

      it("disables reasoning (enabled:false) when budget is 0", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 0 } },
        });
        const result = convertReasoningConfig(request, "z-ai/glm-5.2", OR);
        expect(result).toEqual({ reasoning: { enabled: false } });
      });

      it("enables with effort:medium when thinkingConfig has no budget", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { includeThoughts: true } },
        });
        const result = convertReasoningConfig(
          request,
          "anthropic/claude-sonnet-4.5",
          OR,
        );
        expect(result).toEqual({ reasoning: { effort: "medium" } });
      });

      it("emits nothing when thinkingConfig is absent", () => {
        const request = createLlmRequest({ config: {} });
        expect(convertReasoningConfig(request, "z-ai/glm-5.2", OR)).toEqual({});
      });

      it("end-to-end: convertRequest emits reasoning object for openrouter style", () => {
        const request = createLlmRequest({
          contents: [{ role: "user", parts: [{ text: "Hi" }] }],
          config: { thinkingConfig: { thinkingBudget: 9000 } },
        });
        const result = convertRequest(request, "z-ai/glm-5.2", OR);
        expect(result.params?.reasoning).toEqual({ max_tokens: 9000 });
        expect(result.params).not.toHaveProperty("reasoning_effort");
      });
    });

    describe("openrouter budget lever routing (provider-aware control)", () => {
      const OR = { reasoning: { style: "openrouter" as const } };

      // Effort-family models (OpenAI gpt-5*/o-series, xAI Grok reasoners) IGNORE
      // reasoning.max_tokens via OpenRouter but honor reasoning.effort, so a
      // budget must route to a bucketed `effort` for them (never max_tokens).
      it("routes a budget to reasoning.effort for openai/gpt-5-mini", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 1000 } },
        });
        const result = convertReasoningConfig(request, "openai/gpt-5-mini", OR);
        expect(result).toEqual({ reasoning: { effort: "low" } });
      });

      it("buckets the budget to effort low/medium/high for gpt-5-mini", () => {
        const low = convertReasoningConfig(
          createLlmRequest({ config: { thinkingConfig: { thinkingBudget: 1000 } } }),
          "openai/gpt-5-mini",
          OR,
        );
        const medium = convertReasoningConfig(
          createLlmRequest({ config: { thinkingConfig: { thinkingBudget: 5000 } } }),
          "openai/gpt-5-mini",
          OR,
        );
        const high = convertReasoningConfig(
          createLlmRequest({ config: { thinkingConfig: { thinkingBudget: 20000 } } }),
          "openai/gpt-5-mini",
          OR,
        );
        expect(low).toEqual({ reasoning: { effort: "low" } });
        expect(medium).toEqual({ reasoning: { effort: "medium" } });
        expect(high).toEqual({ reasoning: { effort: "high" } });
      });

      it("routes a budget to reasoning.effort for o-series via openrouter", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 20000 } },
        });
        const result = convertReasoningConfig(request, "openai/o4-mini", OR);
        expect(result).toEqual({ reasoning: { effort: "high" } });
      });

      it("routes a budget to reasoning.effort for xAI grok reasoners", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 5000 } },
        });
        const result = convertReasoningConfig(
          request,
          "x-ai/grok-4-fast-reasoning",
          OR,
        );
        expect(result).toEqual({ reasoning: { effort: "medium" } });
      });

      it("keeps reasoning.max_tokens for gemini (honors token budget)", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 16384 } },
        });
        const result = convertReasoningConfig(
          request,
          "google/gemini-2.5-flash",
          OR,
        );
        expect(result).toEqual({ reasoning: { max_tokens: 16384 } });
      });

      it("keeps reasoning.max_tokens for default/unknown reasoners", () => {
        const request = createLlmRequest({
          config: { thinkingConfig: { thinkingBudget: 4000 } },
        });
        expect(
          convertReasoningConfig(request, "deepseek/deepseek-r1", OR),
        ).toEqual({ reasoning: { max_tokens: 4000 } });
        expect(convertReasoningConfig(request, "z-ai/glm-5.2", OR)).toEqual({
          reasoning: { max_tokens: 4000 },
        });
      });

      it("combines effort routing with exclude for effort-family models", () => {
        const request = createLlmRequest({
          config: {
            thinkingConfig: { includeThoughts: false, thinkingBudget: 1000 },
          },
        });
        const result = convertReasoningConfig(request, "openai/gpt-5-mini", OR);
        expect(result).toEqual({
          reasoning: { effort: "low", exclude: true },
        });
      });
    });

    describe("multi-turn reasoning_details echo (openrouter style)", () => {
      const OR = { reasoning: { style: "openrouter" as const } };
      const details = [
        { type: "reasoning.text", text: "thinking...", signature: "sig-abc" },
      ];

      it("echoes reasoning_details verbatim and drops thought text from content", () => {
        const request = createLlmRequest({
          contents: [
            {
              role: "model",
              parts: [
                {
                  text: "thinking...",
                  thought: true,
                  thoughtSignature: JSON.stringify(details),
                },
                { text: "The answer is 782." },
              ],
            },
          ],
        });
        const result = convertRequest(request, "anthropic/claude-sonnet-4.5", OR);
        const msg = result.messages[0] as Record<string, unknown>;
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("The answer is 782.");
        expect(msg.reasoning_details).toEqual(details);
      });

      it("drops display-only thought text and adds no reasoning_details key", () => {
        const request = createLlmRequest({
          contents: [
            {
              role: "model",
              parts: [
                { text: "let me think", thought: true },
                { text: "Final answer." },
              ],
            },
          ],
        });
        const result = convertRequest(request, "z-ai/glm-5.2", OR);
        const msg = result.messages[0] as Record<string, unknown>;
        expect(msg.content).toBe("Final answer.");
        expect(msg).not.toHaveProperty("reasoning_details");
      });

      it("strips thought parts from content under the strict (openai-effort) style too", () => {
        const request = createLlmRequest({
          contents: [
            {
              role: "model",
              parts: [
                {
                  text: "secret reasoning",
                  thought: true,
                  thoughtSignature: JSON.stringify(details),
                },
                { text: "Answer." },
              ],
            },
          ],
        });
        // No opts -> strict default: thought text stripped, no reasoning_details.
        const result = convertRequest(request, "gpt-5");
        const msg = result.messages[0] as Record<string, unknown>;
        expect(msg.content).toBe("Answer.");
        expect(msg).not.toHaveProperty("reasoning_details");
      });
    });

    describe("strict:false on partial schemas", () => {
      it("defaults strict:false for a responseSchema missing additionalProperties/required", () => {
        const request = createLlmRequest({
          config: {
            responseSchema: {
              type: "OBJECT",
              properties: {
                a: { type: "STRING" },
                b: { type: "NUMBER" },
              },
              // no required, no additionalProperties -> would 400 under strict
            },
          },
        });
        const result = convertStructuredOutput(request);
        const rf = result.response_format as {
          json_schema: { strict: boolean };
        };
        expect(rf.json_schema.strict).toBe(false);
      });
    });
  });

  describe("logprobs", () => {
    it("maps responseLogprobs:true to logprobs:true", () => {
      const request = createLlmRequest({
        config: { responseLogprobs: true },
      });
      expect(convertLogprobsConfig(request)).toEqual({ logprobs: true });
    });

    it("maps logprobs (number) to top_logprobs and forces logprobs:true", () => {
      const request = createLlmRequest({ config: { logprobs: 3 } });
      expect(convertLogprobsConfig(request)).toEqual({
        top_logprobs: 3,
        logprobs: true,
      });
    });

    it("maps both responseLogprobs and logprobs together", () => {
      const request = createLlmRequest({
        config: { responseLogprobs: true, logprobs: 5 },
      });
      expect(convertLogprobsConfig(request)).toEqual({
        logprobs: true,
        top_logprobs: 5,
      });
    });

    it("emits top_logprobs:0 when logprobs is 0", () => {
      const request = createLlmRequest({ config: { logprobs: 0 } });
      expect(convertLogprobsConfig(request)).toEqual({
        top_logprobs: 0,
        logprobs: true,
      });
    });

    it("clamps top_logprobs above 20 to 20", () => {
      const request = createLlmRequest({ config: { logprobs: 50 } });
      expect(convertLogprobsConfig(request)).toEqual({
        top_logprobs: 20,
        logprobs: true,
      });
    });

    it("clamps a negative top_logprobs to 0", () => {
      const request = createLlmRequest({ config: { logprobs: -3 } });
      expect(convertLogprobsConfig(request)).toEqual({
        top_logprobs: 0,
        logprobs: true,
      });
    });

    it("keeps an in-range top_logprobs (boundary 20)", () => {
      const request = createLlmRequest({ config: { logprobs: 20 } });
      expect(convertLogprobsConfig(request)).toEqual({
        top_logprobs: 20,
        logprobs: true,
      });
    });

    it("does NOT emit logprobs when responseLogprobs is false", () => {
      const request = createLlmRequest({
        config: { responseLogprobs: false },
      });
      expect(convertLogprobsConfig(request)).toEqual({});
    });

    it("emits nothing when neither field is set", () => {
      expect(convertLogprobsConfig(createLlmRequest({ config: {} }))).toEqual(
        {},
      );
      expect(convertLogprobsConfig(createLlmRequest({}))).toEqual({});
    });

    it("folds logprobs params into convertRequest result", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: { responseLogprobs: true, logprobs: 2 },
      });
      const result = convertRequest(request);
      expect(result.params?.logprobs).toBe(true);
      expect(result.params?.top_logprobs).toBe(2);
    });

    it("drops logprobs/top_logprobs for reasoning models (gpt-5)", () => {
      const request = createLlmRequest({
        config: { responseLogprobs: true, logprobs: 3 },
      });
      expect(convertLogprobsConfig(request, "gpt-5")).toEqual({});
    });

    it("drops logprobs for the o-series and openai-prefixed reasoning ids", () => {
      for (const model of ["o1", "o3-mini", "o4-mini", "openai/gpt-5-mini"]) {
        const request = createLlmRequest({
          config: { responseLogprobs: true, logprobs: 2 },
        });
        expect(convertLogprobsConfig(request, model)).toEqual({});
      }
    });

    it("keeps logprobs for non-reasoning models (gpt-4o)", () => {
      const request = createLlmRequest({
        config: { responseLogprobs: true, logprobs: 4 },
      });
      expect(convertLogprobsConfig(request, "gpt-4o")).toEqual({
        logprobs: true,
        top_logprobs: 4,
      });
    });

    it("end-to-end: gpt-5 request omits logprobs even when requested", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: { responseLogprobs: true, logprobs: 2 },
      });
      const result = convertRequest(request, "gpt-5");
      expect(result.params ?? {}).not.toHaveProperty("logprobs");
      expect(result.params ?? {}).not.toHaveProperty("top_logprobs");
    });

    it("leaves logprobs out of params when not requested", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: { temperature: 0.2 },
      });
      const result = convertRequest(request);
      expect(result.params).not.toHaveProperty("logprobs");
      expect(result.params).not.toHaveProperty("top_logprobs");
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

    it("skips a googleSearch tool group without crashing and emits no function tool", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          // googleSearch is a Gemini server-side tool with no OpenAI equivalent.
          tools: [{ googleSearch: {} } as unknown as Record<string, unknown>],
        },
      });

      const { result, warns } = withConsoleWarn(() => convertRequest(request));

      expect(result.tools).toBeUndefined();
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("googleSearch");
    });

    it("keeps functionDeclarations while dropping a built-in in the same request", () => {
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

      const { result, warns } = withConsoleWarn(() => convertRequest(request));

      expect(result.tools).toHaveLength(1);
      expect(result.tools?.[0].function.name).toBe("get_weather");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("codeExecution");
    });

    it("emits a SINGLE warn naming all dropped built-ins", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [
            { googleSearch: {} } as unknown as Record<string, unknown>,
            { codeExecution: {} } as unknown as Record<string, unknown>,
            { urlContext: {} } as unknown as Record<string, unknown>,
          ],
        },
      });

      const { warns } = withConsoleWarn(() => convertRequest(request));

      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("googleSearch");
      expect(warns[0]).toContain("codeExecution");
      expect(warns[0]).toContain("urlContext");
    });

    it("does NOT warn when only functionDeclarations are present", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "do_thing",
                  description: "",
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

      const { result, warns } = withConsoleWarn(() => convertRequest(request));

      expect(result.tools).toHaveLength(1);
      expect(warns).toHaveLength(0);
    });
  });

  describe("Gemini-only config fields never leak into the body", () => {
    it("never forwards safetySettings / responseModalities / cachedContent / labels / routingConfig", () => {
      const request = createLlmRequest({
        contents: [{ role: "user", parts: [{ text: "Hi" }] }],
        config: {
          temperature: 0.5,
          maxOutputTokens: 100,
          // Gemini-only fields that must NOT appear in the produced body.
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          ],
          responseModalities: ["TEXT"],
          cachedContent: "cachedContents/abc123",
          labels: { team: "research" },
          routingConfig: { autoMode: { modelRoutingPreference: "BALANCED" } },
        } as unknown as LlmRequest["config"],
      });

      const result = convertRequest(request);
      const body = {
        ...result.params,
        // Mirror how the LLM class assembles the request body.
        ...(result.tools ? { tools: result.tools } : {}),
        ...(result.toolChoice ? { tool_choice: result.toolChoice } : {}),
      };

      // Allowlisted sampling fields still pass through.
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
