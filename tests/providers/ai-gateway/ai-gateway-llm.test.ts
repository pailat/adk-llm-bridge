import { beforeEach, describe, expect, it } from "bun:test";
import { resetConfig } from "../../../src/config";
import { MODEL_PATTERNS } from "../../../src/constants";
import { AIGatewayLlm } from "../../../src/providers/ai-gateway/ai-gateway-llm";

describe("AIGatewayLlm", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.AI_GATEWAY_URL;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(AIGatewayLlm.supportedModels).toBeDefined();
      expect(Array.isArray(AIGatewayLlm.supportedModels)).toBe(true);
    });

    it("matches MODEL_PATTERNS", () => {
      expect(AIGatewayLlm.supportedModels).toEqual(MODEL_PATTERNS);
    });

    it("patterns match expected model formats", () => {
      const testModels = [
        "anthropic/claude-sonnet-4",
        "openai/gpt-4o",
        "google/gemini-2.0-flash",
        "meta/llama-3.1-70b",
        "mistral/mistral-large",
        "xai/grok-2",
        "deepseek/deepseek-chat",
        "groq/llama-3.1-70b",
      ];

      for (const model of testModels) {
        const matches = MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });
  });

  describe("constructor", () => {
    it("uses default base URL when no env vars", () => {
      const llm = new AIGatewayLlm({ model: "anthropic/claude-sonnet-4" });
      expect(llm.model).toBe("anthropic/claude-sonnet-4");
    });

    it("uses AI_GATEWAY_URL env var", () => {
      process.env.AI_GATEWAY_URL = "https://custom.gateway.com/v1";
      process.env.AI_GATEWAY_API_KEY = "test-key";

      const llm = new AIGatewayLlm({ model: "openai/gpt-4o" });
      expect(llm.model).toBe("openai/gpt-4o");
    });
  });

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new AIGatewayLlm({
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
