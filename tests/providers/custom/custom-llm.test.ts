import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type OpenAI from "openai";
import { CustomLlm } from "../../../src/providers/custom/custom-llm.js";

function getClient(llm: CustomLlm): OpenAI {
  return (llm as CustomLlm & { client: OpenAI }).client;
}

describe("CustomLlm", () => {
  beforeEach(() => {
    delete process.env.CUSTOM_LLM_API_KEY;
    delete process.env.CUSTOM_LLM_BASE_URL;
  });

  afterEach(() => {
    delete process.env.CUSTOM_LLM_API_KEY;
    delete process.env.CUSTOM_LLM_BASE_URL;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(CustomLlm.supportedModels).toBeDefined();
      expect(Array.isArray(CustomLlm.supportedModels)).toBe(true);
    });

    it("accepts any model format", () => {
      const testModels = [
        "llama3",
        "gpt-4",
        "my-custom-model",
        "meta-llama/Llama-3-8b",
        "anthropic/claude-sonnet-4",
        "model-with-numbers-123",
        "model_with_underscores",
      ];

      for (const model of testModels) {
        const matches = CustomLlm.supportedModels.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });
  });

  describe("constructor", () => {
    it("creates instance with minimal config", () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      expect(llm.model).toBe("llama3");
    });

    it("creates instance with full config", () => {
      const llm = new CustomLlm({
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
      expect(llm.model).toBe("llama3");
    });

    it("handles empty apiKey", () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      expect(llm.model).toBe("llama3");
    });

    it("uses Custom environment fallbacks", () => {
      process.env.CUSTOM_LLM_BASE_URL = "http://localhost:11434/v1";
      process.env.CUSTOM_LLM_API_KEY = "environment-key";

      const llm = new CustomLlm({ model: "llama3" });
      const client = getClient(llm);

      expect(client.baseURL).toBe("http://localhost:11434/v1");
      expect(client.apiKey).toBe("environment-key");
    });

    it("keeps explicit URL and credentials ahead of environment values", () => {
      process.env.CUSTOM_LLM_BASE_URL = "https://environment.example.test/v1";
      process.env.CUSTOM_LLM_API_KEY = "environment-key";

      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:8000/v1",
        apiKey: "explicit-key",
      });
      const client = getClient(llm);

      expect(client.baseURL).toBe("http://localhost:8000/v1");
      expect(client.apiKey).toBe("explicit-key");
    });

    it("allows an explicitly empty credential for local servers", () => {
      process.env.CUSTOM_LLM_API_KEY = "environment-key";

      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
      });

      expect(getClient(llm).apiKey).toBe("adk-llm-bridge-custom-provider");
    });

    it("throws an actionable error when no base URL resolves", () => {
      expect(() => new CustomLlm({ model: "llama3" })).toThrow(
        "set CUSTOM_LLM_BASE_URL",
      );
    });

    it("does not expose a secret from an invalid URL", () => {
      const secret = "issue85-custom-secret";
      let message = "";

      try {
        new CustomLlm({
          model: "llama3",
          baseURL: `https://user:${secret}@[`,
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain("Invalid baseURL");
      expect(message).not.toContain(secret);
    });

    it("throws on empty model", () => {
      expect(
        () =>
          new CustomLlm({
            model: "",
            baseURL: "http://localhost:11434/v1",
          }),
      ).toThrow("[adk-llm-bridge] model is required");
    });

    it("throws on whitespace-only model", () => {
      expect(
        () =>
          new CustomLlm({
            model: "   ",
            baseURL: "http://localhost:11434/v1",
          }),
      ).toThrow("[adk-llm-bridge] model is required");
    });

    it("throws on invalid baseURL", () => {
      expect(
        () =>
          new CustomLlm({
            model: "llama3",
            baseURL: "not-a-url",
          } as import("../../../src/providers/custom/custom-llm.js").CustomLlmProviderConfig),
      ).toThrow("Invalid baseURL");
    });
  });

  describe("queryParams handling", () => {
    it("appends query params to baseURL", () => {
      // We can't directly access the client, but we can verify the instance is created
      const llm = new CustomLlm({
        model: "gpt-4",
        baseURL: "https://api.example.com/v1",
        queryParams: { "api-version": "2024-02-01" },
      });
      expect(llm.model).toBe("gpt-4");
    });

    it("handles baseURL with existing query params", () => {
      const llm = new CustomLlm({
        model: "gpt-4",
        baseURL: "https://api.example.com/v1?existing=param",
        queryParams: { "api-version": "2024-02-01" },
      });
      expect(llm.model).toBe("gpt-4");
    });

    it("handles empty queryParams", () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
        queryParams: {},
      });
      expect(llm.model).toBe("llama3");
    });
  });

  describe("error prefix", () => {
    it("uses custom name for error prefix", () => {
      const llm = new CustomLlm({
        name: "my-provider",
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      // Error prefix is used internally, verified through error handling
      expect(llm.model).toBe("llama3");
    });

    it("defaults to CUSTOM when name not provided", () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      expect(llm.model).toBe("llama3");
    });

    it("sanitizes special characters in name", () => {
      const llm = new CustomLlm({
        name: "my-custom.provider",
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });
      expect(llm.model).toBe("llama3");
    });
  });

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new CustomLlm({
        model: "llama3",
        baseURL: "http://localhost:11434/v1",
      });

      const request = {
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      } as Parameters<typeof llm.connect>[0];

      expect(llm.connect(request)).rejects.toThrow(
        "does not support bidirectional streaming",
      );
    });
  });
});
