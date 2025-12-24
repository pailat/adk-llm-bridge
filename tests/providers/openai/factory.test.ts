import { describe, it, expect, beforeEach } from "bun:test";
import { OpenAI } from "../../../src/providers/openai/factory";
import { OpenAILlm } from "../../../src/providers/openai/openai-llm";
import { resetAllConfigs } from "../../../src/config";

describe("OpenAI factory", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENAI_API_KEY;
  });

  it("creates OpenAILlm instance", () => {
    const llm = OpenAI("gpt-4.1");
    expect(llm).toBeInstanceOf(OpenAILlm);
  });

  it("sets model correctly", () => {
    const llm = OpenAI("gpt-4o");
    expect(llm.model).toBe("gpt-4o");
  });

  it("accepts optional configuration", () => {
    const llm = OpenAI("gpt-4.1", {
      apiKey: "test-key",
    });
    expect(llm.model).toBe("gpt-4.1");
  });

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
