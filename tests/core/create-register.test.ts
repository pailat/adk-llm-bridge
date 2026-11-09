import { afterEach, describe, expect, it } from "bun:test";
import { InputValidationError } from "@google/adk";
import { getProviderConfig } from "../../src/config.js";
import {
  _resetAIGatewayRegistration,
  registerAIGateway,
} from "../../src/providers/ai-gateway/index.js";
import {
  _resetAnthropicRegistration,
  isAnthropicRegistered,
  registerAnthropic,
} from "../../src/providers/anthropic/index.js";
import {
  _resetOpenAIRegistration,
  isOpenAIRegistered,
  registerOpenAI,
} from "../../src/providers/openai/index.js";
import {
  _resetOpenRouterRegistration,
  registerOpenRouter,
} from "../../src/providers/openrouter/index.js";
import {
  _resetXAIRegistration,
  registerXAI,
} from "../../src/providers/xai/index.js";

afterEach(() => {
  _resetOpenAIRegistration();
  _resetXAIRegistration();
  _resetOpenRouterRegistration();
  _resetAIGatewayRegistration();
  _resetAnthropicRegistration();
});

describe("register functions check integer options up front", () => {
  it.each([
    ["openai", () => registerOpenAI({ timeout: 1.5 }), "timeout"],
    ["xai", () => registerXAI({ maxRetries: Number.NaN }), "maxRetries"],
    [
      "openrouter",
      () => registerOpenRouter({ timeout: Number.POSITIVE_INFINITY }),
      "timeout",
    ],
    ["ai-gateway", () => registerAIGateway({ maxRetries: 0.5 }), "maxRetries"],
    ["anthropic", () => registerAnthropic({ maxTokens: 1.5 }), "maxTokens"],
  ])("%s rejects a non-integer at register time", (id, register, name) => {
    expect(register).toThrow(InputValidationError);
    expect(register).toThrow(`[${id}] ${name} must be an integer`);
  });

  it("rejects a timeout above the timer limit", () => {
    expect(() => registerOpenAI({ timeout: Number.MAX_SAFE_INTEGER })).toThrow(
      "[openai] timeout must be at most 2147483647",
    );
  });

  it("leaves nothing registered or stored after a rejection", () => {
    expect(() => registerOpenAI({ timeout: 1.5 })).toThrow();
    expect(isOpenAIRegistered()).toBe(false);
    expect(getProviderConfig("openai")).toBeUndefined();
    expect(() => registerAnthropic({ maxTokens: 0.5 })).toThrow();
    expect(isAnthropicRegistered()).toBe(false);
  });

  it("still accepts integers, below-minimum ones included, and null", () => {
    // @ts-expect-error null is not a valid option type; checks runtime handling
    registerOpenAI({ timeout: 500, maxRetries: null });
    expect(isOpenAIRegistered()).toBe(true);
  });
});
