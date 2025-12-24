import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerOpenAI,
  isOpenAIRegistered,
  _resetOpenAIRegistration,
} from "../../../src/providers/openai/register";
import { getProviderConfig } from "../../../src/config";

describe("registerOpenAI", () => {
  beforeEach(() => {
    _resetOpenAIRegistration();
  });

  it("sets isOpenAIRegistered to true after registration", () => {
    expect(isOpenAIRegistered()).toBe(false);
    registerOpenAI();
    expect(isOpenAIRegistered()).toBe(true);
  });

  it("only registers once (singleton pattern)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    registerOpenAI();
    registerOpenAI();
    registerOpenAI();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("stores apiKey in provider config", () => {
    registerOpenAI({ apiKey: "my-openai-key" });

    const config = getProviderConfig("openai");
    expect(config?.apiKey).toBe("my-openai-key");
  });

  it("stores organization in provider config", () => {
    registerOpenAI({ organization: "org-xxx" });

    const config = getProviderConfig("openai");
    expect(config?.organization).toBe("org-xxx");
  });

  it("stores project in provider config", () => {
    registerOpenAI({ project: "proj-xxx" });

    const config = getProviderConfig("openai");
    expect(config?.project).toBe("proj-xxx");
  });

  it("stores all options in provider config", () => {
    registerOpenAI({
      apiKey: "my-openai-key",
      organization: "org-xxx",
      project: "proj-xxx",
    });

    const config = getProviderConfig("openai");
    expect(config?.apiKey).toBe("my-openai-key");
    expect(config?.organization).toBe("org-xxx");
    expect(config?.project).toBe("proj-xxx");
  });

  it("does not set config when no options provided", () => {
    registerOpenAI();
    expect(getProviderConfig("openai")).toBeUndefined();
  });
});

describe("isOpenAIRegistered", () => {
  beforeEach(() => {
    _resetOpenAIRegistration();
  });

  it("returns false before registration", () => {
    expect(isOpenAIRegistered()).toBe(false);
  });

  it("returns true after registration", () => {
    registerOpenAI();
    expect(isOpenAIRegistered()).toBe(true);
  });
});

describe("_resetOpenAIRegistration", () => {
  beforeEach(() => {
    _resetOpenAIRegistration();
  });

  it("resets registration state and config", () => {
    registerOpenAI({
      apiKey: "key",
      organization: "org-xxx",
    });
    expect(isOpenAIRegistered()).toBe(true);
    expect(getProviderConfig("openai")?.apiKey).toBe("key");

    _resetOpenAIRegistration();
    expect(isOpenAIRegistered()).toBe(false);
    expect(getProviderConfig("openai")).toBeUndefined();
  });
});
