import { beforeEach, describe, expect, it } from "bun:test";
import { resetConfig } from "../../../src/config";
import { AI_GATEWAY_DEFINITION } from "../../../src/providers/ai-gateway/definition";
import { AIGatewayLlm } from "../../../src/providers/ai-gateway";
import {
  describeModelPatterns,
  describeConnectError,
} from "../../helpers/provider-test-helpers";

describe("AIGatewayLlm", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.AI_GATEWAY_URL;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  });

  describeModelPatterns({
    llmClass: AIGatewayLlm,
    patterns: AI_GATEWAY_DEFINITION.modelPatterns,
    validModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta/llama-3.1-70b",
      "mistral/mistral-large",
      "xai/grok-2",
      "deepseek/deepseek-chat",
      "groq/llama-3.1-70b",
    ],
    invalidModels: [],
  });

  describe("constructor", () => {
    it("uses default base URL when no env vars", () => {
      const llm = new AIGatewayLlm({
        model: "anthropic/claude-sonnet-4",
        apiKey: "test-key",
      });
      expect(llm.model).toBe("anthropic/claude-sonnet-4");
    });

    it("uses AI_GATEWAY_URL env var", () => {
      process.env.AI_GATEWAY_URL = "https://custom.gateway.com/v1";
      process.env.AI_GATEWAY_API_KEY = "test-key";

      const llm = new AIGatewayLlm({ model: "openai/gpt-4o" });
      expect(llm.model).toBe("openai/gpt-4o");
    });

    it("throws when no API key provided", () => {
      expect(
        () => new AIGatewayLlm({ model: "anthropic/claude-sonnet-4" }),
      ).toThrow("[ai-gateway] API key is required");
    });
  });

  describeConnectError(AIGatewayLlm, "anthropic/claude-sonnet-4");
});
