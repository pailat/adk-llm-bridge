import { beforeEach, describe, expect, it } from "bun:test";
import { InputValidationError } from "@google/adk";
import {
  AIGateway,
  Anthropic,
  Custom,
  OpenAI,
  registerCustomProvider,
  resetAllConfigs,
  setProviderConfig,
} from "../../src/index.js";
import { useCleanEnv } from "../helpers/env.js";

const SECRET = "sk-should-never-leak-123";

/** Runs `fn`, asserts it threw ADK's InputValidationError, returns the message. */
function captureValidationError(fn: () => unknown): string {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputValidationError);
  // Still a plain Error, so existing `catch`/`instanceof Error` code keeps working.
  expect(caught).toBeInstanceOf(Error);
  const message = (caught as Error).message;
  expect(message).not.toContain(SECRET);
  return message;
}

describe("invalid provider configuration throws InputValidationError", () => {
  useCleanEnv([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_URL",
    "ANTHROPIC_API_KEY",
    "CUSTOM_LLM_API_KEY",
    "CUSTOM_LLM_BASE_URL",
  ]);
  beforeEach(() => {
    resetAllConfigs();
  });

  describe("OpenAI-compatible factories", () => {
    it("missing API key", () => {
      expect(captureValidationError(() => OpenAI("gpt-4.1"))).toContain(
        "[openai] API key is required",
      );
    });

    it("empty API key", () => {
      expect(
        captureValidationError(() => AIGateway("openai/gpt-5", { apiKey: "" })),
      ).toContain("[ai-gateway] API key is required");
    });

    it("empty model", () => {
      expect(captureValidationError(() => OpenAI("", { apiKey: SECRET }))).toBe(
        "[adk-llm-bridge] model is required and cannot be empty.",
      );
    });

    it("invalid base URL omits the configured value and credentials", () => {
      const message = captureValidationError(() =>
        OpenAI("gpt-4.1", {
          apiKey: SECRET,
          baseURL: `https://user:${SECRET}@bad host/v1?api_key=${SECRET}`,
        }),
      );
      expect(message).toContain("[openai] Invalid baseURL from explicit");
      expect(message).not.toContain("bad host");
    });

    it("invalid global base URL", () => {
      setProviderConfig("ai-gateway", {
        apiKey: SECRET,
        baseURL: `not a url ${SECRET}`,
      });
      expect(captureValidationError(() => AIGateway("openai/gpt-5"))).toContain(
        "Invalid baseURL from global provider configuration",
      );
    });
  });

  describe("Custom and registerCustomProvider", () => {
    it("Custom without a base URL", () => {
      expect(
        captureValidationError(() => Custom("llama3", { apiKey: SECRET })),
      ).toContain("[custom] baseURL is required");
    });

    it("Custom with an invalid base URL", () => {
      const message = captureValidationError(() =>
        Custom("llama3", { baseURL: `http://u:${SECRET}@ho st:11434/v1` }),
      );
      expect(message).toContain("[custom] Invalid baseURL");
    });

    it("registerCustomProvider with an invalid base URL", () => {
      const message = captureValidationError(() =>
        registerCustomProvider("ive-bad-url", {
          apiKey: SECRET,
          baseURL: `https://${SECRET}@ho st/v1`,
          models: ["m"],
        }),
      );
      expect(message).toContain("[custom] Invalid baseURL");
    });

    it("registerCustomProvider with an invalid prefix or no models", () => {
      expect(
        captureValidationError(() =>
          registerCustomProvider("Bad Prefix", {
            baseURL: "http://localhost:11434/v1",
            models: ["m"],
          }),
        ),
      ).toContain("Invalid custom provider prefix");
      expect(
        captureValidationError(() =>
          registerCustomProvider("ive-empty", {
            apiKey: SECRET,
            baseURL: "http://localhost:11434/v1",
            models: [],
          }),
        ),
      ).toContain("must declare at least one model");
    });
  });

  describe("Anthropic", () => {
    it("missing API key", () => {
      expect(
        captureValidationError(() => Anthropic("claude-sonnet-4-5")),
      ).toContain("[anthropic] API key is required");
    });

    it("empty model", () => {
      expect(
        captureValidationError(() => Anthropic("", { apiKey: SECRET })),
      ).toBe("[adk-llm-bridge] model is required and cannot be empty.");
    });
  });
});
