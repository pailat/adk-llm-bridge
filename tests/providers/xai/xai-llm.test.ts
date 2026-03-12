import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config";
import { XAI_DEFINITION } from "../../../src/providers/xai/definition";
import { XAILlm } from "../../../src/providers/xai";
import {
  describeModelPatterns,
  describeConnectError,
} from "../../helpers/provider-test-helpers";

describe("XAILlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.XAI_API_KEY;
  });

  describeModelPatterns({
    llmClass: XAILlm,
    patterns: XAI_DEFINITION.modelPatterns,
    validModels: [
      "grok-4",
      "grok-3-beta",
      "grok-3-mini-beta",
      "grok-4-1-fast-reasoning",
      "grok-4-1-fast-non-reasoning",
      "grok-code-fast-1",
    ],
    invalidModels: [
      "gpt-4.1",
      "claude-sonnet-4",
      "gemini-2.0-flash",
      "llama-3.1",
    ],
  });

  describe("constructor", () => {
    it("creates instance with apiKey", () => {
      const llm = new XAILlm({ model: "grok-4", apiKey: "test-key" });
      expect(llm.model).toBe("grok-4");
    });

    it("uses XAI_API_KEY env var", () => {
      process.env.XAI_API_KEY = "test-xai-key";

      const llm = new XAILlm({ model: "grok-4" });
      expect(llm.model).toBe("grok-4");
    });

    it("throws when no API key provided", () => {
      expect(() => new XAILlm({ model: "grok-4" })).toThrow(
        "[xai] API key is required",
      );
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
        apiKey: "test-key",
        timeout: 30000,
      });
      expect(llm.model).toBe("grok-4");
    });

    it("accepts maxRetries option", () => {
      const llm = new XAILlm({
        model: "grok-4",
        apiKey: "test-key",
        maxRetries: 5,
      });
      expect(llm.model).toBe("grok-4");
    });
  });

  describeConnectError(XAILlm, "grok-4");
});
