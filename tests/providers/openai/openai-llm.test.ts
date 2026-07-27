import { beforeEach, describe, expect, it } from "bun:test";
import type OpenAI from "openai";
import { resetAllConfigs } from "../../../src/config.js";
import { OPENAI_DEFINITION } from "../../../src/providers/openai/definition.js";
import { OpenAILlm } from "../../../src/providers/openai/index.js";
import {
  describeModelPatterns,
  describeConnectError,
} from "../../helpers/provider-test-helpers.js";

describe("OpenAILlm", () => {
  beforeEach(() => {
    resetAllConfigs();
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_PROJECT;
  });

  describeModelPatterns({
    llmClass: OpenAILlm,
    patterns: OPENAI_DEFINITION.modelPatterns,
    validModels: [
      "gpt-4",
      "gpt-4o",
      "gpt-4.1",
      "gpt-4.1-mini",
      "gpt-4-turbo",
      "gpt-3.5-turbo",
      "o1",
      "o1-mini",
      "o1-preview",
      "o3",
      "o4-mini",
      "chatgpt-4o-latest",
    ],
    invalidModels: [
      "claude-sonnet-4",
      "gemini-2.0-flash",
      "grok-4",
      "llama-3.1",
    ],
  });

  describe("constructor", () => {
    it("creates instance with apiKey", () => {
      const llm = new OpenAILlm({ model: "gpt-4.1", apiKey: "test-key" });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("uses OPENAI_API_KEY env var", () => {
      process.env.OPENAI_API_KEY = "test-openai-key";

      const llm = new OpenAILlm({ model: "gpt-4o" });
      expect(llm.model).toBe("gpt-4o");
    });

    it("uses OPENAI_BASE_URL when no explicit URL is provided", () => {
      process.env.OPENAI_API_KEY = "test-openai-key";
      process.env.OPENAI_BASE_URL = "https://openai-proxy.example.test/v1";

      const llm = new OpenAILlm({ model: "gpt-4o" });
      const client = (llm as typeof llm & { client: OpenAI }).client;

      expect(client.baseURL).toBe("https://openai-proxy.example.test/v1");
    });

    it("keeps an explicit base URL ahead of OPENAI_BASE_URL", () => {
      process.env.OPENAI_BASE_URL = "https://environment.example.test/v1";

      const llm = new OpenAILlm({
        model: "gpt-4o",
        apiKey: "test-openai-key",
        baseURL: "https://explicit.example.test/v1",
      });
      const client = (llm as typeof llm & { client: OpenAI }).client;

      expect(client.baseURL).toBe("https://explicit.example.test/v1");
    });

    it("throws when no API key provided", () => {
      expect(() => new OpenAILlm({ model: "gpt-4.1" })).toThrow(
        "[openai] API key is required",
      );
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
      process.env.OPENAI_API_KEY = "test-key";
      const llm = new OpenAILlm({ model: "gpt-4.1" });
      expect(llm.model).toBe("gpt-4.1");
    });

    it("uses OPENAI_PROJECT env var", () => {
      process.env.OPENAI_PROJECT = "proj-from-env";
      process.env.OPENAI_API_KEY = "test-key";
      const llm = new OpenAILlm({ model: "gpt-4.1" });
      expect(llm.model).toBe("gpt-4.1");
    });
  });

  describeConnectError(OpenAILlm, "gpt-4.1");
});
