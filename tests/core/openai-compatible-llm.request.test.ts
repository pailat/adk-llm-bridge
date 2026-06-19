/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Behavioral tests for OpenAICompatibleLlm that assert the actual request body
 * sent to the OpenAI SDK and the streaming-usage merge — the COMBINATIONS that
 * pure converter unit tests cannot observe.
 */

import { describe, expect, it } from "bun:test";
import type { LlmRequest, LlmResponse } from "@google/adk";
import type OpenAI from "openai";
import { OpenAICompatibleLlm } from "../../src/core/openai-compatible-llm";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition";

type CreateParams = Parameters<
  OpenAI["chat"]["completions"]["create"]
>[0] & {
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

function makeLlm(model: string): OpenAICompatibleLlm {
  return new OpenAICompatibleLlm(OPENAI_DEFINITION, {
    model,
    apiKey: "test-key",
  });
}

/** Replaces the SDK call with a spy that records params and returns `result`. */
function spyCreate(
  llm: OpenAICompatibleLlm,
  result: unknown,
): { calls: CreateParams[] } {
  const calls: CreateParams[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test access to private client
  (llm as any).client.chat.completions.create = async (params: CreateParams) => {
    calls.push(params);
    return result;
  };
  return { calls };
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
    expect(body.max_tokens).toBe(50);
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
    expect(calls[0].max_tokens).toBe(128);
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
