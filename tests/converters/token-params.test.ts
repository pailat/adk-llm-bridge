import { describe, expect, it } from "bun:test";
import type { LlmRequest } from "@google/adk";
import {
  convertGenerationConfig,
  convertReasoningConfig,
  convertRequest,
  supportsReasoningEffort,
  usesMaxCompletionTokens,
} from "../../src/converters/request.js";
import { OPENAI_DEFINITION } from "../../src/providers/openai/definition.js";
import { XAI_DEFINITION } from "../../src/providers/xai/definition.js";

function request(config: LlmRequest["config"]): LlmRequest {
  return { contents: [], config, liveConnectConfig: {}, toolsDict: {} };
}

describe("OpenAI reasoning models by family and version", () => {
  const reasoning = [
    "gpt-5",
    "gpt-5.1-codex",
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6.1-terra",
    "gpt-6-luna",
    "openai/gpt-6.1-sol",
    "GPT-6-Luna",
    "gpt-7",
    "gpt-10-mini",
    "o1",
    "o3-mini",
    "o4-mini",
    "o5",
    "openai/o3",
  ];
  const chat = [
    "gpt-4.1",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-3.5-turbo",
    "chatgpt-4o-latest",
    "grok-4.7",
    "llama3",
    "",
  ];

  for (const model of reasoning) {
    it(`${model}: max_completion_tokens, no sampling knobs, reasoning_effort`, () => {
      expect(usesMaxCompletionTokens(model)).toBe(true);
      expect(supportsReasoningEffort(model)).toBe(true);
      const params = convertGenerationConfig(
        request({ maxOutputTokens: 64, temperature: 0.2, topP: 0.9 }),
        model,
      );
      expect(params).toEqual({ max_completion_tokens: 64 });
      expect(
        convertReasoningConfig(
          request({ thinkingConfig: { thinkingBudget: 1024 } }),
          model,
        ),
      ).toEqual({ reasoning_effort: "low" });
    });
  }

  for (const model of chat) {
    it(`${JSON.stringify(model)}: max_tokens by default`, () => {
      expect(usesMaxCompletionTokens(model)).toBe(false);
      expect(
        convertGenerationConfig(
          request({ maxOutputTokens: 64 }),
          model || undefined,
        ),
      ).toEqual({ max_tokens: 64 });
    });
  }
});

describe("max_completion_tokens as the provider default", () => {
  it("the OpenAI provider sends max_completion_tokens for chat models too", () => {
    expect(OPENAI_DEFINITION.maxTokensParam).toBe("max_completion_tokens");
    const params = convertGenerationConfig(
      request({ maxOutputTokens: 64, temperature: 0.2 }),
      "gpt-4.1",
      { maxTokensParam: "max_completion_tokens" },
    );
    // A chat model keeps its sampling knobs.
    expect(params).toEqual({ max_completion_tokens: 64, temperature: 0.2 });
  });

  it("convertRequest forwards the provider default", () => {
    const { params } = convertRequest(
      request({ maxOutputTokens: 32 }),
      "gpt-4o",
      {
        maxTokensParam: "max_completion_tokens",
      },
    );
    expect(params).toEqual({ max_completion_tokens: 32 });
  });

  it("other providers keep max_tokens", () => {
    expect(XAI_DEFINITION.maxTokensParam).toBeUndefined();
    expect(
      convertGenerationConfig(request({ maxOutputTokens: 64 }), "grok-4.7"),
    ).toEqual({
      max_tokens: 64,
    });
  });
});

describe("Grok reasoning_effort", () => {
  it("keeps grok-3-mini and explicit -reasoning variants", () => {
    expect(supportsReasoningEffort("grok-3-mini")).toBe(true);
    expect(supportsReasoningEffort("x-ai/grok-4-fast-reasoning")).toBe(true);
  });

  it("does not treat -non-reasoning variants as reasoners", () => {
    expect(supportsReasoningEffort("grok-4-fast-non-reasoning")).toBe(false);
    expect(supportsReasoningEffort("grok-4-1-fast-non-reasoning")).toBe(false);
  });

  it("does not send reasoning_effort to Grok 4.x, which reasons on its own", () => {
    for (const model of [
      "grok-4",
      "grok-4.5",
      "grok-4.6",
      "spacexai/grok-4.7",
    ]) {
      expect(supportsReasoningEffort(model)).toBe(false);
    }
  });
});

describe("OpenAI fine-tuned model ids", () => {
  for (const model of [
    "ft:o4-mini-2025-04-16:org::abc123",
    "ft:gpt-6.1-sol:org:custom:xyz",
    "openai/ft:o4-mini:org::abc",
  ]) {
    it(`${model} is a reasoning model`, () => {
      expect(usesMaxCompletionTokens(model)).toBe(true);
      expect(supportsReasoningEffort(model)).toBe(true);
      expect(
        convertGenerationConfig(
          request({ maxOutputTokens: 64, temperature: 0.2, topP: 0.9 }),
          model,
        ),
      ).toEqual({ max_completion_tokens: 64 });
      expect(
        convertReasoningConfig(
          request({ thinkingConfig: { thinkingBudget: 1024 } }),
          model,
        ),
      ).toEqual({ reasoning_effort: "low" });
    });
  }

  it("ft:gpt-4o-mini is not a reasoning model", () => {
    const model = "ft:gpt-4o-mini-2024-07-18:org::abc";
    expect(usesMaxCompletionTokens(model)).toBe(false);
    expect(supportsReasoningEffort(model)).toBe(false);
    expect(
      convertGenerationConfig(
        request({ maxOutputTokens: 64, temperature: 0.2 }),
        model,
      ),
    ).toEqual({ max_tokens: 64, temperature: 0.2 });
  });
});

describe("fine-tune suffix", () => {
  it("cuts the suffix right after the base model", () => {
    expect(usesMaxCompletionTokens("ft:o3:org::abc")).toBe(true);
    expect(supportsReasoningEffort("ft:o3:org::abc")).toBe(true);
  });

  it("ignores words in the suffix", () => {
    expect(supportsReasoningEffort("ft:grok-3:reasoning-lab::x")).toBe(false);
  });
});
