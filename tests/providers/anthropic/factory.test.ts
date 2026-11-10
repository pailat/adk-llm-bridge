import { beforeEach, describe, expect, it } from "bun:test";
import { resetAllConfigs } from "../../../src/config.js";
import {
  Anthropic,
  AnthropicLlm,
} from "../../../src/providers/anthropic/index.js";
import { useCleanEnv } from "../../helpers/env.js";

describe("Anthropic factory", () => {
  useCleanEnv(["ANTHROPIC_API_KEY"]);
  beforeEach(() => {
    resetAllConfigs();
  });

  it("creates correct instance", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      apiKey: "sk-ant-test",
    });
    expect(llm).toBeInstanceOf(AnthropicLlm);
  });

  it("sets model correctly", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      apiKey: "sk-ant-test",
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("throws when no API key provided", () => {
    expect(() => Anthropic("claude-sonnet-4-5-20250929")).toThrow(
      "[anthropic] API key is required",
    );
  });
});

describe("Anthropic factory (provider-specific)", () => {
  beforeEach(() => {});

  it("accepts maxTokens option", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      apiKey: "sk-ant-test",
      maxTokens: 8192,
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("accepts timeout and maxRetries options", () => {
    const llm = Anthropic("claude-sonnet-4-5-20250929", {
      apiKey: "sk-ant-test",
      timeout: 30000,
      maxRetries: 5,
    });
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("keeps the requested model id for each claude model", () => {
    const models = [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-5",
      "claude-haiku-4-5",
      "claude-3-5-haiku-latest",
    ];
    for (const model of models) {
      const llm = Anthropic(model, { apiKey: "sk-ant-test" });
      expect(llm.model).toBe(model);
    }
  });

  it("uses ANTHROPIC_API_KEY env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    const llm = Anthropic("claude-sonnet-4-5-20250929");
    expect(llm.model).toBe("claude-sonnet-4-5-20250929");
  });
});
