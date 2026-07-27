import { describe, expect, it } from "bun:test";
import { registerCustomProvider } from "../../../src/index.js";

const fixtureResults = new Map<string, unknown>();

function runFixture<T>(scenario: string): T {
  if (fixtureResults.has(scenario)) {
    return fixtureResults.get(scenario) as T;
  }

  const result = Bun.spawnSync({
    cmd: [process.execPath, `${import.meta.dir}/registry.fixture.ts`, scenario],
    cwd: process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  const parsed = JSON.parse(result.stdout.toString()) as T;
  fixtureResults.set(scenario, parsed);
  return parsed;
}

describe("registerCustomProvider", () => {
  it("registers two independent prefixes and strips only the selected prefix", () => {
    const result = runFixture<{
      ollamaIsCustom: boolean;
      ollamaModel: string;
      vllmIsCustom: boolean;
      vllmModel: string;
    }>("coexist");

    expect(result.ollamaIsCustom).toBe(true);
    expect(result.vllmIsCustom).toBe(true);
    expect(result.ollamaModel).toBe("llama3");
    expect(result.vllmModel).toBe("meta-llama/Llama-3-8b");
  });

  it("deeply captures configuration and sends only the remote model ID", () => {
    const result = runFixture<{
      apiKey: string;
      header: string;
      model: string;
      routing: {
        fallbacks: string[];
        metadata: { tier: string };
      };
    }>("captured");

    expect(result.model).toBe("team/remote-model");
    expect(result.apiKey).toBe("captured-secret");
    expect(result.header).toBe("captured");
    expect(result.routing).toEqual({
      fallbacks: ["original-fallback"],
      metadata: { tier: "captured-tier" },
    });
  });

  it("captures environment fallbacks and keeps registration values explicit", () => {
    const result = runFixture<{
      environmentBaseURL: string;
      environmentApiKey: string;
      explicitBaseURL: string;
      explicitApiKey: string;
    }>("issue85-configuration");

    expect(result.environmentBaseURL).toBe(
      "https://captured-environment.example.test/v1",
    );
    expect(result.environmentApiKey).toBe("captured-environment-key");
    expect(result.explicitBaseURL).toBe("https://explicit.example.test/v1");
    expect(result.explicitApiKey).toBe("explicit-key");
  });

  it("fails unresolved or invalid registration URLs without exposing secrets", () => {
    const result = runFixture<{
      invalid: string;
      missing: string;
      secret: string;
    }>("issue85-url-errors");

    expect(result.missing).toContain("set CUSTOM_LLM_BASE_URL");
    expect(result.invalid).toContain(
      "Invalid baseURL from the CUSTOM_LLM_BASE_URL environment variable",
    );
    expect(result.invalid).not.toContain(result.secret);
  });

  it("rejects invalid prefixes deterministically", () => {
    for (const prefix of ["", "UPPER", "has space", "/leading", "trailing/"]) {
      expect(() =>
        registerCustomProvider(prefix, {
          baseURL: "http://localhost:1234/v1",
          models: ["model"],
        }),
      ).toThrow("Invalid custom provider prefix");
    }
  });

  it("rejects reserved prefixes", () => {
    for (const prefix of ["gemini", "openai/local", "projects", "custom"]) {
      expect(() =>
        registerCustomProvider(prefix, {
          baseURL: "http://localhost:1234/v1",
          models: ["model"],
        }),
      ).toThrow("is reserved");
    }
  });

  it("rejects duplicate prefixes", () => {
    const result = runFixture<{ duplicate: string }>("validation");
    expect(result.duplicate).toContain(
      'prefix "issue84-duplicate" is already registered',
    );
  });

  it("requires a finite, non-empty model allowlist", () => {
    expect(() =>
      registerCustomProvider("issue84-no-models", {
        baseURL: "http://localhost:1234/v1",
        models: [],
      }),
    ).toThrow("must declare at least one model");
  });

  it("rejects whitespace-only model IDs before registration", () => {
    const result = runFixture<{
      invalidModel: string;
      invalidRouteResolution: string;
      validIsCustom: boolean;
      validModel: string;
    }>("whitespace-model");

    expect(result.invalidModel).toContain(
      "Model IDs must contain non-whitespace characters",
    );
    expect(result.invalidRouteResolution).toContain("not found");
    expect(result.validIsCustom).toBe(true);
    expect(result.validModel).toBe("valid-model");
  });

  it("rejects a partial regex overlap atomically", () => {
    const result = runFixture<{
      conflict: string;
      freeRoute: string;
      ownedRouteIsExisting: boolean;
    }>("partial-overlap");

    expect(result.conflict).toContain(
      'route "issue84-partial/owned-model" is already claimed',
    );
    expect(result.freeRoute).toContain("not found");
    expect(result.ownedRouteIsExisting).toBe(true);
  });

  it("rejects when ADK cannot prove a route is unclaimed", () => {
    const result = runFixture<{ error: string }>("unverifiable-registry");
    expect(result.error).toContain(
      "Could not prove that custom provider route",
    );
  });

  it("fails safely when either broad provider was registered first", () => {
    for (const scenario of [
      "ai-gateway-before-custom",
      "openrouter-before-custom",
    ]) {
      const result = runFixture<{
        conflict: string;
        resolvesToExpected: boolean;
      }>(scenario);

      expect(result.conflict).toContain(
        "Register custom providers before broad",
      );
      expect(result.resolvesToExpected).toBe(true);
    }
  });

  it("keeps exact custom routes when broad providers register later", () => {
    const result = runFixture<{ isCustom: boolean; model: string }>(
      "custom-before-broad",
    );

    expect(result.isCustom).toBe(true);
    expect(result.model).toBe("model");
  });

  it("does not register CustomLlm's catch-all pattern", () => {
    const result = runFixture<{ unregistered: string }>("direct");
    expect(result.unregistered).toContain("not found");
  });

  it("preserves direct Custom construction", () => {
    const result = runFixture<{ isCustom: boolean; model: string }>("direct");
    expect(result.isCustom).toBe(true);
    expect(result.model).toBe("direct/model");
  });
});
