import { beforeEach, describe, expect, it } from "bun:test";
import { resetConfig } from "../../../src/config.js";
import { AI_GATEWAY_DEFINITION } from "../../../src/providers/ai-gateway/definition.js";
import { AIGatewayLlm } from "../../../src/providers/ai-gateway/index.js";
import { useCleanEnv } from "../../helpers/env.js";
import {
  describeConnectError,
  describeModelPatterns,
} from "../../helpers/provider-test-helpers.js";

describe("AIGatewayLlm", () => {
  useCleanEnv([
    "AI_GATEWAY_URL",
    "AI_GATEWAY_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
  ]);
  beforeEach(() => {
    resetConfig();
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

    it("does not send OPENAI_API_KEY to the gateway", () => {
      process.env.OPENAI_API_KEY = "openai-only-key";

      expect(
        () => new AIGatewayLlm({ model: "anthropic/claude-sonnet-4" }),
      ).toThrow("[ai-gateway] API key is required");
    });

    it("ignores OPENAI_BASE_URL", () => {
      process.env.OPENAI_BASE_URL = "https://openai-proxy.example.com/v1";
      process.env.AI_GATEWAY_API_KEY = "gateway-key";

      const llm = new AIGatewayLlm({ model: "openai/gpt-4o" });
      const client = (llm as unknown as { client: { baseURL: string } }).client;
      expect(client.baseURL).toBe("https://ai-gateway.vercel.sh/v1");
    });

    it("reads only its own environment variables", () => {
      expect(AI_GATEWAY_DEFINITION.envKeys.apiKey).toEqual([
        "AI_GATEWAY_API_KEY",
      ]);
      expect(AI_GATEWAY_DEFINITION.envKeys.baseURL).toEqual(["AI_GATEWAY_URL"]);
    });
  });

  describeConnectError(AIGatewayLlm, "anthropic/claude-sonnet-4");
});
