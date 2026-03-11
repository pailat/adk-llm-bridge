import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config";
import { OPENROUTER_DEFINITION } from "../../../src/providers/openrouter/definition";
import { OpenRouterLlm } from "../../../src/providers/openrouter";
import {
  describeModelPatterns,
  describeConnectError,
} from "../../helpers/provider-test-helpers";

describe("OpenRouterLlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_SITE_URL;
    delete process.env.OPENROUTER_APP_NAME;
  });

  describeModelPatterns({
    llmClass: OpenRouterLlm,
    patterns: OPENROUTER_DEFINITION.modelPatterns,
    validModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta/llama-3.1-70b",
      "mistral/mistral-large",
    ],
    invalidModels: [],
  });

  describe("constructor", () => {
    it("creates instance with model", () => {
      const llm = new OpenRouterLlm({ model: "anthropic/claude-sonnet-4" });
      expect(llm.model).toBe("anthropic/claude-sonnet-4");
    });

    it("uses OPENROUTER_API_KEY env var", () => {
      process.env.OPENROUTER_API_KEY = "test-openrouter-key";

      const llm = new OpenRouterLlm({ model: "openai/gpt-4o" });
      expect(llm.model).toBe("openai/gpt-4o");
    });

    it("accepts provider preferences", () => {
      const llm = new OpenRouterLlm({
        model: "anthropic/claude-sonnet-4",
        provider: {
          order: ["Anthropic"],
          allow_fallbacks: true,
          sort: "latency",
        },
      });
      expect(llm.model).toBe("anthropic/claude-sonnet-4");
    });

    it("accepts siteUrl and appName for ranking headers", () => {
      const llm = new OpenRouterLlm({
        model: "anthropic/claude-sonnet-4",
        siteUrl: "https://myapp.com",
        appName: "My App",
      });
      expect(llm.model).toBe("anthropic/claude-sonnet-4");
    });
  });

  describeConnectError(OpenRouterLlm, "anthropic/claude-sonnet-4");
});
