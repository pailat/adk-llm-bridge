import { describe, expect, it } from "bun:test";
import { OpenAICompatibleLlm } from "../../../src/core/openai-compatible-llm";
import { AIGateway } from "../../../src/providers/ai-gateway";
import { describeProviderFactory } from "../../helpers/provider-test-helpers";

describeProviderFactory({
  name: "AIGateway",
  factory: AIGateway,
  expectedClass: OpenAICompatibleLlm,
  defaultModel: "anthropic/claude-sonnet-4",
  envVars: ["AI_GATEWAY_URL", "AI_GATEWAY_API_KEY"],
  defaultOptions: { apiKey: "test-key" },
});

describe("AIGateway factory (provider-specific)", () => {
  it("works with different providers", () => {
    const models = [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta/llama-3.1-70b",
    ];

    for (const model of models) {
      const llm = AIGateway(model, { apiKey: "test-key" });
      expect(llm.model).toBe(model);
    }
  });
});
