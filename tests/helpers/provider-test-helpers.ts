/**
 * Shared test helpers for provider test suites.
 *
 * Eliminates duplicated test boilerplate across provider registration,
 * factory, and LLM class tests.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { LlmRequest } from "@google/adk";
import { getProviderConfig, resetAllConfigs } from "../../src/config.js";
import { useCleanEnv } from "./env.js";
import { captureWarnings } from "./fake-logger.js";

// ---------------------------------------------------------------------------
// Registration test suite
// ---------------------------------------------------------------------------

interface RegistrationTestConfig<O extends object> {
  /** Provider display name, e.g. "OpenAI" */
  name: string;
  /** Provider config key, e.g. "openai" */
  configKey: string;
  /** Register function */
  register: (options?: O) => void;
  /** Check if registered */
  isRegistered: () => boolean;
  /** Reset registration */
  reset: () => void;
  /** Config properties to test: [key, testValue] pairs */
  configProps: [keyof O & string, unknown][];
}

export function describeProviderRegistration<O extends object>(
  cfg: RegistrationTestConfig<O>,
) {
  describe(`register (${cfg.name})`, () => {
    beforeEach(() => cfg.reset());

    it("sets registered to true", () => {
      expect(cfg.isRegistered()).toBe(false);
      cfg.register();
      expect(cfg.isRegistered()).toBe(true);
    });

    it("only registers once (singleton)", () => {
      // The warning goes through ADK's logger. Providers not migrated yet
      // still use console.warn, so count both channels.
      const logSpy = captureWarnings();
      const consoleSpy = spyOn(console, "warn").mockImplementation(() => {});
      cfg.register();
      cfg.register();
      cfg.register();
      const warned = logSpy.mock.calls.length + consoleSpy.mock.calls.length;
      logSpy.mockRestore();
      consoleSpy.mockRestore();
      expect(warned).toBe(2);
    });

    for (const [key, value] of cfg.configProps) {
      it(`stores ${key} in provider config`, () => {
        cfg.register({ [key]: value } as O);
        const config = getProviderConfig(cfg.configKey as "anthropic");
        expect<unknown>(config?.[key as keyof typeof config]).toBe(value);
      });
    }

    it("does not set config when no options provided", () => {
      cfg.register();
      expect(getProviderConfig(cfg.configKey as "anthropic")).toBeUndefined();
    });
  });

  describe(`isRegistered (${cfg.name})`, () => {
    beforeEach(() => cfg.reset());

    it("returns false before registration", () => {
      expect(cfg.isRegistered()).toBe(false);
    });

    it("returns true after registration", () => {
      cfg.register();
      expect(cfg.isRegistered()).toBe(true);
    });
  });

  describe(`reset (${cfg.name})`, () => {
    beforeEach(() => cfg.reset());

    it("resets registration state and config", () => {
      const opts = Object.fromEntries(cfg.configProps) as O;
      cfg.register(opts);
      expect(cfg.isRegistered()).toBe(true);

      cfg.reset();
      expect(cfg.isRegistered()).toBe(false);
      expect(getProviderConfig(cfg.configKey as "anthropic")).toBeUndefined();
    });
  });
}

// ---------------------------------------------------------------------------
// Factory test suite
// ---------------------------------------------------------------------------

interface FactoryTestConfig {
  /** Provider display name */
  name: string;
  /** Factory function */
  factory: (model: string, options?: Record<string, unknown>) => unknown;
  /** Expected class constructor */
  expectedClass: abstract new (
    ...args: never[]
  ) => unknown;
  /** Default model string for tests */
  defaultModel: string;
  /** Env vars to clean before each test */
  envVars: string[];
  /** Default options to pass to factory (e.g. { apiKey: "test" } for providers that require it) */
  defaultOptions?: Record<string, unknown>;
}

export function describeProviderFactory(cfg: FactoryTestConfig) {
  describe(`${cfg.name} factory`, () => {
    useCleanEnv(cfg.envVars);
    beforeEach(() => {
      resetAllConfigs();
    });

    it("creates correct instance", () => {
      const llm = cfg.factory(cfg.defaultModel, cfg.defaultOptions);
      expect(llm).toBeInstanceOf(cfg.expectedClass);
    });

    it("sets model correctly", () => {
      const llm = cfg.factory(cfg.defaultModel, cfg.defaultOptions) as {
        model: string;
      };
      expect(llm.model).toBe(cfg.defaultModel);
    });

    it("accepts optional configuration", () => {
      const llm = cfg.factory(cfg.defaultModel, {
        ...cfg.defaultOptions,
        apiKey: "test-key",
      }) as { model: string };
      expect(llm.model).toBe(cfg.defaultModel);
    });
  });
}

// ---------------------------------------------------------------------------
// Model patterns test suite
// ---------------------------------------------------------------------------

interface ModelPatternsTestConfig {
  /** LLM class with static supportedModels */
  llmClass: { supportedModels: (string | RegExp)[] };
  /** Expected model patterns */
  patterns: (string | RegExp)[];
  /** Models that should match */
  validModels: string[];
  /** Models that should NOT match */
  invalidModels: string[];
}

export function describeModelPatterns(cfg: ModelPatternsTestConfig) {
  describe("supportedModels", () => {
    it("has static supportedModels property", () => {
      expect(cfg.llmClass.supportedModels).toBeDefined();
      expect(Array.isArray(cfg.llmClass.supportedModels)).toBe(true);
    });

    it("matches expected patterns", () => {
      expect(cfg.llmClass.supportedModels).toEqual(cfg.patterns);
    });

    it("patterns match valid models", () => {
      for (const model of cfg.validModels) {
        const matches = cfg.patterns.some((p) =>
          p instanceof RegExp ? p.test(model) : p === model,
        );
        expect(matches).toBe(true);
      }
    });

    it("patterns do not match invalid models", () => {
      for (const model of cfg.invalidModels) {
        const matches = cfg.patterns.some((p) =>
          p instanceof RegExp ? p.test(model) : p === model,
        );
        expect(matches).toBe(false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Connect error test
// ---------------------------------------------------------------------------

export function describeConnectError(
  LlmClass: new (config: {
    model: string;
    apiKey?: string;
  }) => {
    connect: (req: LlmRequest) => Promise<unknown>;
  },
  testModel: string,
) {
  describe("connect", () => {
    it("throws error indicating connect is not supported", async () => {
      const llm = new LlmClass({ model: testModel, apiKey: "test" });
      const request = {
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
      } as Parameters<typeof llm.connect>[0];

      expect(llm.connect(request)).rejects.toThrow(
        "does not support bidirectional streaming",
      );
    });
  });
}
