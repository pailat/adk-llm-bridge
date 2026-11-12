/**
 * Cache-write usage: `cache_creation_input_tokens` (Anthropic) and
 * `prompt_tokens_details.cache_write_tokens` (OpenRouter) surface as
 * `customMetadata.cacheCreationTokenCount`; reads stay in
 * `usageMetadata.cachedContentTokenCount`.
 */

import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response.js";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "../../src/providers/anthropic/converters/response.js";

function completion(
  usage: Record<string, unknown> | undefined,
  message: Record<string, unknown> = { role: "assistant", content: "Hi" },
  extra: Record<string, unknown> = {},
): OpenAI.ChatCompletion {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      { index: 0, message, finish_reason: "stop", logprobs: null, ...extra },
    ],
    ...(usage ? { usage } : {}),
  } as unknown as OpenAI.ChatCompletion;
}

describe("OpenAI-compatible cache write", () => {
  it("maps cache_write_tokens to customMetadata, reads stay in cachedContentTokenCount", () => {
    const r = convertResponse(
      completion({
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 },
      }),
    );
    expect(r.usageMetadata?.cachedContentTokenCount).toBe(60);
    expect(r.customMetadata).toEqual({ cacheCreationTokenCount: 30 });
    expect(r.usageMetadata?.promptTokenCount).toBe(100);
  });

  it("reads the AI Gateway shape: top-level cache_creation_input_tokens (live probe 2026-11-11)", () => {
    // Recorded from anthropic/claude-haiku-5.5 via the gateway, run B call 2:
    // prompt_tokens already includes the cached read and the write.
    const r = convertResponse(
      completion({
        prompt_tokens: 8466,
        completion_tokens: 50,
        total_tokens: 8516,
        cost: 0,
        is_byok: true,
        prompt_tokens_details: {
          cached_tokens: 6316,
          audio_tokens: 0,
          video_tokens: 0,
        },
        cache_creation_input_tokens: 2148,
      }),
    );
    expect(r.usageMetadata?.promptTokenCount).toBe(8466);
    expect(r.usageMetadata?.cachedContentTokenCount).toBe(6316);
    // `cost: 0` (BYOK call) is now reported beside the write.
    expect(r.customMetadata).toEqual({
      costUsd: 0,
      costSource: "cost",
      cacheCreationTokenCount: 2148,
    });
  });

  it("prefers prompt_tokens_details.cache_write_tokens over the top-level field", () => {
    const r = convertResponse(
      completion({
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        prompt_tokens_details: { cache_write_tokens: 3 },
        cache_creation_input_tokens: 99,
      }),
    );
    expect(r.customMetadata).toEqual({ cacheCreationTokenCount: 3 });
  });

  it("reports a write of 0", () => {
    const r = convertResponse(
      completion({
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      }),
    );
    expect(r.customMetadata).toEqual({ cacheCreationTokenCount: 0 });
  });

  it("leaves customMetadata undefined when no write is reported", () => {
    const r = convertResponse(
      completion({
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        prompt_tokens_details: { cached_tokens: 4 },
      }),
    );
    expect(r.customMetadata).toBeUndefined();
  });

  it("merges with logprobs instead of replacing them", () => {
    const logprobs = {
      content: [{ token: "a", logprob: -1, bytes: null, top_logprobs: [] }],
      refusal: null,
    };
    const r = convertResponse(
      completion(
        {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
          prompt_tokens_details: { cache_write_tokens: 7 },
        },
        { role: "assistant", content: "Hi" },
        { logprobs },
      ),
    );
    expect(r.customMetadata).toEqual({ logprobs, cacheCreationTokenCount: 7 });
  });

  it("keeps the write on the malformed tool-call path", () => {
    const r = convertResponse(
      completion(
        {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
          prompt_tokens_details: { cache_write_tokens: 9 },
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t",
              type: "function",
              function: { name: "f", arguments: "{not json" },
            },
          ],
        },
      ),
    );
    expect(r.errorCode).toBe("MALFORMED_FUNCTION_CALL");
    expect(r.customMetadata).toMatchObject({ cacheCreationTokenCount: 9 });
  });

  it("streaming: the usage chunk records the write on the accumulator", () => {
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
          prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 11 },
        },
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    expect(acc.usage?.cachedContentTokenCount).toBe(5);
    expect(acc.cacheCreationTokens).toBe(11);
  });

  it("streaming: a usage chunk before the finish chunk puts the write on the final response", () => {
    const acc = createStreamAccumulator();
    const base = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
    };
    convertStreamChunk(
      {
        ...base,
        choices: [{ index: 0, delta: { content: "x" } }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 2,
          total_tokens: 22,
          prompt_tokens_details: { cache_write_tokens: 4 },
        },
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    const { response } = convertStreamChunk(
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    expect(response?.customMetadata).toEqual({ cacheCreationTokenCount: 4 });
    expect(acc.cacheCreationTokens).toBeUndefined();
  });
});

function message(usage: Record<string, unknown>): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Hi", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { cache_creation: null, ...usage },
  } as unknown as Anthropic.Message;
}

describe("Anthropic cache write", () => {
  it("non-stream: read -> cachedContentTokenCount, write -> customMetadata, prompt = sum", () => {
    const r = convertAnthropicResponse(
      message({
        input_tokens: 5,
        output_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 30,
      }),
    );
    expect(r.usageMetadata).toMatchObject({
      promptTokenCount: 135,
      cachedContentTokenCount: 100,
    });
    expect(r.customMetadata).toEqual({ cacheCreationTokenCount: 30 });
  });

  it("non-stream: a write of 0 is still reported", () => {
    const r = convertAnthropicResponse(
      message({
        input_tokens: 5,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    );
    expect(r.customMetadata).toEqual({ cacheCreationTokenCount: 0 });
  });

  it("non-stream: no cache fields -> no customMetadata", () => {
    const r = convertAnthropicResponse(
      message({ input_tokens: 5, output_tokens: 20 }),
    );
    expect(r.customMetadata).toBeUndefined();
  });

  it("stream: write -> customMetadata on the final event", () => {
    const acc = createAnthropicStreamAccumulator();
    convertAnthropicStreamEvent(
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 30,
          },
        },
      } as unknown as Anthropic.MessageStreamEvent,
      acc,
    );
    convertAnthropicStreamEvent(
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 20 },
      } as unknown as Anthropic.MessageStreamEvent,
      acc,
    );
    const { response } = convertAnthropicStreamEvent(
      { type: "message_stop" } as Anthropic.MessageStreamEvent,
      acc,
    );
    expect(response?.usageMetadata?.cachedContentTokenCount).toBe(100);
    expect(response?.customMetadata).toEqual({ cacheCreationTokenCount: 30 });
  });
});
