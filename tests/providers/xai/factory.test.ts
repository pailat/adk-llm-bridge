import { describe, expect, it } from "bun:test";
import { OpenAICompatibleLlm } from "../../../src/core/openai-compatible-llm";
import { XAI } from "../../../src/providers/xai";
import { describeProviderFactory } from "../../helpers/provider-test-helpers";

describeProviderFactory({
  name: "XAI",
  factory: XAI,
  expectedClass: OpenAICompatibleLlm,
  defaultModel: "grok-4",
  envVars: ["XAI_API_KEY"],
});

describe("XAI factory (provider-specific)", () => {
  it("accepts timeout and maxRetries options", () => {
    const llm = XAI("grok-4", {
      timeout: 30000,
      maxRetries: 5,
    });
    expect(llm.model).toBe("grok-4");
  });

  it("works with different grok models", () => {
    const models = ["grok-4", "grok-3-beta", "grok-code-fast-1"];
    for (const model of models) {
      const llm = XAI(model);
      expect(llm.model).toBe(model);
    }
  });
});
