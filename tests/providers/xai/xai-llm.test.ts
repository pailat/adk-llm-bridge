import { describe, it, expect, beforeEach } from "bun:test";
import { XAILlm } from "../../../src/providers/xai/xai-llm";
import { XAI_MODEL_PATTERNS } from "../../../src/providers/xai/constants";
import { resetAllConfigs } from "../../../src/config";

describe("XAILlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.XAI_API_KEY;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(XAILlm.supportedModels).toBeDefined();
      expect(Array.isArray(XAILlm.supportedModels)).toBe(true);
    });

    it("matches XAI_MODEL_PATTERNS", () => {
      expect(XAILlm.supportedModels).toEqual(XAI_MODEL_PATTERNS);
    });

    it("patterns match grok-* models", () => {
      const grokModels = [
        "grok-4",
        "grok-3-beta",
        "grok-3-mini-beta",
        "grok-4-1-fast-reasoning",
        "grok-4-1-fast-non-reasoning",
        "grok-code-fast-1",
      ];

      for (const model of grokModels) {
        const matches = XAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });

    it("patterns do not match non-xAI models", () => {
      const nonXAIModels = [
        "gpt-4.1",
        "claude-sonnet-4",
        "gemini-2.0-flash",
        "llama-3.1",
      ];

      for (const model of nonXAIModels) {
        const matches = XAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(false);
      }
    });
  });

  describe("constructor", () => {
    it("creates instance with model", () => {
      const llm = new XAILlm({ model: "grok-4" });
      expect(llm.model).toBe("grok-4");
    });

    it("uses XAI_API_KEY env var", () => {
      process.env.XAI_API_KEY = "test-xai-key";

      const llm = new XAILlm({ model: "grok-4" });
      expect(llm.model).toBe("grok-4");
    });

    it("accepts explicit apiKey", () => {
      const llm = new XAILlm({
        model: "grok-4",
        apiKey: "xai-test-key",
      });
      expect(llm.model).toBe("grok-4");
    });

    it("accepts timeout option", () => {
      const llm = new XAILlm({
        model: "grok-4",
        timeout: 30000,
      });
      expect(llm.model).toBe("grok-4");
    });

    it("accepts maxRetries option", () => {
      const llm = new XAILlm({
        model: "grok-4",
        maxRetries: 5,
      });
      expect(llm.model).toBe("grok-4");
    });
  });

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new XAILlm({
        model: "grok-4",
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
