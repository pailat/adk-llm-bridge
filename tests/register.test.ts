import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  registerAIGateway,
  isAIGatewayRegistered,
  _resetRegistration,
} from "../src/register";
import { getConfig } from "../src/config";

describe("registerAIGateway", () => {
  beforeEach(() => {
    _resetRegistration();
  });

  it("sets isAIGatewayRegistered to true after registration", () => {
    expect(isAIGatewayRegistered()).toBe(false);
    registerAIGateway();
    expect(isAIGatewayRegistered()).toBe(true);
  });

  it("only registers once (singleton pattern)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    registerAIGateway();
    registerAIGateway();
    registerAIGateway();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("stores baseURL in internal config (not process.env)", () => {
    const originalEnv = process.env.AI_GATEWAY_URL;

    registerAIGateway({ baseURL: "https://custom.gateway.com/v1" });

    expect(getConfig().baseURL).toBe("https://custom.gateway.com/v1");
    expect(process.env.AI_GATEWAY_URL).toBe(originalEnv);
  });

  it("stores apiKey in internal config (not process.env)", () => {
    const originalEnv = process.env.AI_GATEWAY_API_KEY;

    registerAIGateway({ apiKey: "my-secret-key" });

    expect(getConfig().apiKey).toBe("my-secret-key");
    expect(process.env.AI_GATEWAY_API_KEY).toBe(originalEnv);
  });

  it("does not set config when no options provided", () => {
    registerAIGateway();
    expect(getConfig()).toEqual({});
  });
});

describe("isAIGatewayRegistered", () => {
  beforeEach(() => {
    _resetRegistration();
  });

  it("returns false before registration", () => {
    expect(isAIGatewayRegistered()).toBe(false);
  });

  it("returns true after registration", () => {
    registerAIGateway();
    expect(isAIGatewayRegistered()).toBe(true);
  });
});

describe("_resetRegistration", () => {
  beforeEach(() => {
    _resetRegistration();
  });

  it("resets registration state and config", () => {
    registerAIGateway({ baseURL: "https://test.com", apiKey: "key" });
    expect(isAIGatewayRegistered()).toBe(true);
    expect(getConfig().baseURL).toBe("https://test.com");

    _resetRegistration();
    expect(isAIGatewayRegistered()).toBe(false);
    expect(getConfig()).toEqual({});
  });
});
