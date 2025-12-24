import { describe, it, expect, beforeEach } from "bun:test";
import { AnthropicLlm } from "../../../src/providers/anthropic/anthropic-llm";
import { ANTHROPIC_MODEL_PATTERNS } from "../../../src/providers/anthropic/constants";
import { resetAllConfigs } from "../../../src/config";

describe("AnthropicLlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.ANTHROPIC_API_KEY;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(AnthropicLlm.supportedModels).toBeDefined();
      expect(Array.isArray(AnthropicLlm.supportedModels)).toBe(true);
    });

    it("matches ANTHROPIC_MODEL_PATTERNS", () => {
      expect(AnthropicLlm.supportedModels).toEqual(ANTHROPIC_MODEL_PATTERNS);
    });

    it("patterns match claude-* models", () => {
      const claudeModels = [
        "claude-sonnet-4-5-20250929",
        "claude-opus-4-5-20251101",
        "claude-haiku-4-5-20251001",
        "claude-3-5-haiku-latest",
        "claude-3-opus-20240229",
        "claude-3-haiku-20240307",
      ];

      for (const model of claudeModels) {
        const matches = ANTHROPIC_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });

    it("patterns do not match non-Anthropic models", () => {
      const nonAnthropicModels = [
        "gpt-4.1",
        "grok-4",
        "gemini-2.0-flash",
        "llama-3.1",
      ];

      for (const model of nonAnthropicModels) {
        const matches = ANTHROPIC_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(false);
      }
    });
  });

  describe("constructor", () => {
    it("creates instance with model", () => {
      const llm = new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("uses ANTHROPIC_API_KEY env var", () => {
      process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

      const llm = new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts explicit apiKey", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        apiKey: "sk-ant-test-key",
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts maxTokens option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        maxTokens: 8192,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts timeout option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        timeout: 30000,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });

    it("accepts maxRetries option", () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
        maxRetries: 5,
      });
      expect(llm.model).toBe("claude-sonnet-4-5-20250929");
    });
  });

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new AnthropicLlm({
        model: "claude-sonnet-4-5-20250929",
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
