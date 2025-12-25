import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config";
import { OPENROUTER_MODEL_PATTERNS } from "../../../src/constants";
import { OpenRouterLlm } from "../../../src/providers/openrouter/openrouter-llm";

describe("OpenRouterLlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_SITE_URL;
    delete process.env.OPENROUTER_APP_NAME;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(OpenRouterLlm.supportedModels).toBeDefined();
      expect(Array.isArray(OpenRouterLlm.supportedModels)).toBe(true);
    });

    it("matches OPENROUTER_MODEL_PATTERNS", () => {
      expect(OpenRouterLlm.supportedModels).toEqual(OPENROUTER_MODEL_PATTERNS);
    });

    it("patterns match expected model formats", () => {
      const testModels = [
        "anthropic/claude-sonnet-4",
        "openai/gpt-4o",
        "google/gemini-2.0-flash",
        "meta/llama-3.1-70b",
        "mistral/mistral-large",
      ];

      for (const model of testModels) {
        const matches = OPENROUTER_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });
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

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new OpenRouterLlm({
        model: "anthropic/claude-sonnet-4",
        apiKey: "test",
      });

      const request = {
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      } as Parameters<typeof llm.connect>[0];

      expect(llm.connect(request)).rejects.toThrow(
        "does not support bidirectional streaming",
      );
    });
  });
});
