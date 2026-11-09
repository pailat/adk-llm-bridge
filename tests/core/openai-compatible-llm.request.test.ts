/**
 * Behavioral tests for OpenAICompatibleLlm that assert the actual request body
 * sent to the OpenAI SDK and the streaming-usage merge — the COMBINATIONS that
 * pure converter unit tests cannot observe.
 */

import { describe, expect, it, spyOn } from "bun:test";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type OpenAI from "openai";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { OPENROUTER_DEFINITION } from "../../src/providers/openrouter/definition.js";

type CreateParams = Parameters<OpenAI["chat"]["completions"]["create"]>[0] & {
  model: string;
  messages: unknown[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
};

type CreateOptions = { signal?: AbortSignal | null };
type CreateResult =
  | unknown
  | ((params: CreateParams, options?: CreateOptions) => unknown);

function makeLlm(
  model: string,
  extra: { errorMode?: "throw" | "response" } = {},
): OpenAICompatibleLlm {
  return new OpenAICompatibleLlm(OPENAI_DEFINITION, {
    model,
    apiKey: "test-key",
    ...extra,
  });
}

/** Replaces the SDK call with a spy that records params and returns `result`. */
function spyCreate(
  llm: OpenAICompatibleLlm,
  result: CreateResult,
): { calls: CreateParams[]; options: (CreateOptions | undefined)[] } {
  const calls: CreateParams[] = [];
  const options: (CreateOptions | undefined)[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async (
    params: CreateParams,
    requestOptions?: CreateOptions,
  ) => {
    calls.push(params);
    options.push(requestOptions);
    return typeof result === "function"
      ? result(params, requestOptions)
      : result;
  };
  return { calls, options };
}

function userRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    contents: [{ role: "user", parts: [{ text: "Hi" }] }],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

const SIMPLE_COMPLETION = {
  id: "x",
  object: "chat.completion",
  created: 0,
  model: "test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok", refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
} as OpenAI.ChatCompletion;

async function drain(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

function abortableNever(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;

    const abort = () => {
      signal.removeEventListener("abort", abort);
      const error = new Error("Request was aborted");
      error.name = "AbortError";
      reject(error);
    };

    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

describe("OpenAICompatibleLlm request body", () => {
  it("spreads params, sets stream_options.include_usage on stream", async () => {
    const llm = makeLlm("gpt-4.1");
    const { calls } = spyCreate(
      llm,
      (async function* () {
        yield {
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        } as OpenAI.ChatCompletionChunk;
      })(),
    );

    await drain(
      llm.generateContentAsync(
        userRequest({ config: { temperature: 0.4, maxOutputTokens: 50 } }),
        true,
      ),
    );

    expect(calls).toHaveLength(1);
    const body = calls[0];
    expect(body.model).toBe("gpt-4.1");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.4);
    // The OpenAI provider sends max_completion_tokens to chat models too.
    expect(body.max_completion_tokens).toBe(50);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("does NOT send tool_choice when no tools are present", async () => {
    const llm = makeLlm("gpt-4.1");
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);

    await drain(
      llm.generateContentAsync(
        userRequest({
          config: {
            toolConfig: {
              // would map to tool_choice "auto" — but no tools, so it must be omitted
              functionCallingConfig: { mode: "AUTO" },
            },
          } as unknown as LlmRequest["config"],
        }),
        false,
      ),
    );

    expect(calls[0]).not.toHaveProperty("tool_choice");
    expect(calls[0]).not.toHaveProperty("tools");
  });

  it("sends tool_choice only together with tools", async () => {
    const llm = makeLlm("gpt-4.1");
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);

    await drain(
      llm.generateContentAsync(
        userRequest({
          config: {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: "get_weather",
                    description: "",
                    parameters: { type: "object", properties: {} },
                  },
                ],
              },
            ],
            toolConfig: {
              functionCallingConfig: { mode: "AUTO" },
            },
          } as unknown as LlmRequest["config"],
        }),
        false,
      ),
    );

    expect(calls[0].tools).toHaveLength(1);
    expect(calls[0].tool_choice).toBe("auto");
  });

  it("uses max_completion_tokens (not max_tokens) for a gpt-5 reasoning model", async () => {
    const llm = makeLlm("gpt-5");
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);

    await drain(
      llm.generateContentAsync(
        userRequest({
          config: {
            maxOutputTokens: 128,
            thinkingConfig: { thinkingBudget: 1000 },
          },
        }),
        false,
      ),
    );

    expect(calls[0].max_completion_tokens).toBe(128);
    expect(calls[0]).not.toHaveProperty("max_tokens");
    expect(calls[0].reasoning_effort).toBe("low");
  });

  it("drops reasoning_effort for gpt-4.1 even when thinkingConfig is set", async () => {
    const llm = makeLlm("gpt-4.1");
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);

    await drain(
      llm.generateContentAsync(
        userRequest({
          config: {
            maxOutputTokens: 128,
            thinkingConfig: { thinkingBudget: 4096 },
          },
        }),
        false,
      ),
    );

    expect(calls[0]).not.toHaveProperty("reasoning_effort");
    expect(calls[0].max_completion_tokens).toBe(128);
    expect(calls[0]).not.toHaveProperty("max_tokens");
  });

  it("sends a native reasoning object for an openrouter non-reasoning vendor id", async () => {
    const llm = new OpenAICompatibleLlm(OPENROUTER_DEFINITION, {
      model: "openai/gpt-4o-mini",
      apiKey: "test-key",
    });
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);

    await drain(
      llm.generateContentAsync(
        userRequest({
          config: { thinkingConfig: { thinkingBudget: 4096 } },
        }),
        false,
      ),
    );

    // openrouter style: always send the native reasoning object (no name gate),
    // and never the strict reasoning_effort scalar.
    expect((calls[0] as unknown as { reasoning?: unknown }).reasoning).toEqual({
      max_tokens: 4096,
    });
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenAICompatibleLlm streaming usage merge", () => {
  function chunk(
    delta: OpenAI.ChatCompletionChunk["choices"][0]["delta"],
    finish: string | null = null,
  ): OpenAI.ChatCompletionChunk {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "test",
      choices: [{ index: 0, delta, finish_reason: finish }],
    } as OpenAI.ChatCompletionChunk;
  }

  function usageChunk(): OpenAI.ChatCompletionChunk {
    return {
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "test",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    } as OpenAI.ChatCompletionChunk;
  }

  it("captures usage from a chunk that arrives AFTER the finish chunk", async () => {
    const llm = makeLlm("gpt-4.1");
    spyCreate(
      llm,
      (async function* () {
        yield chunk({ content: "Hello" });
        // real OpenAI ordering: finish FIRST, then a usage-only chunk
        yield chunk({}, "stop");
        yield usageChunk();
      })(),
    );

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );

    // The last yielded response is the final one and must carry the usage that
    // arrived only AFTER the finish chunk.
    const final = responses[responses.length - 1];
    expect(final.turnComplete).toBe(true);
    expect(final.usageMetadata).toEqual({
      promptTokenCount: 5,
      candidatesTokenCount: 7,
      totalTokenCount: 12,
    });
  });

  it("still emits the final response when no trailing usage chunk arrives", async () => {
    const llm = makeLlm("gpt-4.1");
    spyCreate(
      llm,
      (async function* () {
        yield chunk({ content: "Hello" });
        yield chunk({}, "stop");
      })(),
    );

    const responses = await drain(
      llm.generateContentAsync(userRequest(), true),
    );
    const final = responses[responses.length - 1];
    expect(final.turnComplete).toBe(true);
    expect(final.content?.parts?.[0]).toEqual({ text: "Hello" });
  });
});

describe("OpenAICompatibleLlm cancellation", () => {
  it("passes a pre-aborted signal without yielding a provider error", async () => {
    const llm = makeLlm("gpt-4.1");
    const controller = new AbortController();
    controller.abort();
    const { options } = spyCreate(
      llm,
      (_params: CreateParams, requestOptions?: CreateOptions) =>
        abortableNever(requestOptions?.signal),
    );

    const responses = await drain(
      llm.generateContentAsync(userRequest(), false, controller.signal),
    );

    expect(options[0]?.signal).toBe(controller.signal);
    expect(responses).toEqual([]);
  });

  it("cancels an active non-streaming request without yielding a provider error", async () => {
    const llm = makeLlm("gpt-4.1");
    const controller = new AbortController();
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { options } = spyCreate(
      llm,
      (_params: CreateParams, requestOptions?: CreateOptions) => {
        markStarted();
        return abortableNever(requestOptions?.signal);
      },
    );

    const pending = drain(
      llm.generateContentAsync(userRequest(), false, controller.signal),
    );
    await started;
    controller.abort();

    expect(options[0]?.signal).toBe(controller.signal);
    expect(await pending).toEqual([]);
  });

  it("cancels an active stream without turning the abort into a provider error", async () => {
    const llm = makeLlm("gpt-4.1");
    const controller = new AbortController();
    const { options } = spyCreate(
      llm,
      (_params: CreateParams, requestOptions?: CreateOptions) =>
        (async function* () {
          yield {
            id: "x",
            object: "chat.completion.chunk",
            created: 0,
            model: "test",
            choices: [
              {
                index: 0,
                delta: { content: "Hello" },
                finish_reason: null,
              },
            ],
          } as OpenAI.ChatCompletionChunk;
          await abortableNever(requestOptions?.signal);
        })(),
    );

    const responses = llm.generateContentAsync(
      userRequest(),
      true,
      controller.signal,
    );
    const first = await responses.next();
    controller.abort();
    const final = await responses.next();

    expect(options[0]?.signal).toBe(controller.signal);
    expect(first.value).toMatchObject({ partial: true });
    expect(final).toEqual({ value: undefined, done: true });
  });
  it("emits nothing after abort even if the server keeps streaming chunks and a final response", async () => {
    const llm = makeLlm("gpt-4.1");
    const controller = new AbortController();
    const mkChunk = (
      content: string,
      finish: string | null = null,
    ): OpenAI.ChatCompletionChunk =>
      ({
        id: "x",
        object: "chat.completion.chunk",
        created: 0,
        model: "test",
        choices: [{ index: 0, delta: { content }, finish_reason: finish }],
      }) as OpenAI.ChatCompletionChunk;
    // A server/SDK that ignores the abort: it keeps delivering buffered chunks,
    // including the finish chunk.
    spyCreate(
      llm,
      (async function* () {
        yield mkChunk("one");
        yield mkChunk("two");
        yield mkChunk("three", "stop");
      })(),
    );

    const responses = llm.generateContentAsync(
      userRequest(),
      true,
      controller.signal,
    );
    const first = await responses.next();
    expect(first.value).toMatchObject({ partial: true });
    controller.abort();
    const rest: LlmResponse[] = [];
    for await (const r of responses) rest.push(r);

    expect(rest).toEqual([]);
  });

  it("does not emit the held final response when aborted after the last chunk", async () => {
    const llm = makeLlm("gpt-4.1");
    const controller = new AbortController();
    spyCreate(
      llm,
      (async function* () {
        yield {
          id: "x",
          object: "chat.completion.chunk",
          created: 0,
          model: "test",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        } as OpenAI.ChatCompletionChunk;
        // Abort once the finish chunk was delivered, before the stream ends.
        controller.abort();
      })(),
    );

    const out = await drain(
      llm.generateContentAsync(userRequest(), true, controller.signal),
    );

    expect(out).toEqual([]);
  });
});

describe("OpenAICompatibleLlm span annotation", () => {
  function captureSpan() {
    const attributes: Record<string, unknown> = {};
    const state = {
      attributes,
      exceptions: [] as unknown[],
      status: undefined as { code: number } | undefined,
    };
    const span = {
      setAttributes(a: Record<string, unknown>) {
        Object.assign(attributes, a);
        return this;
      },
      setAttribute(k: string, v: unknown) {
        attributes[k] = v;
        return this;
      },
      recordException(e: unknown) {
        state.exceptions.push(e);
      },
      setStatus(s: { code: number }) {
        state.status = s;
        return this;
      },
    };
    const spy = spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
    return { state, restore: () => spy.mockRestore() };
  }

  it("labels the call_llm span with provider, model, response id and host", async () => {
    const { state, restore } = captureSpan();
    try {
      const llm = makeLlm("gpt-4o");
      spyCreate(llm, { ...SIMPLE_COMPLETION, id: "cmpl-9", model: "gpt-4o-x" });
      await drain(llm.generateContentAsync(userRequest(), false));
      expect(state.attributes["gen_ai.provider.name"]).toBe("openai");
      expect(state.attributes["gen_ai.response.model"]).toBe("gpt-4o-x");
      expect(state.attributes["gen_ai.response.id"]).toBe("cmpl-9");
      expect(state.attributes["server.address"]).toBe("api.openai.com");
      expect(state.status).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("marks the span as ERROR when the provider call fails", async () => {
    const { state, restore } = captureSpan();
    try {
      const llm = makeLlm("gpt-4o", { errorMode: "response" });
      spyCreate(llm, () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      });
      const out = await drain(llm.generateContentAsync(userRequest(), false));
      expect(out[0]?.errorCode).toBe("API_ERROR_429");
      expect(state.attributes["error.type"]).toBe("429");
      expect(state.status?.code).toBe(SpanStatusCode.ERROR);
      expect(state.attributes["gen_ai.provider.name"]).toBe("openai");
    } finally {
      restore();
    }
  });

  it("marks the span as ERROR before throwing in throw mode", async () => {
    const { state, restore } = captureSpan();
    try {
      const llm = makeLlm("gpt-4o", { errorMode: "throw" });
      spyCreate(llm, () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      });
      await expect(
        drain(llm.generateContentAsync(userRequest(), false)),
      ).rejects.toThrow();
      expect(state.attributes["error.type"]).toBe("429");
      expect(state.status?.code).toBe(SpanStatusCode.ERROR);
    } finally {
      restore();
    }
  });

  it("keeps provider error text out of the span when content capture is off", async () => {
    const previous =
      process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
      "NO_CONTENT";
    const { state, restore } = captureSpan();
    try {
      const llm = makeLlm("gpt-4o", { errorMode: "response" });
      spyCreate(llm, () => {
        throw Object.assign(new Error("blocked: summarize Jane Roe's chart"), {
          status: 400,
        });
      });
      const out = await drain(llm.generateContentAsync(userRequest(), false));
      // The LlmResponse (not the span) still carries the message.
      expect(out[0]?.errorMessage).toContain("Jane Roe");
      expect(JSON.stringify(state)).not.toContain("Jane Roe");
      expect(state.attributes["error.type"]).toBe("400");
    } finally {
      restore();
      if (previous === undefined)
        delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else
        process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT =
          previous;
    }
  });

  it("does not record an error for caller aborts", async () => {
    const { state, restore } = captureSpan();
    try {
      const llm = makeLlm("gpt-4o");
      const controller = new AbortController();
      spyCreate(llm, () => {
        controller.abort();
        throw new Error("aborted");
      });
      await drain(
        llm.generateContentAsync(userRequest(), false, controller.signal),
      );
      expect(state.exceptions).toEqual([]);
      expect(state.status).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("OpenAICompatibleLlm user-turn fix-up (as ADK's GoogleLlm)", () => {
  const HANDLE = "Handle the requests as specified in the System Instruction.";
  const CONTINUE =
    "Continue processing previous requests as instructed. Exit or provide a summary if no more outputs are needed.";

  async function sentMessages(contents: LlmRequest["contents"]) {
    const llm = makeLlm("gpt-4.1");
    const { calls } = spyCreate(llm, SIMPLE_COMPLETION);
    const request = userRequest({
      contents,
      config: { systemInstruction: "Be brief." },
    });
    await drain(llm.generateContentAsync(request));
    return { messages: calls[0]?.messages, request };
  }

  it("adds a user turn when there are no contents", async () => {
    const { messages } = await sentMessages([]);
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: HANDLE },
    ]);
  });

  it("adds a user turn when the history ends on a model turn", async () => {
    const { messages } = await sentMessages([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [{ text: "Hello" }] },
    ]);
    expect(messages?.at(-1)).toEqual({ role: "user", content: CONTINUE });
  });

  it("treats contents with no parts as absent", async () => {
    const { messages } = await sentMessages([{ role: "user", parts: [] }]);
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: HANDLE },
    ]);
  });

  it("does not add a turn after a trailing model turn with no parts", async () => {
    const { messages } = await sentMessages([
      { role: "user", parts: [{ text: "Hi" }] },
      { role: "model", parts: [] },
    ]);
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("leaves the caller's request unchanged", async () => {
    const contents = [{ role: "model", parts: [{ text: "Hello" }] }];
    const { request } = await sentMessages(contents);
    expect(request.contents).toEqual([
      { role: "model", parts: [{ text: "Hello" }] },
    ]);
  });
});
