import { describe, expect, it } from "bun:test";
import { FinishReason } from "@google/genai";
import type OpenAI from "openai";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response";

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

  it("surfaces choice.logprobs.content into customMetadata.logprobs", () => {
    const logprobs = {
      content: [
        { token: "Hi", logprob: -0.1, bytes: [72, 105], top_logprobs: [] },
      ],
    };
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi", refusal: null },
          finish_reason: "stop",
          logprobs,
        },
      ],
    } as Partial<ChatCompletion>);

    const result = convertResponse(response);
    expect(result.customMetadata).toEqual({ logprobs });
  });

  it("leaves customMetadata undefined when logprobs.content is empty", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi", refusal: null },
          finish_reason: "stop",
          logprobs: { content: [] },
        },
      ],
    } as Partial<ChatCompletion>);

    expect(convertResponse(response).customMetadata).toBeUndefined();
  });

  it("leaves customMetadata undefined when logprobs is null", () => {
    const response = createCompletion();
    expect(convertResponse(response).customMetadata).toBeUndefined();
  });

  it("returns error for empty choices", () => {
    const response = createCompletion({ choices: [] });
    const result = convertResponse(response);

    expect(result.errorCode).toBe("NO_CHOICE");
    expect(result.turnComplete).toBe(true);
  });

  describe("finishReason mapping", () => {
    function withFinish(reason: string) {
      return createCompletion({
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "x", refusal: null },
            finish_reason:
              reason as OpenAI.ChatCompletion["choices"][0]["finish_reason"],
            logprobs: null,
          },
        ],
      });
    }

    it("maps stop to STOP", () => {
      expect(convertResponse(withFinish("stop")).finishReason).toBe(
        FinishReason.STOP,
      );
    });

    it("maps length to MAX_TOKENS", () => {
      expect(convertResponse(withFinish("length")).finishReason).toBe(
        FinishReason.MAX_TOKENS,
      );
    });

    it("maps content_filter to SAFETY", () => {
      expect(convertResponse(withFinish("content_filter")).finishReason).toBe(
        FinishReason.SAFETY,
      );
    });

    it("maps tool_calls to STOP", () => {
      expect(convertResponse(withFinish("tool_calls")).finishReason).toBe(
        FinishReason.STOP,
      );
    });
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

  it("attaches finishReason to the final response", () => {
    const accumulated = createStreamAccumulator();
    accumulated.text = "done";

    const result = convertStreamChunk(createChunk({}, "length"), accumulated);

    expect(result.response?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it("captures a usage chunk that arrives AFTER finish (real OpenAI ordering)", () => {
    const accumulated = createStreamAccumulator();

    // content delta
    convertStreamChunk(createChunk({ content: "Hi" }), accumulated);

    // finish chunk arrives FIRST (real OpenAI stream_options ordering).
    const finalResult = convertStreamChunk(
      createChunk({}, "stop"),
      accumulated,
    );
    expect(finalResult.isComplete).toBe(true);
    expect(finalResult.response?.finishReason).toBe(FinishReason.STOP);
    // No usage yet — the usage chunk has not arrived.
    expect(finalResult.response?.usageMetadata).toBeUndefined();
    // Finish clears any prior accumulator usage.
    expect(accumulated.usage).toBeUndefined();

    // usage-only chunk (empty choices) arrives AFTER finish — it must be
    // captured into the accumulator without completing again. The LLM stream
    // loop then merges acc.usage into the held final response (see core tests).
    const usageChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    } as ChatCompletionChunk;
    const usageResult = convertStreamChunk(usageChunk, accumulated);
    expect(usageResult.isComplete).toBe(false);
    expect(usageResult.response).toBeUndefined();
    expect(accumulated.usage).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 8,
      totalTokenCount: 20,
    });
  });

  it("emits usage on the final response when usage arrives BEFORE finish", () => {
    // Some OpenAI-compatible providers attach usage to the finish chunk or send
    // it just before. In that ordering the converter's final response carries
    // the usage directly.
    const accumulated = createStreamAccumulator();
    convertStreamChunk(createChunk({ content: "Hi" }), accumulated);

    const usageChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    } as ChatCompletionChunk;
    convertStreamChunk(usageChunk, accumulated);

    const finalResult = convertStreamChunk(
      createChunk({}, "stop"),
      accumulated,
    );
    expect(finalResult.response?.usageMetadata).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 8,
      totalTokenCount: 20,
    });
    expect(accumulated.usage).toBeUndefined();
  });

  it("surfaces reasoning AND content co-located in one chunk", () => {
    const accumulated = createStreamAccumulator();
    const result = convertStreamChunk(
      createChunk({
        reasoning_content: "thinking",
        content: "answer",
      } as ChatCompletionChunk["choices"][0]["delta"]),
      accumulated,
    );

    expect(result.isComplete).toBe(false);
    expect(result.response?.partial).toBe(true);
    expect(result.response?.content?.parts).toEqual([
      { text: "thinking", thought: true },
      { text: "answer" },
    ]);
    expect(accumulated.reasoning).toBe("thinking");
    expect(accumulated.text).toBe("answer");
  });

  it("processes reasoning, content, tool_call, and finish all in one chunk", () => {
    const accumulated = createStreamAccumulator();
    const result = convertStreamChunk(
      createChunk(
        {
          reasoning_content: "reason",
          content: "say",
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "do_it", arguments: '{"x":1}' },
            },
          ],
        } as ChatCompletionChunk["choices"][0]["delta"],
        "tool_calls",
      ),
      accumulated,
    );

    // finish_reason present -> final response, not a partial
    expect(result.isComplete).toBe(true);
    expect(result.response?.turnComplete).toBe(true);
    const parts = result.response?.content?.parts ?? [];
    expect(parts[0]).toEqual({ text: "reason", thought: true });
    expect(parts[1]).toEqual({ text: "say" });
    expect(parts[2]).toEqual({
      functionCall: { id: "call_1", name: "do_it", args: { x: 1 } },
    });
  });
});

describe("reasoning passthrough", () => {
  it("surfaces message.reasoning_content as a thought part before text", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer is 4.",
            reasoning_content: "2 + 2 = 4",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    } as Partial<ChatCompletion>);

    const result = convertResponse(response);
    const parts = result.content?.parts ?? [];
    expect(parts[0]).toEqual({ text: "2 + 2 = 4", thought: true });
    expect(parts[1]).toEqual({ text: "The answer is 4." });
  });

  it("surfaces message.reasoning (OpenAI/OpenRouter naming) as a thought part", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Done.",
            reasoning: "thinking hard",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    } as Partial<ChatCompletion>);

    const parts = convertResponse(response).content?.parts ?? [];
    expect(parts[0]).toEqual({ text: "thinking hard", thought: true });
  });

  it("yields no thought part when the provider omits reasoning", () => {
    const response = createCompletion();
    const parts = convertResponse(response).content?.parts ?? [];
    expect(parts.some((p) => p.thought)).toBe(false);
  });

  it("maps completion_tokens_details.reasoning_tokens to thoughtsTokenCount", () => {
    const response = createCompletion({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 50,
        total_tokens: 60,
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    } as Partial<ChatCompletion>);

    expect(convertResponse(response).usageMetadata).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 50,
      totalTokenCount: 60,
      thoughtsTokenCount: 32,
    });
  });

  it("omits thoughtsTokenCount when reasoning_tokens is absent", () => {
    const response = createCompletion({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const usage = convertResponse(response).usageMetadata;
    expect(usage?.thoughtsTokenCount).toBeUndefined();
  });

  it("streams reasoning_content delta as a partial thought part", () => {
    const acc = createStreamAccumulator();

    const result = convertStreamChunk(
      createChunk({
        reasoning_content: "step 1",
      } as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );

    expect(result.isComplete).toBe(false);
    expect(result.response?.partial).toBe(true);
    expect(result.response?.content?.parts?.[0]).toEqual({
      text: "step 1",
      thought: true,
    });
    expect(acc.reasoning).toBe("step 1");
  });

  it("streams reasoning (OpenRouter naming) delta as a thought part", () => {
    const acc = createStreamAccumulator();

    const result = convertStreamChunk(
      createChunk({
        reasoning: "hmm",
      } as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );

    expect(result.response?.content?.parts?.[0]).toEqual({
      text: "hmm",
      thought: true,
    });
  });

  it("includes accumulated reasoning as a thought part in the final response", () => {
    const acc = createStreamAccumulator();

    convertStreamChunk(
      createChunk({
        reasoning_content: "think ",
      } as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );
    convertStreamChunk(
      createChunk({
        reasoning_content: "more",
      } as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );
    convertStreamChunk(createChunk({ content: "answer" }), acc);

    const final = convertStreamChunk(createChunk({}, "stop"), acc);
    const parts = final.response?.content?.parts ?? [];
    expect(parts[0]).toEqual({ text: "think more", thought: true });
    expect(parts[1]).toEqual({ text: "answer" });
    // reasoning accumulator reset after completion
    expect(acc.reasoning).toBe("");
  });

  it("captures reasoning_tokens into acc.usage from a usage chunk AFTER finish", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(createChunk({ content: "Hi" }), acc);

    // finish first (real OpenAI ordering)
    convertStreamChunk(createChunk({}, "stop"), acc);

    const usageChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      created: Date.now(),
      model: "test-model",
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 40,
        total_tokens: 52,
        completion_tokens_details: { reasoning_tokens: 25 },
      },
    } as ChatCompletionChunk;
    convertStreamChunk(usageChunk, acc);

    // The accumulator now holds the usage (with reasoning tokens) for the LLM
    // stream loop to merge into the held final response.
    expect(acc.usage).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 40,
      totalTokenCount: 52,
      thoughtsTokenCount: 25,
    });
  });
});
