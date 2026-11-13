import { describe, expect, it } from "bun:test";
import { FinishReason } from "@google/genai";
import type OpenAI from "openai";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response.js";

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
    } as unknown as Partial<ChatCompletion>);

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
    } as unknown as Partial<ChatCompletion>);

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
    } as unknown as Partial<ChatCompletion>);

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
    } as unknown as Partial<ChatCompletion>);

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
      candidatesTokenCount: 18,
      totalTokenCount: 60,
      thoughtsTokenCount: 32,
    });
  });

  it("maps prompt_tokens_details.cached_tokens to cachedContentTokenCount", () => {
    const response = createCompletion({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    } as Partial<ChatCompletion>);

    expect(convertResponse(response).usageMetadata).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 5,
      totalTokenCount: 105,
      cachedContentTokenCount: 64,
    });
  });

  it("omits cachedContentTokenCount when the provider reports no cache details", () => {
    const response = createCompletion({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    expect(
      convertResponse(response).usageMetadata?.cachedContentTokenCount,
    ).toBeUndefined();
  });

  it("maps cached_tokens from the streaming usage chunk", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      {
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 2,
          total_tokens: 22,
          prompt_tokens_details: { cached_tokens: 16 },
        },
      } as ChatCompletionChunk,
      acc,
    );
    expect(acc.usage?.cachedContentTokenCount).toBe(16);
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

    // The accumulator holds the usage (with reasoning tokens) for the LLM
    // stream loop to merge into the held final response.
    expect(acc.usage).toEqual({
      promptTokenCount: 12,
      candidatesTokenCount: 15,
      totalTokenCount: 52,
      thoughtsTokenCount: 25,
    });
  });
});

describe("reasoning_details (structured, signed) passthrough", () => {
  const details = [
    { type: "reasoning.text", text: "step A", signature: "sig-1", index: 0 },
  ];

  it("builds a thought part with thoughtSignature round-tripping the array", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The answer.",
            reasoning: "step A",
            reasoning_details: details,
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    } as unknown as Partial<ChatCompletion>);

    const parts = convertResponse(response).content?.parts ?? [];
    expect(parts[0]?.thought).toBe(true);
    expect(parts[0]?.text).toBe("step A");
    expect(parts[0]?.thoughtSignature).toBeDefined();
    expect(JSON.parse(parts[0]?.thoughtSignature as string)).toEqual(details);
    expect(parts[1]).toEqual({ text: "The answer." });
  });

  it("uses reasoning.summary text when reasoning.text is absent", () => {
    const summaryDetails = [
      { type: "reasoning.summary", summary: "brief", index: 0 },
    ];
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
            reasoning_details: summaryDetails,
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    } as unknown as Partial<ChatCompletion>);

    const parts = convertResponse(response).content?.parts ?? [];
    expect(parts[0]?.text).toBe("brief");
    expect(JSON.parse(parts[0]?.thoughtSignature as string)).toEqual(
      summaryDetails,
    );
  });

  it("falls back to a flat thought part (no signature) without reasoning_details", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "ok",
            reasoning: "plain thinking",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    } as unknown as Partial<ChatCompletion>);

    const parts = convertResponse(response).content?.parts ?? [];
    expect(parts[0]).toEqual({ text: "plain thinking", thought: true });
    expect(parts[0]?.thoughtSignature).toBeUndefined();
  });

  it("accumulates streamed reasoning_details fragments and assembles on finish", () => {
    const acc = createStreamAccumulator();

    convertStreamChunk(
      createChunk({
        reasoning_details: [{ type: "reasoning.text", text: "foo ", index: 0 }],
      } as unknown as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );
    convertStreamChunk(
      createChunk({
        reasoning_details: [
          { type: "reasoning.text", text: "bar", signature: "sig-z", index: 0 },
        ],
      } as unknown as ChatCompletionChunk["choices"][0]["delta"]),
      acc,
    );
    convertStreamChunk(createChunk({ content: "answer" }), acc);

    const final = convertStreamChunk(createChunk({}, "stop"), acc);
    const parts = final.response?.content?.parts ?? [];
    expect(parts[0]?.thought).toBe(true);
    expect(parts[0]?.text).toBe("foo bar");
    const sig = JSON.parse(parts[0]?.thoughtSignature as string);
    expect(sig).toEqual([
      { type: "reasoning.text", text: "foo bar", signature: "sig-z", index: 0 },
    ]);
    expect(parts[1]).toEqual({ text: "answer" });
    // accumulator reset after completion
    expect(acc.reasoningDetails.size).toBe(0);
  });
});

describe("malformed tool-call arguments", () => {
  const toolCompletion = (args: string, finish = "length") =>
    createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "let me check",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: args },
              },
            ],
          },
          finish_reason: finish,
          logprobs: null,
        },
      ],
    } as Partial<ChatCompletion>);

  it("reports truncated arguments as MALFORMED_FUNCTION_CALL instead of calling with {}", () => {
    const response = convertResponse(toolCompletion('{"city":"Par'));
    expect(response.finishReason).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    expect(response.errorCode).toBe("MALFORMED_FUNCTION_CALL");
    expect(response.errorMessage).toContain("get_weather (invalid-json)");
    expect(response.content?.parts?.some((p) => p.functionCall)).toBe(false);
    expect(response.content?.parts?.[0]?.text).toBe("let me check");
  });

  it("still emits calls whose arguments are empty or valid", () => {
    for (const args of ["", "{}", '{"city":"Paris"}']) {
      const response = convertResponse(toolCompletion(args, "tool_calls"));
      expect(response.finishReason).toBe(FinishReason.STOP);
      expect(response.content?.parts?.some((p) => p.functionCall)).toBe(true);
    }
  });

  it("drops every function call of the turn when any one is malformed", () => {
    const completion = toolCompletion('{"a":1}');
    // biome-ignore lint/suspicious/noExplicitAny: test fixture mutation
    (completion.choices[0] as any).message.tool_calls.push({
      id: "call_2",
      type: "function",
      function: { name: "other", arguments: "{oops" },
    });
    const response = convertResponse(completion);
    expect(response.finishReason).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    expect(response.content?.parts?.some((p) => p.functionCall)).toBe(false);
  });

  it("applies to the final streaming response too", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      createChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Pa' },
          },
        ],
      }),
      acc,
    );
    const { response, isComplete } = convertStreamChunk(
      createChunk({}, "length"),
      acc,
    );
    expect(isComplete).toBe(true);
    expect(response?.finishReason).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    expect(response?.errorCode).toBe("MALFORMED_FUNCTION_CALL");
    expect(response?.content).toBeUndefined();
  });
});

describe("encrypted-only reasoning_details (no display text)", () => {
  // xAI Grok returns reasoning only as an encrypted blob. ADK drops any event
  // whose parts[0].text is "" from the history, which silently removes the
  // function call that follows.
  const encrypted = [
    { type: "reasoning.encrypted", data: "gAAAA-opaque", index: 0 },
  ];
  const toolCall = {
    id: "call_1",
    type: "function",
    function: { name: "get_weather", arguments: '{"city":"Lima"}' },
  };

  function noEmptyFirstText(parts: { text?: string }[] | undefined): void {
    expect(parts?.[0]?.text).not.toBe("");
  }

  it("omits text on the thought part instead of emitting an empty string", () => {
    const response = convertResponse(
      createCompletion({
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            logprobs: null,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [toolCall],
              reasoning_details: encrypted,
            },
          },
        ],
      } as unknown as Partial<ChatCompletion>),
    );
    const parts = response.content?.parts ?? [];
    expect(parts).toHaveLength(2);
    expect(parts[0]?.thought).toBe(true);
    expect("text" in (parts[0] ?? {})).toBe(false);
    expect(JSON.parse(parts[0]?.thoughtSignature ?? "[]")).toEqual(encrypted);
    expect(parts[1]?.functionCall?.name).toBe("get_weather");
    noEmptyFirstText(parts);
  });

  it("does the same on the final streaming response", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      createChunk({
        reasoning_details: encrypted,
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Lima"}' },
          },
        ],
      } as never),
      acc,
    );
    const { response, isComplete } = convertStreamChunk(
      createChunk({}, "tool_calls"),
      acc,
    );
    expect(isComplete).toBe(true);
    const parts = response?.content?.parts ?? [];
    expect(parts[0]?.thought).toBe(true);
    expect("text" in (parts[0] ?? {})).toBe(false);
    expect(parts[1]?.functionCall?.name).toBe("get_weather");
    noEmptyFirstText(parts);
  });

  it("keeps display text when the details carry some", () => {
    const response = convertResponse(
      createCompletion({
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: {
              role: "assistant",
              content: "answer",
              reasoning_details: [
                { type: "reasoning.text", text: "step 1", signature: "s" },
                ...encrypted,
              ],
            },
          },
        ],
      } as unknown as Partial<ChatCompletion>),
    );
    expect(response.content?.parts?.[0]).toMatchObject({
      text: "step 1",
      thought: true,
    });
  });

  it("never yields an empty-string first part for any reasoning shape", () => {
    for (const message of [
      { content: null, reasoning_details: encrypted },
      {
        content: null,
        reasoning_details: [{ type: "reasoning.text", text: "" }],
      },
      { content: "x", reasoning: "" },
      { content: "x", reasoning_content: "" },
    ]) {
      const response = convertResponse(
        createCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              logprobs: null,
              message: { role: "assistant", ...message },
            },
          ],
        } as unknown as Partial<ChatCompletion>),
      );
      noEmptyFirstText(response.content?.parts);
    }
  });
});

describe("streamed tool-call fragments", () => {
  function stream(chunks: ChatCompletionChunk[]) {
    const acc = createStreamAccumulator();
    let final: ReturnType<typeof convertStreamChunk>["response"];
    for (const chunk of chunks) {
      const result = convertStreamChunk(chunk, acc);
      if (result.isComplete) final = result.response;
    }
    return final?.content?.parts?.filter((p) => p.functionCall) ?? [];
  }

  it("keeps a name that a gateway repeats on every fragment", () => {
    const calls = stream([
      createChunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            function: { name: "get_weather", arguments: '{"city":' },
          },
        ],
      }),
      createChunk({
        tool_calls: [
          { index: 0, function: { name: "get_weather", arguments: '"Lima"}' } },
        ],
      }),
      createChunk({}, "tool_calls"),
    ]);
    expect(calls).toEqual([
      {
        functionCall: {
          id: "call_1",
          name: "get_weather",
          args: { city: "Lima" },
        },
      },
    ]);
  });

  it("still joins a name split across fragments", () => {
    const calls = stream([
      createChunk({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "get_", arguments: "" } },
        ],
      }),
      createChunk({
        tool_calls: [
          { index: 0, function: { name: "weather", arguments: "{}" } },
        ],
      }),
      createChunk({}, "tool_calls"),
    ]);
    expect(calls.map((p) => p.functionCall?.name)).toEqual(["get_weather"]);
  });

  it("attaches a fragment without index or id to the last call", () => {
    const calls = stream([
      createChunk({
        tool_calls: [
          {
            id: "call_1",
            function: { name: "get_weather", arguments: '{"city":' },
          } as never,
        ],
      }),
      createChunk({
        tool_calls: [{ function: { arguments: '"Lima"}' } } as never],
      }),
      createChunk({}, "tool_calls"),
    ]);
    expect(calls).toEqual([
      {
        functionCall: {
          id: "call_1",
          name: "get_weather",
          args: { city: "Lima" },
        },
      },
    ]);
  });

  it("starts a new call for a fragment without index that has a new id", () => {
    const calls = stream([
      createChunk({
        tool_calls: [
          { id: "call_1", function: { name: "a", arguments: "{}" } } as never,
        ],
      }),
      createChunk({
        tool_calls: [
          { id: "call_2", function: { name: "b", arguments: "{}" } } as never,
        ],
      }),
      createChunk({}, "tool_calls"),
    ]);
    expect(
      calls.map((p) => [p.functionCall?.id, p.functionCall?.name]),
    ).toEqual([
      ["call_1", "a"],
      ["call_2", "b"],
    ]);
  });

  it("generates an id for a streamed call that has none", () => {
    const calls = stream([
      createChunk({
        tool_calls: [{ index: 0, function: { name: "a", arguments: "{}" } }],
      }),
      createChunk({}, "tool_calls"),
    ]);
    expect(calls[0]?.functionCall?.id).toMatch(/^call_[0-9a-f]{32}$/);
  });
});

describe("tool calls without an id", () => {
  it("convertResponse generates an id for a call that has none", () => {
    const response = createCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "",
                type: "function",
                function: { name: "a", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    } as Partial<ChatCompletion>);
    const call = convertResponse(response).content?.parts?.[0]?.functionCall;
    expect(call?.id).toMatch(/^call_[0-9a-f]{32}$/);
  });
});

describe("streamed reasoning_details without index", () => {
  it("merges fragments without index into the last entry", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      createChunk({
        reasoning_details: [{ type: "reasoning.text", text: "Think" }],
      } as never),
      acc,
    );
    convertStreamChunk(
      createChunk({
        reasoning_details: [
          { type: "reasoning.text", text: "ing.", signature: "sig" },
        ],
      } as never),
      acc,
    );
    const { response } = convertStreamChunk(
      createChunk({ content: "Done" }, "stop"),
      acc,
    );
    const thought = response?.content?.parts?.find((p) => p.thought);
    expect(thought?.text).toBe("Thinking.");
    expect(JSON.parse(thought?.thoughtSignature ?? "[]")).toEqual([
      { type: "reasoning.text", text: "Thinking.", signature: "sig" },
    ]);
  });

  it("keeps indexed entries apart", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      createChunk({
        reasoning_details: [
          { type: "reasoning.text", text: "A", index: 0 },
          { type: "reasoning.text", text: "B", index: 1 },
        ],
      } as never),
      acc,
    );
    const { response } = convertStreamChunk(createChunk({}, "stop"), acc);
    const thought = response?.content?.parts?.find((p) => p.thought);
    expect(JSON.parse(thought?.thoughtSignature ?? "[]")).toHaveLength(2);
  });
});

describe("reasoning tokens are not counted twice", () => {
  it("candidatesTokenCount excludes reasoning tokens, as Gemini reports it", () => {
    const response = createCompletion({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 50,
        total_tokens: 60,
        completion_tokens_details: { reasoning_tokens: 32 },
      },
    } as Partial<ChatCompletion>);
    const usage = convertResponse(response).usageMetadata;
    expect(usage).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 18,
      totalTokenCount: 60,
      thoughtsTokenCount: 32,
    });
    // ADK main's output tokens (candidates + thoughts) equal completion_tokens.
    expect(
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    ).toBe(50);
  });

  it("never reports negative candidate tokens", () => {
    const response = createCompletion({
      usage: {
        prompt_tokens: 1,
        completion_tokens: 5,
        total_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 9 },
      },
    } as Partial<ChatCompletion>);
    expect(convertResponse(response).usageMetadata?.candidatesTokenCount).toBe(
      0,
    );
  });
});
