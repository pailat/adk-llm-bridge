import { describe, expect, it } from "bun:test";
import { OpenAICompatibleLlm } from "../../../src/core/openai-compatible-llm";
import { OpenRouter } from "../../../src/providers/openrouter";
import { describeProviderFactory } from "../../helpers/provider-test-helpers";

describeProviderFactory({
  name: "OpenRouter",
  factory: OpenRouter,
  expectedClass: OpenAICompatibleLlm,
  defaultModel: "anthropic/claude-sonnet-4",
  envVars: ["OPENROUTER_API_KEY"],
  defaultOptions: { apiKey: "test-key" },
});

describe("OpenRouter factory (provider-specific)", () => {
  it("accepts provider preferences", () => {
    const llm = OpenRouter("anthropic/claude-sonnet-4", {
      apiKey: "test-key",
      provider: {
        order: ["Anthropic", "Google"],
        allow_fallbacks: true,
        sort: "price",
      },
    });
    expect(llm.model).toBe("anthropic/claude-sonnet-4");
  });
});
