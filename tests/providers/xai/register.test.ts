import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerXAI,
  isXAIRegistered,
  _resetXAIRegistration,
} from "../../../src/providers/xai/register";
import { getProviderConfig } from "../../../src/config";

describe("registerXAI", () => {
  beforeEach(() => {
    _resetXAIRegistration();
  });

  it("sets isXAIRegistered to true after registration", () => {
    expect(isXAIRegistered()).toBe(false);
    registerXAI();
    expect(isXAIRegistered()).toBe(true);
  });

  it("only registers once (singleton pattern)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    registerXAI();
    registerXAI();
    registerXAI();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("stores apiKey in provider config", () => {
    registerXAI({ apiKey: "my-xai-key" });

    const config = getProviderConfig("xai");
    expect(config?.apiKey).toBe("my-xai-key");
  });

  it("does not set config when no options provided", () => {
    registerXAI();
    expect(getProviderConfig("xai")).toBeUndefined();
  });
});

describe("isXAIRegistered", () => {
  beforeEach(() => {
    _resetXAIRegistration();
  });

  it("returns false before registration", () => {
    expect(isXAIRegistered()).toBe(false);
  });

  it("returns true after registration", () => {
    registerXAI();
    expect(isXAIRegistered()).toBe(true);
  });
});

describe("_resetXAIRegistration", () => {
  beforeEach(() => {
    _resetXAIRegistration();
  });

  it("resets registration state and config", () => {
    registerXAI({
      apiKey: "key",
    });
    expect(isXAIRegistered()).toBe(true);
    expect(getProviderConfig("xai")?.apiKey).toBe("key");

    _resetXAIRegistration();
    expect(isXAIRegistered()).toBe(false);
    expect(getProviderConfig("xai")).toBeUndefined();
  });
});
