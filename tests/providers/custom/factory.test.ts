import { describe, expect, it } from "bun:test";
import { CustomLlm } from "../../../src/providers/custom/custom-llm";
import { Custom, createCustomLlm } from "../../../src/providers/custom/factory";

describe("createCustomLlm", () => {
  it("creates a CustomLlm instance", () => {
    const llm = createCustomLlm({
      model: "llama3",
      baseURL: "http://localhost:11434/v1",
    });
    expect(llm).toBeInstanceOf(CustomLlm);
    expect(llm.model).toBe("llama3");
  });

  it("passes all config options", () => {
    const llm = createCustomLlm({
      name: "ollama",
      model: "llama3",
      baseURL: "http://localhost:11434/v1",
      apiKey: "test-key",
      timeout: 30000,
      maxRetries: 3,
      headers: { "X-Custom": "value" },
      queryParams: { "api-version": "2024-02-01" },
      providerOptions: { temperature: 0.7 },
    });
    expect(llm).toBeInstanceOf(CustomLlm);
    expect(llm.model).toBe("llama3");
  });

  describe("common use cases", () => {
    it("works for Ollama", () => {
      const llm = createCustomLlm({
        name: "ollama",
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      expect(llm.model).toBe("llama3");
    });

    it("works for vLLM", () => {
      const llm = createCustomLlm({
        name: "vllm",
        model: "meta-llama/Llama-3-8b",
        baseURL: "http://localhost:8000/v1",
      });
      expect(llm.model).toBe("meta-llama/Llama-3-8b");
    });

    it("works for Azure OpenAI", () => {
      const llm = createCustomLlm({
        name: "azure",
        model: "gpt-4",
        baseURL:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
        apiKey: "azure-key",
        headers: { "api-key": "azure-key" },
        queryParams: { "api-version": "2024-02-01" },
      });
      expect(llm.model).toBe("gpt-4");
    });

    it("works for LM Studio", () => {
      const llm = createCustomLlm({
        name: "lmstudio",
        model: "local-model",
        baseURL: "http://localhost:1234/v1",
      });
      expect(llm.model).toBe("local-model");
    });
  });
});

describe("Custom", () => {
  it("creates a CustomLlm instance", () => {
    const llm = Custom("llama3", {
      baseURL: "http://localhost:11434/v1",
    });
    expect(llm).toBeInstanceOf(CustomLlm);
    expect(llm.model).toBe("llama3");
  });

  it("accepts model as first argument", () => {
    const llm = Custom("my-model", {
      baseURL: "http://localhost:8000/v1",
    });
    expect(llm.model).toBe("my-model");
  });

  it("passes all config options", () => {
    const llm = Custom("gpt-4", {
      name: "azure",
      baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
      apiKey: "azure-key",
      headers: { "api-key": "azure-key" },
      queryParams: { "api-version": "2024-02-01" },
      providerOptions: { temperature: 0.7 },
    });
    expect(llm).toBeInstanceOf(CustomLlm);
    expect(llm.model).toBe("gpt-4");
  });

  it("provides shorthand for simple cases", () => {
    // Minimal usage
    const llm = Custom("llama3", {
      baseURL: "http://localhost:11434/v1",
    });
    expect(llm.model).toBe("llama3");
  });
});

describe("export consistency", () => {
  it("createCustomLlm and Custom produce equivalent results", () => {
    const llm1 = createCustomLlm({
      name: "test",
      model: "llama3",
      baseURL: "http://localhost:11434/v1",
      apiKey: "key",
    });

    const llm2 = Custom("llama3", {
      name: "test",
      baseURL: "http://localhost:11434/v1",
      apiKey: "key",
    });

    expect(llm1.model).toBe(llm2.model);
    expect(llm1).toBeInstanceOf(CustomLlm);
    expect(llm2).toBeInstanceOf(CustomLlm);
  });
});
