import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
