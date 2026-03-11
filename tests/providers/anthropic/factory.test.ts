import { describe, expect, it } from "bun:test";
import { Anthropic, AnthropicLlm } from "../../../src/providers/anthropic";
import { describeProviderFactory } from "../../helpers/provider-test-helpers";

describeProviderFactory({
  name: "Anthropic",
  factory: Anthropic,
  expectedClass: AnthropicLlm,
  defaultModel: "claude-sonnet-4-5-20250929",
  envVars: ["ANTHROPIC_API_KEY"],
});

describe("Anthropic factory (provider-specific)", () => {
  it("accepts maxTokens option", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      maxTokens: 8192,
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("accepts timeout and maxRetries options", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      timeout: 30000,
      maxRetries: 5,
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("works with different claude models", () => {
    const models = [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      "claude-3-5-haiku-latest",
    ];
    for (const model of models) {
      const llm = Anthropic(model);
      expect(llm.model).toBe(model);
    }
  });
});
