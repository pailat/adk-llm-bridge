import { describe, it, expect } from "bun:test";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response";
import type OpenAI from "openai";

type ChatCompletion = OpenAI.ChatCompletion;
type ChatCompletionChunk = OpenAI.ChatCompletionChunk;

function createCompletion(
  overrides: Partial<ChatCompletion> = {},
): ChatCompletion {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: Date.now(),
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    ...overrides,
  } as ChatCompletion;
}

function createChunk(
  delta: ChatCompletionChunk["choices"][0]["delta"],
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-123",
    object: "chat.completion.chunk",
    created: Date.now(),
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  } as ChatCompletionChunk;
}

describe("convertResponse", () => {
  it("converts text content", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!", refusal: null },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    });

    const result = convertResponse(response);

    expect(result.content).toEqual({
      role: "model",
      parts: [{ text: "Hello!" }],
    });
    expect(result.turnComplete).toBe(true);
  });

  it("converts tool calls", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Tokyo"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    });

    const result = convertResponse(response);

    expect(result.content?.parts?.[0]).toEqual({
      functionCall: {
        id: "call_123",
        name: "get_weather",
        args: { city: "Tokyo" },
      },
    });
  });

  it("converts usage metadata", () => {
    const response = createCompletion({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });

    const result = convertResponse(response);

    expect(result.usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 20,
      totalTokenCount: 30,
    });
  });

  it("returns error for empty choices", () => {
    const response = createCompletion({ choices: [] });
    const result = convertResponse(response);

    expect(result.errorCode).toBe("NO_CHOICE");
    expect(result.turnComplete).toBe(true);
  });
});

describe("convertStreamChunk", () => {
  it("yields partial response for text delta", () => {
    const chunk = createChunk({ content: "Hello" });
    const accumulated = createStreamAccumulator();

    const result = convertStreamChunk(chunk, accumulated);

    expect(result.response?.partial).toBe(true);
    expect(result.response?.content?.parts?.[0]).toEqual({ text: "Hello" });
    expect(result.isComplete).toBe(false);
  });

  it("accumulates text across chunks", () => {
    const accumulated = createStreamAccumulator();

    convertStreamChunk(createChunk({ content: "Hello" }), accumulated);
    convertStreamChunk(createChunk({ content: " world" }), accumulated);

    expect(accumulated.text).toBe("Hello world");
  });

  it("yields final response on finish_reason", () => {
    const accumulated = createStreamAccumulator();
    accumulated.text = "Complete response";

    const result = convertStreamChunk(createChunk({}, "stop"), accumulated);

    expect(result.response?.turnComplete).toBe(true);
    expect(result.response?.content?.parts?.[0]).toEqual({
      text: "Complete response",
    });
    expect(result.isComplete).toBe(true);
  });

  it("resets accumulator after completion", () => {
    const accumulated = createStreamAccumulator();
    accumulated.text = "Some text";

    convertStreamChunk(createChunk({}, "stop"), accumulated);

    expect(accumulated.text).toBe("");
    expect(accumulated.toolCalls.size).toBe(0);
  });
});
