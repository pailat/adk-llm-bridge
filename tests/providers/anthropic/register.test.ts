import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerAnthropic,
  isAnthropicRegistered,
  _resetAnthropicRegistration,
} from "../../../src/providers/anthropic/register";
import { getProviderConfig } from "../../../src/config";

describe("registerAnthropic", () => {
  beforeEach(() => {
    _resetAnthropicRegistration();
  });

  it("sets isAnthropicRegistered to true after registration", () => {
    expect(isAnthropicRegistered()).toBe(false);
    registerAnthropic();
    expect(isAnthropicRegistered()).toBe(true);
  });

  it("only registers once (singleton pattern)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    registerAnthropic();
    registerAnthropic();
    registerAnthropic();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("stores apiKey in provider config", () => {
    registerAnthropic({ apiKey: "my-anthropic-key" });

    const config = getProviderConfig("anthropic");
    expect(config?.apiKey).toBe("my-anthropic-key");
  });

  it("stores maxTokens in provider config", () => {
    registerAnthropic({ maxTokens: 8192 });

    const config = getProviderConfig("anthropic");
    expect(config?.maxTokens).toBe(8192);
  });

  it("stores all options in provider config", () => {
    registerAnthropic({
      apiKey: "my-anthropic-key",
      maxTokens: 8192,
    });

    const config = getProviderConfig("anthropic");
    expect(config?.apiKey).toBe("my-anthropic-key");
    expect(config?.maxTokens).toBe(8192);
  });

  it("does not set config when no options provided", () => {
    registerAnthropic();
    expect(getProviderConfig("anthropic")).toBeUndefined();
  });
});

describe("isAnthropicRegistered", () => {
  beforeEach(() => {
    _resetAnthropicRegistration();
  });

  it("returns false before registration", () => {
    expect(isAnthropicRegistered()).toBe(false);
  });

  it("returns true after registration", () => {
    registerAnthropic();
    expect(isAnthropicRegistered()).toBe(true);
  });
});

describe("_resetAnthropicRegistration", () => {
  beforeEach(() => {
    _resetAnthropicRegistration();
  });

  it("resets registration state and config", () => {
    registerAnthropic({
      apiKey: "key",
      maxTokens: 8192,
    });
    expect(isAnthropicRegistered()).toBe(true);
    expect(getProviderConfig("anthropic")?.apiKey).toBe("key");

    _resetAnthropicRegistration();
    expect(isAnthropicRegistered()).toBe(false);
    expect(getProviderConfig("anthropic")).toBeUndefined();
  });
});
