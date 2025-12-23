import { describe, it, expect, beforeEach } from "bun:test";
import { OpenRouter } from "../../../src/providers/openrouter/factory";
import { OpenRouterLlm } from "../../../src/providers/openrouter/openrouter-llm";
import { resetAllConfigs } from "../../../src/config";

describe("OpenRouter factory", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENROUTER_API_KEY;
  });

  it("creates OpenRouterLlm instance", () => {
    const llm = OpenRouter("anthropic/claude-sonnet-4");
    expect(llm).toBeInstanceOf(OpenRouterLlm);
  });

  it("sets model correctly", () => {
    const llm = OpenRouter("openai/gpt-4o");
    expect(llm.model).toBe("openai/gpt-4o");
  });

  it("accepts optional configuration", () => {
    const llm = OpenRouter("anthropic/claude-sonnet-4", {
      apiKey: "test-key",
      siteUrl: "https://myapp.com",
      appName: "My App",
    });
    expect(llm.model).toBe("anthropic/claude-sonnet-4");
  });

  it("accepts provider preferences", () => {
    const llm = OpenRouter("anthropic/claude-sonnet-4", {
      provider: {
        order: ["Anthropic", "Google"],
        allow_fallbacks: true,
        sort: "price",
      },
    });
    expect(llm.model).toBe("anthropic/claude-sonnet-4");
  });
});
