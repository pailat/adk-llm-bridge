import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InputValidationError } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../../src/config.js";
import {
  resolveConfig,
  resolveEnvVar,
} from "../../src/core/config-resolver.js";
import type { ProviderDefinition } from "../../src/core/provider-definition.js";

const TEST_DEFINITION: ProviderDefinition = {
  id: "ai-gateway",
  errorPrefix: "TEST",
  defaultBaseURL: "https://default.example.test/v1",
  envKeys: {
    apiKey: ["ISSUE85_TEST_API_KEY"],
    baseURL: ["ISSUE85_TEST_BASE_URL"],
  },
  modelPatterns: [],
};

describe("config resolver", () => {
  beforeEach(() => {
    resetProviderConfig("ai-gateway");
    delete process.env.ISSUE85_TEST_API_KEY;
    delete process.env.ISSUE85_TEST_BASE_URL;
  });

  afterEach(() => {
    resetProviderConfig("ai-gateway");
    delete process.env.ISSUE85_TEST_API_KEY;
    delete process.env.ISSUE85_TEST_BASE_URL;
  });

  it("resolves explicit values before global config and environment", () => {
    process.env.ISSUE85_TEST_API_KEY = "environment-key";
    process.env.ISSUE85_TEST_BASE_URL = "https://environment.example.test/v1";
    setProviderConfig("ai-gateway", {
      apiKey: "global-key",
      baseURL: "https://global.example.test/v1",
    });

    const resolved = resolveConfig(TEST_DEFINITION, {
      model: "test-model",
      apiKey: "explicit-key",
      baseURL: "https://explicit.example.test/v1",
    });

    expect(resolved.apiKey).toBe("explicit-key");
    expect(resolved.baseURL).toBe("https://explicit.example.test/v1");
  });

  it("resolves global config before environment", () => {
    process.env.ISSUE85_TEST_API_KEY = "environment-key";
    process.env.ISSUE85_TEST_BASE_URL = "https://environment.example.test/v1";
    setProviderConfig("ai-gateway", {
      apiKey: "global-key",
      baseURL: "https://global.example.test/v1",
    });

    const resolved = resolveConfig(TEST_DEFINITION, { model: "test-model" });

    expect(resolved.apiKey).toBe("global-key");
    expect(resolved.baseURL).toBe("https://global.example.test/v1");
  });

  it("resolves environment before the provider default", () => {
    process.env.ISSUE85_TEST_API_KEY = "environment-key";
    process.env.ISSUE85_TEST_BASE_URL = "https://environment.example.test/v1";

    const resolved = resolveConfig(TEST_DEFINITION, { model: "test-model" });

    expect(resolved.apiKey).toBe("environment-key");
    expect(resolved.baseURL).toBe("https://environment.example.test/v1");
  });

  it("uses the provider default after higher-priority sources", () => {
    const resolved = resolveConfig(TEST_DEFINITION, { model: "test-model" });

    expect(resolved.apiKey).toBe("");
    expect(resolved.baseURL).toBe("https://default.example.test/v1");
  });

  it("does not fall through when an explicit URL is invalid", () => {
    process.env.ISSUE85_TEST_BASE_URL = "https://environment.example.test/v1";

    expect(() =>
      resolveConfig(TEST_DEFINITION, {
        model: "test-model",
        baseURL: "not-a-url",
      }),
    ).toThrow("Invalid baseURL from explicit configuration");
  });

  it("omits malformed URL values and embedded secrets from errors", () => {
    const secret = "issue85-url-password";
    let message = "";

    try {
      resolveConfig(TEST_DEFINITION, {
        model: "test-model",
        baseURL: `https://user:${secret}@[`,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("Invalid baseURL from explicit configuration");
    expect(message).toContain("omitted for security");
    expect(message).not.toContain(secret);
  });

  it("reports an actionable error when no URL can be resolved", () => {
    const definition = {
      ...TEST_DEFINITION,
      defaultBaseURL: "",
    };

    expect(() => resolveConfig(definition, { model: "test-model" })).toThrow(
      "baseURL is required. Provide it via explicit configuration or global provider configuration, or set ISSUE85_TEST_BASE_URL",
    );
  });
});

describe("environment values with surrounding spaces", () => {
  afterEach(() => {
    resetProviderConfig("ai-gateway");
    delete process.env.ISSUE85_TEST_API_KEY;
    delete process.env.ISSUE85_TEST_BASE_URL;
  });

  it("trims a base URL read from the environment", () => {
    process.env.ISSUE85_TEST_BASE_URL = "  http://localhost:8080/v1  ";
    expect(resolveConfig(TEST_DEFINITION, { model: "m" }).baseURL).toBe(
      "http://localhost:8080/v1",
    );
  });

  it("treats a blank environment base URL as unset", () => {
    process.env.ISSUE85_TEST_BASE_URL = "   ";
    expect(resolveConfig(TEST_DEFINITION, { model: "m" }).baseURL).toBe(
      "https://default.example.test/v1",
    );
  });

  it("trims a configured base URL", () => {
    expect(
      resolveConfig(TEST_DEFINITION, {
        model: "m",
        baseURL: " http://localhost:8080/v1\n",
      }).baseURL,
    ).toBe("http://localhost:8080/v1");
  });

  it("trims an API key read from the environment and skips a blank one", () => {
    process.env.ISSUE85_TEST_API_KEY = "  env-key \n";
    expect(resolveConfig(TEST_DEFINITION, { model: "m" }).apiKey).toBe(
      "env-key",
    );
    process.env.ISSUE85_TEST_API_KEY = "  ";
    expect(resolveEnvVar(["ISSUE85_TEST_API_KEY"])).toBeUndefined();
  });
});

describe("resolveEnvVar", () => {
  it("returns the first non-empty environment value", () => {
    process.env.ISSUE85_TEST_API_KEY = "first";
    process.env.ISSUE85_TEST_BASE_URL = "second";

    expect(
      resolveEnvVar(["ISSUE85_TEST_API_KEY", "ISSUE85_TEST_BASE_URL"]),
    ).toBe("first");

    delete process.env.ISSUE85_TEST_API_KEY;
    delete process.env.ISSUE85_TEST_BASE_URL;
  });
});

describe("numeric config", () => {
  beforeEach(() => resetProviderConfig("ai-gateway"));
  afterEach(() => resetProviderConfig("ai-gateway"));

  const resolve = (config: { timeout?: number; maxRetries?: number }) =>
    resolveConfig(TEST_DEFINITION, { model: "m", apiKey: "k", ...config });

  it.each([
    ["timeout", { timeout: 1500.5 }],
    ["timeout", { timeout: Number.NaN }],
    ["timeout", { timeout: Number.POSITIVE_INFINITY }],
    ["maxRetries", { maxRetries: 2.5 }],
    ["maxRetries", { maxRetries: Number.NaN }],
  ])("rejects a non-integer %s", (name, config) => {
    expect(() => resolve(config)).toThrow(InputValidationError);
    expect(() => resolve(config)).toThrow(
      `[ai-gateway] ${name} must be an integer`,
    );
  });

  it("rejects a non-integer value from the global config", () => {
    setProviderConfig("ai-gateway", { maxRetries: 1.5 });
    expect(() => resolve({})).toThrow(
      "[ai-gateway] maxRetries must be an integer",
    );
  });

  it("clamps an integer below the minimum, as documented", () => {
    expect(resolve({ timeout: 500 }).timeout).toBe(1000);
    expect(resolve({ maxRetries: -3 }).maxRetries).toBe(0);
  });

  it("treats null as unset, from the instance and from the global config", () => {
    const defaults = resolve({});
    // @ts-expect-error null is not a valid timeout type; checks runtime handling
    expect(resolve({ timeout: null, maxRetries: null })).toMatchObject({
      timeout: defaults.timeout,
      maxRetries: defaults.maxRetries,
    });
    // @ts-expect-error null is not a valid option type; checks runtime handling
    setProviderConfig("ai-gateway", { timeout: null, maxRetries: null });
    expect(resolve({})).toMatchObject({
      timeout: defaults.timeout,
      maxRetries: defaults.maxRetries,
    });
  });

  it("rejects a timeout the timer cannot hold", () => {
    expect(resolve({ timeout: 2_147_483_647 }).timeout).toBe(2_147_483_647);
    for (const timeout of [2 ** 31, Number.MAX_SAFE_INTEGER, 1e21]) {
      expect(() => resolve({ timeout })).toThrow(InputValidationError);
      expect(() => resolve({ timeout })).toThrow(
        "[ai-gateway] timeout must be at most 2147483647",
      );
    }
  });

  it("quotes a string value in the message", () => {
    // @ts-expect-error a string timeout is the wrong type; checks the message
    expect(() => resolve({ timeout: "100" })).toThrow(
      '[ai-gateway] timeout must be an integer, got "100".',
    );
  });

  it("keeps valid integers and the defaults", () => {
    expect(resolve({ timeout: 5000, maxRetries: 4 })).toMatchObject({
      timeout: 5000,
      maxRetries: 4,
    });
    const defaults = resolve({});
    expect(Number.isInteger(defaults.timeout)).toBe(true);
    expect(Number.isInteger(defaults.maxRetries)).toBe(true);
  });
});
