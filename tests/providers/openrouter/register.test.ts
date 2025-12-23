import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerOpenRouter,
  isOpenRouterRegistered,
  _resetOpenRouterRegistration,
} from "../../../src/providers/openrouter/register";
import { getProviderConfig } from "../../../src/config";

describe("registerOpenRouter", () => {
  beforeEach(() => {
    _resetOpenRouterRegistration();
  });

  it("sets isOpenRouterRegistered to true after registration", () => {
    expect(isOpenRouterRegistered()).toBe(false);
    registerOpenRouter();
    expect(isOpenRouterRegistered()).toBe(true);
  });

  it("only registers once (singleton pattern)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    registerOpenRouter();
    registerOpenRouter();
    registerOpenRouter();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("stores baseURL in provider config", () => {
    registerOpenRouter({ baseURL: "https://custom.openrouter.com/v1" });

    const config = getProviderConfig("openrouter");
    expect(config?.baseURL).toBe("https://custom.openrouter.com/v1");
  });

  it("stores apiKey in provider config", () => {
    registerOpenRouter({ apiKey: "my-openrouter-key" });

    const config = getProviderConfig("openrouter");
    expect(config?.apiKey).toBe("my-openrouter-key");
  });

  it("stores siteUrl in provider config", () => {
    registerOpenRouter({ siteUrl: "https://myapp.com" });

    const config = getProviderConfig("openrouter");
    expect(config?.siteUrl).toBe("https://myapp.com");
  });

  it("stores appName in provider config", () => {
    registerOpenRouter({ appName: "My App" });

    const config = getProviderConfig("openrouter");
    expect(config?.appName).toBe("My App");
  });

  it("does not set config when no options provided", () => {
    registerOpenRouter();
    expect(getProviderConfig("openrouter")).toBeUndefined();
  });
});

describe("isOpenRouterRegistered", () => {
  beforeEach(() => {
    _resetOpenRouterRegistration();
  });

  it("returns false before registration", () => {
    expect(isOpenRouterRegistered()).toBe(false);
  });

  it("returns true after registration", () => {
    registerOpenRouter();
    expect(isOpenRouterRegistered()).toBe(true);
  });
});

describe("_resetOpenRouterRegistration", () => {
  beforeEach(() => {
    _resetOpenRouterRegistration();
  });

  it("resets registration state and config", () => {
    registerOpenRouter({
      baseURL: "https://test.com",
      apiKey: "key",
      siteUrl: "https://myapp.com",
    });
    expect(isOpenRouterRegistered()).toBe(true);
    expect(getProviderConfig("openrouter")?.baseURL).toBe("https://test.com");

    _resetOpenRouterRegistration();
    expect(isOpenRouterRegistered()).toBe(false);
    expect(getProviderConfig("openrouter")).toBeUndefined();
  });
});
