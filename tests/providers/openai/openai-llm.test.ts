import { describe, it, expect, beforeEach } from "bun:test";
import { OpenAILlm } from "../../../src/providers/openai/openai-llm";
import { OPENAI_MODEL_PATTERNS } from "../../../src/providers/openai/constants";
import { resetAllConfigs } from "../../../src/config";

describe("OpenAILlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_PROJECT;
  });

  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(OpenAILlm.supportedModels).toBeDefined();
      expect(Array.isArray(OpenAILlm.supportedModels)).toBe(true);
    });

    it("matches OPENAI_MODEL_PATTERNS", () => {
      expect(OpenAILlm.supportedModels).toEqual(OPENAI_MODEL_PATTERNS);
    });

    it("patterns match gpt-* models", () => {
      const gptModels = [
        "gpt-4",
        "gpt-4o",
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4-turbo",
        "gpt-3.5-turbo",
      ];

      for (const model of gptModels) {
        const matches = OPENAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });

    it("patterns match o* reasoning models", () => {
      const oModels = ["o1", "o1-mini", "o1-preview", "o3", "o4-mini"];

      for (const model of oModels) {
        const matches = OPENAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });

    it("patterns match chatgpt-* models", () => {
      const chatgptModels = ["chatgpt-4o-latest"];

      for (const model of chatgptModels) {
        const matches = OPENAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(true);
      }
    });

    it("patterns do not match non-OpenAI models", () => {
      const nonOpenAIModels = [
        "claude-sonnet-4",
        "gemini-2.0-flash",
        "grok-4",
        "llama-3.1",
      ];

      for (const model of nonOpenAIModels) {
        const matches = OPENAI_MODEL_PATTERNS.some((pattern) => {
          if (pattern instanceof RegExp) return pattern.test(model);
          return pattern === model;
        });
        expect(matches).toBe(false);
      }
    });
  });

  describe("constructor", () => {
    it("creates instance with model", () => {
      const llm = new OpenAILlm({ model: "gpt-4.1" });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("uses OPENAI_API_KEY env var", () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      const llm = new OpenAILlm({ model: "gpt-4o" });
      expect(llm.model).toBe("gpt-4o");
    });

    it("accepts organization option", () => {
      const llm = new OpenAILlm({
        model: "gpt-4.1",
        apiKey: "test-key",
        organization: "org-xxx",
      });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("accepts project option", () => {
      const llm = new OpenAILlm({
        model: "gpt-4.1",
        apiKey: "test-key",
        project: "proj-xxx",
      });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("accepts both organization and project options", () => {
      const llm = new OpenAILlm({
        model: "gpt-4.1",
        apiKey: "test-key",
        organization: "org-xxx",
        project: "proj-xxx",
      });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("uses OPENAI_ORGANIZATION env var", () => {
      process.env.OPENAI_ORGANIZATION = "org-from-env";
      const llm = new OpenAILlm({ model: "gpt-4.1" });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("uses OPENAI_PROJECT env var", () => {
      process.env.OPENAI_PROJECT = "proj-from-env";
      const llm = new OpenAILlm({ model: "gpt-4.1" });
      expect(llm.model).toBe("gpt-4.1");
    });
  });

  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new OpenAILlm({
        model: "gpt-4.1",
        apiKey: "test",
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
