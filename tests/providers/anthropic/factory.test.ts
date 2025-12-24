import { describe, it, expect, beforeEach } from "bun:test";
import { Anthropic } from "../../../src/providers/anthropic/factory";
import { AnthropicLlm } from "../../../src/providers/anthropic/anthropic-llm";
import { resetAllConfigs } from "../../../src/config";

describe("Anthropic factory", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("creates AnthropicLlm instance", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929");
    expect(llm).toBeInstanceOf(AnthropicLlm);
  });

  it("sets model correctly", () => {
    const llm = Anthropic("claude-opus-4-5");
    expect(llm.model).toBe("claude-opus-4-5");
  });

  it("accepts optional configuration", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      apiKey: "test-key",
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

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
