import { beforeEach, describe, expect, it } from "bun:test";
import { resetConfig } from "../../../src/config";
import { AIGatewayLlm } from "../../../src/providers/ai-gateway/ai-gateway-llm";
import { AIGateway } from "../../../src/providers/ai-gateway/factory";

describe("AIGateway factory", () => {
  beforeEach(() => {
    resetConfig();
    delete process.env.AI_GATEWAY_URL;
    delete process.env.AI_GATEWAY_API_KEY;
  });

  it("creates AIGatewayLlm instance", () => {
    const llm = AIGateway("anthropic/claude-sonnet-4");
    expect(llm).toBeInstanceOf(AIGatewayLlm);
    expect(llm.model).toBe("anthropic/claude-sonnet-4");
  });

  it("passes options to AIGatewayLlm", () => {
    const llm = AIGateway("openai/gpt-4o", {
      apiKey: "test-key",
      timeout: 30000,
    });
    expect(llm.model).toBe("openai/gpt-4o");
  });

  it("works with different providers", () => {
    const models = [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4o",
      "google/gemini-2.0-flash",
      "meta/llama-3.1-70b",
    ];

    for (const model of models) {
      const llm = AIGateway(model);
      expect(llm.model).toBe(model);
    }
  });
});
