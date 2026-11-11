/**
 * Boolean driver options must be real booleans. An untyped host (an env var,
 * a JSON file) that passes `"false"` used to turn an escape hatch such as
 * `allowUnsandboxedShell` ON, because the driver read it as truthy. Every
 * `?: boolean` field of the five public driver configs is checked when the
 * driver is built. The key lists below are written out on purpose: a key
 * dropped from the product list is caught here.
 */

import { describe, expect, test } from "bun:test";
import { InputValidationError } from "@google/adk";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import { GeminiCliDriver } from "../../../src/agents/driver/gemini-cli.js";

interface DriverCase {
  readonly name: string;
  /** Options that make `requireExplicitModel: true` satisfiable. */
  readonly base: Record<string, unknown>;
  readonly keys: readonly string[];
  readonly build: (config: Record<string, unknown>) => unknown;
}

const DRIVERS: readonly DriverCase[] = [
  {
    name: "ClaudeCliDriver",
    base: { model: "some-model-id", smallFastModel: "claude-haiku-5-5" },
    keys: [
      "allowPolicyOverrideArgs",
      "requireExplicitModel",
      "inheritHostConfig",
      "allowUnsandboxedShell",
      "allowLocalBinding",
      "allowBackgroundTasks",
      "allowUnenforcedPaths",
    ],
    build: (config) => new ClaudeCliDriver(config as never),
  },
  {
    name: "ClaudeAgentSdkDriver",
    base: { model: "some-model-id", smallFastModel: "claude-haiku-5-5" },
    keys: [
      "requireExplicitModel",
      "debugEvents",
      "inheritHostConfig",
      "allowUnsandboxedShell",
      "allowLocalBinding",
      "allowBackgroundTasks",
      "strictBinaryResolution",
      "forkSession",
    ],
    build: (config) => new ClaudeAgentSdkDriver(config as never),
  },
  {
    name: "CodexCliDriver",
    base: { model: "some-model-id" },
    keys: [
      "requireExplicitModel",
      "allowPolicyOverrideArgs",
      "skipGitRepoCheck",
      "allowUnenforcedNetwork",
      "allowUnenforcedPaths",
    ],
    build: (config) => new CodexCliDriver(config as never),
  },
  {
    name: "CodexSdkDriver",
    base: { model: "some-model-id" },
    keys: [
      "requireExplicitModel",
      "skipGitRepoCheck",
      "webSearchEnabled",
      "allowUnenforcedNetwork",
      "allowUnenforcedPaths",
      "allowUncontainedCodexSdk",
      "strictBinaryResolution",
    ],
    build: (config) => new CodexSdkDriver(config as never),
  },
  {
    name: "GeminiCliDriver",
    base: { model: "some-model-id" },
    keys: [
      "allowUnenforcedNetwork",
      "allowUnenforcedPaths",
      "requireExplicitModel",
    ],
    build: (config) => new GeminiCliDriver(config as never),
  },
];

describe("driver boolean options", () => {
  for (const driver of DRIVERS) {
    for (const key of driver.keys) {
      for (const bad of ["false", "true", 1, 0, null, {}] as const) {
        test(`${driver.name}: ${key}=${JSON.stringify(bad)} throws`, () => {
          let caught: unknown;
          try {
            driver.build({ ...driver.base, [key]: bad });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(InputValidationError);
          const message = (caught as Error).message;
          expect(message).toContain(driver.name);
          expect(message).toContain(key);
          expect(message).toContain("must be a boolean");
        });
      }
      test(`${driver.name}: ${key} accepts true, false and absent`, () => {
        expect(() =>
          driver.build({ ...driver.base, [key]: true }),
        ).not.toThrow();
        expect(() =>
          driver.build({ ...driver.base, [key]: false }),
        ).not.toThrow();
        expect(() => driver.build({ ...driver.base })).not.toThrow();
      });
    }
  }

  test("an undefined value is the same as absent", () => {
    for (const driver of DRIVERS) {
      for (const key of driver.keys) {
        expect(() =>
          driver.build({ ...driver.base, [key]: undefined }),
        ).not.toThrow();
      }
    }
  });
});
