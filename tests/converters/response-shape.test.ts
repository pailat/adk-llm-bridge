/**
 * ADK `LlmResponse` shape parity for the OpenAI-compatible converters:
 * - a content-filter finish with no content carries `errorCode: "SAFETY"`
 *   (ADK's `createLlmResponse` sets the finish reason as the error code when a
 *   candidate has no content), so the blank turn is detectable;
 * - `modelVersion` is the model the provider reports;
 * - the final streamed response says `partial: false`.
 */

import { describe, expect, it } from "bun:test";
import { FinishReason } from "@google/genai";
import type OpenAI from "openai";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response.js";

function completion(
  message: Record<string, unknown>,
  finish: string,
  model = "gpt-4o-2024-08-06",
): OpenAI.ChatCompletion {
  return {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", refusal: null, ...message },
        finish_reason: finish,
        logprobs: null,
      },
    ],
  } as unknown as OpenAI.ChatCompletion;
}

function chunk(
  delta: Record<string, unknown>,
  finish: string | null = null,
  model = "gpt-4o-2024-08-06",
): OpenAI.ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  } as unknown as OpenAI.ChatCompletionChunk;
}

describe("content-filter finish with no content", () => {
  it("non-streaming: carries errorCode SAFETY and a message", () => {
    const response = convertResponse(
      completion({ content: null }, "content_filter"),
    );
    expect(response.content).toBeUndefined();
    expect(response.finishReason).toBe(FinishReason.SAFETY);
    expect(response.errorCode).toBe(FinishReason.SAFETY);
    expect(response.errorMessage).toBe(
      "The provider blocked the response (content filter) and returned no content.",
    );
    expect(response.turnComplete).toBe(true);
  });

  it("streaming: carries errorCode SAFETY", () => {
    const acc = createStreamAccumulator();
    const { response, isComplete } = convertStreamChunk(
      chunk({}, "content_filter"),
      acc,
    );
    expect(isComplete).toBe(true);
    expect(response?.errorCode).toBe(FinishReason.SAFETY);
    expect(response?.finishReason).toBe(FinishReason.SAFETY);
  });

  it("keeps content and no errorCode when the filter cut a partial answer", () => {
    const response = convertResponse(
      completion({ content: "partial answer" }, "content_filter"),
    );
    expect(response.content?.parts).toEqual([{ text: "partial answer" }]);
    expect(response.finishReason).toBe(FinishReason.SAFETY);
    expect(response.errorCode).toBeUndefined();

    const acc = createStreamAccumulator();
    convertStreamChunk(chunk({ content: "cut" }), acc);
    const final = convertStreamChunk(chunk({}, "content_filter"), acc);
    expect(final.response?.content?.parts).toEqual([{ text: "cut" }]);
    expect(final.response?.errorCode).toBeUndefined();
  });

  it("other finishes with no content keep no errorCode", () => {
    for (const finish of ["stop", "length"]) {
      const response = convertResponse(completion({ content: null }, finish));
      expect(response.errorCode).toBeUndefined();
    }
  });
});

describe("modelVersion", () => {
  it("non-streaming: is the model the provider reports", () => {
    const response = convertResponse(
      completion({ content: "hi" }, "stop", "openai/gpt-4o-mini"),
    );
    expect(response.modelVersion).toBe("openai/gpt-4o-mini");
  });

  it("streaming: the final response carries the first chunk's model", () => {
    const acc = createStreamAccumulator();
    const first = convertStreamChunk(chunk({ content: "a" }), acc);
    expect(first.response?.partial).toBe(true);
    const final = convertStreamChunk(chunk({}, "stop"), acc);
    expect(final.response?.modelVersion).toBe("gpt-4o-2024-08-06");
  });

  it("is absent when the provider reports no model", () => {
    const response = convertResponse(completion({ content: "hi" }, "stop", ""));
    expect("modelVersion" in response).toBe(false);
  });

  it("is set on a malformed tool-call response too", () => {
    const response = convertResponse(
      completion(
        {
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "f", arguments: "{" },
            },
          ],
        },
        "tool_calls",
      ),
    );
    expect(response.errorCode).toBe(FinishReason.MALFORMED_FUNCTION_CALL);
    expect(response.modelVersion).toBe("gpt-4o-2024-08-06");
  });

  it("a fresh turn on a reused accumulator does not keep the old model", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(chunk({ content: "a" }, "stop", "m1"), acc);
    const second = convertStreamChunk(
      chunk({ content: "b" }, "stop", "m2"),
      acc,
    );
    expect(second.response?.modelVersion).toBe("m2");
  });
});

describe("final streamed response", () => {
  it("says partial: false", () => {
    const acc = createStreamAccumulator();
    const final = convertStreamChunk(chunk({ content: "a" }, "stop"), acc);
    expect(final.isComplete).toBe(true);
    expect(final.response?.partial).toBe(false);
  });

  it("says partial: false on a malformed tool-call final", () => {
    const acc = createStreamAccumulator();
    convertStreamChunk(
      chunk({
        tool_calls: [
          { index: 0, id: "t1", function: { name: "f", arguments: "{" } },
        ],
      }),
      acc,
    );
    const final = convertStreamChunk(chunk({}, "tool_calls"), acc);
    expect(final.response?.errorCode).toBe(
      FinishReason.MALFORMED_FUNCTION_CALL,
    );
    expect(final.response?.partial).toBe(false);
  });

  it("non-streaming responses do not set partial", () => {
    const response = convertResponse(completion({ content: "hi" }, "stop"));
    expect("partial" in response).toBe(false);
  });
});
