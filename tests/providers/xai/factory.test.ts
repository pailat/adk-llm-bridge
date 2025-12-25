import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config";
import { XAI } from "../../../src/providers/xai/factory";
import { XAILlm } from "../../../src/providers/xai/xai-llm";

describe("XAI factory", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.XAI_API_KEY;
  });

  it("creates XAILlm instance", () => {
    const llm = XAI("grok-4");
    expect(llm).toBeInstanceOf(XAILlm);
  });

  it("sets model correctly", () => {
    const llm = XAI("grok-4");
    expect(llm.model).toBe("grok-4");
  });

  it("accepts optional configuration", () => {
    const llm = XAI("grok-4", {
      apiKey: "test-key",
    });
    expect(llm.model).toBe("grok-4");
  });

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
