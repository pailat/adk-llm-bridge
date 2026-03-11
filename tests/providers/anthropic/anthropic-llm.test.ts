import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config";
import {
  AnthropicLlm,
  ANTHROPIC_MODEL_PATTERNS,
} from "../../../src/providers/anthropic";
import {
  describeModelPatterns,
  describeConnectError,
} from "../../helpers/provider-test-helpers";

describe("AnthropicLlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.ANTHROPIC_API_KEY;
  });

  describeModelPatterns({
    llmClass: AnthropicLlm,
    patterns: ANTHROPIC_MODEL_PATTERNS,
    validModels: [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5-20251101",
      "claude-haiku-4-5-20251001",
      "claude-3-5-haiku-latest",
      "claude-3-opus-20240229",
      "claude-3-haiku-20240307",
    ],
    invalidModels: [
      "gpt-4.1",
      "grok-4",
      "gemini-2.0-flash",
      "llama-3.1",
    ],
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

  describeConnectError(AnthropicLlm, "claude-sonnet-4-5-20250929");
});
