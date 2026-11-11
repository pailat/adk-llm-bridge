/**
 * Billed cost: `usage.cost` (AI Gateway, OpenRouter) surfaces as
 * `customMetadata.costUsd`; the gateway's `market_cost` as `marketCostUsd`.
 * Shapes recorded from a live AI Gateway call (haiku, 2026-11-11).
 */

import { describe, expect, it } from "bun:test";
import type OpenAI from "openai";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../../src/converters/response.js";

function completion(usage: Record<string, unknown> | undefined) {
  return {
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hi" },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  } as unknown as OpenAI.ChatCompletion;
}

const base = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

describe("billed cost from usage.cost", () => {
  it("maps usage.cost to customMetadata.costUsd", () => {
    const r = convertResponse(completion({ ...base, cost: 0.00123 }));
    expect(r.customMetadata).toEqual({
      costUsd: 0.00123,
      costSource: "cost",
    });
  });

  it("a BYOK call costs its upstream inference cost, not 0 (live shape)", () => {
    const r = convertResponse(
      completion({
        ...base,
        cost: 0,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.00069 },
        market_cost: 0.00069,
      }),
    );
    expect(r.customMetadata).toEqual({
      costUsd: 0.00069,
      costSource: "cost+upstream",
      marketCostUsd: 0.00069,
    });
  });

  it("a non-BYOK call ignores upstream_inference_cost; a BYOK cost adds to a debited cost", () => {
    const upstream = { upstream_inference_cost: 0.4 };
    expect(
      convertResponse(
        completion({
          ...base,
          cost: 0.1,
          is_byok: false,
          cost_details: upstream,
        }),
      ).customMetadata,
    ).toEqual({ costUsd: 0.1, costSource: "cost" });
    expect(
      convertResponse(
        completion({
          ...base,
          cost: 0.1,
          is_byok: true,
          cost_details: upstream,
        }),
      ).customMetadata,
    ).toEqual({ costUsd: 0.5, costSource: "cost+upstream" });
    expect(
      convertResponse(
        completion({ ...base, is_byok: true, cost_details: upstream }),
      ).customMetadata,
    ).toEqual({ costUsd: 0.4, costSource: "cost+upstream" });
  });

  it("a BYOK call with a debited cost of 0 and no upstream figure reports 0", () => {
    expect(
      convertResponse(completion({ ...base, cost: 0, is_byok: true }))
        .customMetadata,
    ).toEqual({ costUsd: 0, costSource: "cost" });
  });

  // Pilot, measured 2026-11-11 on the AI Gateway key in use (sonnet 5.5,
  // 60.9K in / 8.8K out): is_byok, usage.cost 0, no usable upstream cost, the
  // charge only in market_cost.
  const PILOT_BYOK = {
    prompt_tokens: 60902,
    completion_tokens: 8791,
    total_tokens: 69693,
    cost: 0,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0 },
    market_cost: 0.240163,
  };

  it("pilot BYOK shape: no usable upstream cost, the charge is market_cost", () => {
    const expected = {
      costUsd: 0.240163,
      costSource: "market_cost",
      marketCostUsd: 0.240163,
    };
    expect(convertResponse(completion(PILOT_BYOK)).customMetadata).toEqual(
      expected,
    );
    // upstream_inference_cost absent or null is the same shape.
    for (const details of [undefined, null, {}]) {
      const usage: Record<string, unknown> = { ...PILOT_BYOK };
      if (details === undefined) delete usage.cost_details;
      else usage.cost_details = details;
      expect(convertResponse(completion(usage)).customMetadata).toEqual(
        expected,
      );
    }
  });

  it("BYOK with a non-zero cost and no upstream: market_cost is the charge, not cost + market_cost", () => {
    const r = convertResponse(
      completion({ ...PILOT_BYOK, cost: 0.05, cost_details: null }),
    );
    expect(r.customMetadata).toEqual({
      costUsd: 0.240163,
      costSource: "market_cost",
      marketCostUsd: 0.240163,
    });
  });

  it("OpenRouter upstream shape: cost + upstream, market_cost is not used", () => {
    const r = convertResponse(
      completion({
        ...base,
        cost: 0.002,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0171 },
        market_cost: 0.5,
      }),
    );
    expect(r.customMetadata).toEqual({
      costUsd: 0.0191,
      costSource: "cost+upstream",
      marketCostUsd: 0.5,
    });
  });

  it("a non-BYOK call keeps cost and never takes market_cost", () => {
    const r = convertResponse(
      completion({ ...base, cost: 0.1, is_byok: false, market_cost: 0.09 }),
    );
    expect(r.customMetadata).toEqual({
      costUsd: 0.1,
      costSource: "cost",
      marketCostUsd: 0.09,
    });
    // is_byok absent: not BYOK.
    expect(
      convertResponse(completion({ ...base, cost: 0.1, market_cost: 0.09 }))
        .customMetadata,
    ).toMatchObject({ costUsd: 0.1, costSource: "cost" });
  });

  it("streaming: the pilot BYOK shape ends on the final response with the source", () => {
    const acc = createStreamAccumulator();
    const chunk = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
    };
    convertStreamChunk(
      {
        ...chunk,
        choices: [],
        usage: PILOT_BYOK,
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    const out = convertStreamChunk(
      {
        ...chunk,
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    expect(out.response?.customMetadata).toEqual({
      costUsd: 0.240163,
      costSource: "market_cost",
      marketCostUsd: 0.240163,
    });
    expect(acc.costSource).toBeUndefined();
  });

  it("ignores a cost that is not a finite non-negative number", () => {
    for (const bad of ["0.5", null, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const r = convertResponse(completion({ ...base, cost: bad }));
      expect(r.customMetadata).toBeUndefined();
    }
  });

  it("adds nothing when the provider reports no cost", () => {
    expect(convertResponse(completion(base)).customMetadata).toBeUndefined();
  });

  it("sits next to the cache write", () => {
    const r = convertResponse(
      completion({ ...base, cost: 0.5, cache_creation_input_tokens: 3 }),
    );
    expect(r.customMetadata).toEqual({
      costUsd: 0.5,
      costSource: "cost",
      cacheCreationTokenCount: 3,
    });
  });

  it("streaming: the usage chunk records the cost and it lands on the final response", () => {
    const acc = createStreamAccumulator();
    const chunk = {
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
    };
    convertStreamChunk(
      {
        ...chunk,
        choices: [],
        usage: { ...base, cost: 0.25, market_cost: 0.3 },
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    expect(acc.costUsd).toBe(0.25);
    const out = convertStreamChunk(
      {
        ...chunk,
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }],
      } as unknown as OpenAI.ChatCompletionChunk,
      acc,
    );
    expect(out.response?.customMetadata).toEqual({
      costUsd: 0.25,
      costSource: "cost",
      marketCostUsd: 0.3,
    });
    expect(acc.costUsd).toBeUndefined();
  });
});
