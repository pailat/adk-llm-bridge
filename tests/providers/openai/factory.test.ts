import { describe, expect, it } from "bun:test";
import { OpenAICompatibleLlm } from "../../../src/core/openai-compatible-llm";
import { OpenAI } from "../../../src/providers/openai";
import { describeProviderFactory } from "../../helpers/provider-test-helpers";

describeProviderFactory({
  name: "OpenAI",
  factory: OpenAI,
  expectedClass: OpenAICompatibleLlm,
  defaultModel: "gpt-4.1",
  envVars: ["OPENAI_API_KEY"],
});

describe("OpenAI factory (provider-specific)", () => {
  it("accepts organization option", () => {
    const llm = OpenAI("gpt-4.1", {
      apiKey: "test-key",
      organization: "org-xxx",
    });
    expect(llm.model).toBe("gpt-4.1");
  });

  it("accepts project option", () => {
    const llm = OpenAI("gpt-4.1", {
      apiKey: "test-key",
      project: "proj-xxx",
    });
    expect(llm.model).toBe("gpt-4.1");
  });

  it("accepts timeout and maxRetries options", () => {
    const llm = OpenAI("gpt-4.1", {
      timeout: 30000,
      maxRetries: 5,
    });
    expect(llm.model).toBe("gpt-4.1");
  });
});
