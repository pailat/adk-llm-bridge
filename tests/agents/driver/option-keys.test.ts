/**
 * Every public driver refuses, when it is built, a config that is not a plain
 * object, has a symbol key, or has a key it does not know. The key tuples
 * match the config interfaces exactly (type test below).
 */

import { describe, expect, test } from "bun:test";
import {
  ClaudeAgentSdkDriver,
  type ClaudeAgentSdkDriverConfig,
} from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliDriverConfig,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CodexCliDriver,
  type CodexCliDriverConfig,
} from "../../../src/agents/driver/codex-cli.js";
import {
  CodexSdkDriver,
  type CodexSdkDriverConfig,
} from "../../../src/agents/driver/codex-sdk.js";
import {
  FxCliDriver,
  type FxCliDriverConfig,
} from "../../../src/agents/driver/fx-cli.js";
import {
  CLAUDE_AGENT_SDK_ONLY_KEYS,
  CLAUDE_AGENT_SDK_OPTION_KEYS,
  CLAUDE_CLI_OPTION_KEYS,
  CODEX_CLI_OPTION_KEYS,
  CODEX_SDK_OPTION_KEYS,
  FX_CLI_OPTION_KEYS,
  SUBPROCESS_JSONL_OPTION_KEYS,
} from "../../../src/agents/driver/option-keys.js";
import {
  EXTERNAL_AGENT_OPTION_UNKNOWN,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import {
  SubprocessJsonlDriver,
  type SubprocessJsonlDriverConfig,
} from "../../../src/agents/driver/subprocess-jsonl.js";
import * as agents from "../../../src/agents/index.js";
import {
  CLAUDE_AGENT_DEFINITION,
  CODEX_AGENT_DEFINITION,
  createDefaultExternalAgentDefinitionRegistry,
  createExternalAgent,
  FX_AGENT_DEFINITION,
} from "../../../src/agents/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Compile-time exhaustiveness: each tuple is exactly `keyof` its config.
const exhaustive: [
  Equal<
    keyof ClaudeAgentSdkDriverConfig,
    (typeof CLAUDE_AGENT_SDK_OPTION_KEYS)[number]
  >,
  Equal<keyof ClaudeCliDriverConfig, (typeof CLAUDE_CLI_OPTION_KEYS)[number]>,
  Equal<keyof CodexSdkDriverConfig, (typeof CODEX_SDK_OPTION_KEYS)[number]>,
  Equal<keyof CodexCliDriverConfig, (typeof CODEX_CLI_OPTION_KEYS)[number]>,
  Equal<keyof FxCliDriverConfig, (typeof FX_CLI_OPTION_KEYS)[number]>,
  Equal<
    keyof SubprocessJsonlDriverConfig,
    (typeof SUBPROCESS_JSONL_OPTION_KEYS)[number]
  >,
] = [true, true, true, true, true, true];

type Build = (config: unknown) => unknown;

const DRIVERS: readonly {
  name: string;
  build: Build;
  base: Record<string, unknown>;
  keys: readonly string[];
}[] = [
  {
    name: "ClaudeAgentSdkDriver",
    build: (c) => new ClaudeAgentSdkDriver(c as ClaudeAgentSdkDriverConfig),
    base: {},
    keys: CLAUDE_AGENT_SDK_OPTION_KEYS,
  },
  {
    name: "ClaudeCliDriver",
    build: (c) => new ClaudeCliDriver(c as ClaudeCliDriverConfig),
    base: {},
    keys: CLAUDE_CLI_OPTION_KEYS,
  },
  {
    name: "CodexSdkDriver",
    build: (c) => new CodexSdkDriver(c as CodexSdkDriverConfig),
    base: {},
    keys: CODEX_SDK_OPTION_KEYS,
  },
  {
    name: "CodexCliDriver",
    build: (c) => new CodexCliDriver(c as CodexCliDriverConfig),
    base: {},
    keys: CODEX_CLI_OPTION_KEYS,
  },
  {
    name: "FxCliDriver",
    build: (c) => new FxCliDriver(c as FxCliDriverConfig),
    base: { model: "fx-test-model" },
    keys: FX_CLI_OPTION_KEYS,
  },
  {
    name: "SubprocessJsonlDriver",
    build: (c) => new SubprocessJsonlDriver(c as SubprocessJsonlDriverConfig),
    base: { providerId: "fake", command: "/bin/true" },
    keys: SUBPROCESS_JSONL_OPTION_KEYS,
  },
];

function refusal(build: () => unknown): ExternalAgentPolicyError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    const policy = error as ExternalAgentPolicyError;
    expect(policy.code).toBe(EXTERNAL_AGENT_OPTION_UNKNOWN);
    expect(policy.recoverable).toBe(false);
    return policy;
  }
  throw new Error("expected EXTERNAL_AGENT_OPTION_UNKNOWN");
}

describe("unknown driver options (step 0)", () => {
  test("the key tuples match the config interfaces", () => {
    expect(exhaustive.every(Boolean)).toBe(true);
    for (const { keys } of DRIVERS) {
      expect(Object.isFrozen(keys)).toBe(true);
      expect([...keys].sort()).toEqual([...keys]);
    }
  });

  test("both Claude drivers list smallFastModel and accept a full model id for it", () => {
    for (const { name, build, base, keys } of DRIVERS) {
      if (name !== "ClaudeAgentSdkDriver" && name !== "ClaudeCliDriver") {
        continue;
      }
      expect(keys).toContain("smallFastModel");
      expect(() =>
        build({
          ...base,
          model: "claude-haiku-5-5",
          smallFastModel: "claude-haiku-5-5",
        }),
      ).not.toThrow();
    }
  });

  for (const driver of DRIVERS) {
    describe(driver.name, () => {
      test("a misspelled key is refused, naming the key and the driver", () => {
        const error = refusal(() =>
          driver.build({ ...driver.base, modle: "x" }),
        );
        expect(error.message).toContain(driver.name);
        expect(error.message).toContain('"modle"');
      });

      test("an unknown key with the value undefined is refused", () => {
        refusal(() => driver.build({ ...driver.base, modle: undefined }));
      });

      test("the first unknown key in sorted order is named", () => {
        const error = refusal(() =>
          driver.build({ ...driver.base, zeta: 1, alpha: 2 }),
        );
        expect(error.message).toContain('"alpha"');
        expect(error.message).not.toContain('"zeta"');
      });

      test("a config inheriting a key from its prototype is refused", () => {
        const config = Object.assign(
          Object.create({ inheritHostConfig: true }),
          driver.base,
        );
        const error = refusal(() => driver.build(config));
        expect(error.message).toContain("plain object");
      });

      test("a class instance is refused", () => {
        class Options {
          constructor() {
            Object.assign(this, driver.base);
          }
        }
        refusal(() => driver.build(new Options()));
      });

      test("a symbol key is refused", () => {
        const error = refusal(() =>
          driver.build({ ...driver.base, [Symbol("x")]: 1 }),
        );
        expect(error.message).toContain("symbol");
      });

      test("a null-prototype object with known keys is accepted", () => {
        const config = Object.assign(Object.create(null), driver.base);
        expect(() => driver.build(config)).not.toThrow();
      });

      test("every known key may be present with the value undefined", () => {
        const config: Record<string, unknown> = { ...driver.base };
        for (const key of driver.keys) {
          if (!(key in config)) config[key] = undefined;
        }
        expect(() => driver.build(config)).not.toThrow();
      });
    });
  }

  for (const driver of DRIVERS.filter(
    (d) => d.name !== "ClaudeAgentSdkDriver",
  )) {
    test(`${driver.name}: an MCP option points at ClaudeAgentSdkDriver`, () => {
      for (const key of [
        "mcpServers",
        "requiredMcpServers",
        "mcpConnectTimeoutMs",
      ]) {
        const error = refusal(() =>
          driver.build({ ...driver.base, [key]: undefined }),
        );
        expect(error.message).toContain(
          "supported only by ClaudeAgentSdkDriver",
        );
      }
    });
  }

  test("the SDK-only hint names only shipped keys that no other driver lists", () => {
    const sdk = new Set<string>(CLAUDE_AGENT_SDK_OPTION_KEYS);
    for (const key of CLAUDE_AGENT_SDK_ONLY_KEYS) {
      expect(sdk.has(key)).toBe(true);
      for (const driver of DRIVERS) {
        if (driver.name === "ClaudeAgentSdkDriver") continue;
        expect(driver.keys).not.toContain(key);
      }
    }
    for (const key of ["mcpServers", "requiredMcpServers"]) {
      expect(CLAUDE_AGENT_SDK_ONLY_KEYS.has(key)).toBe(true);
    }
  });

  test("ClaudeAgentSdkDriver: an unshipped key gets no SDK-only hint", () => {
    for (const key of ["skills", "inheritMcpServers"]) {
      const error = refusal(
        () => new ClaudeAgentSdkDriver({ [key]: true } as never),
      );
      expect(error.message).not.toContain("supported only by");
    }
  });

  test("ClaudeAgentSdkDriver: a key that only another driver has is refused", () => {
    const error = refusal(
      () => new ClaudeAgentSdkDriver({ args: [] } as never),
    );
    expect(error.message).not.toContain("supported only by");
  });

  test("an omitted config is the empty object", () => {
    expect(() => new ClaudeAgentSdkDriver()).not.toThrow();
    expect(() => new ClaudeCliDriver()).not.toThrow();
    expect(() => new CodexSdkDriver()).not.toThrow();
    expect(() => new CodexCliDriver()).not.toThrow();
  });

  test("a subclass checks its own keys, not the base driver's", () => {
    // `providerId` is a SubprocessJsonlDriver key but not a Codex CLI one.
    refusal(() => new CodexCliDriver({ providerId: "x" } as never));
    // `killGraceMs` is a Codex CLI key but not a SubprocessJsonlDriver one.
    expect(() => new CodexCliDriver({ killGraceMs: 10 })).not.toThrow();
  });
});

describe("unknown options through the agent factories", () => {
  test("registry.create() refuses a misspelled driverOptions key", () => {
    refusal(() =>
      createDefaultExternalAgentDefinitionRegistry().create("codex", {
        name: "codex",
        driverOptions: { modle: "gpt-5-codex" } as never,
      }),
    );
  });

  test("createExternalAgent() refuses a misspelled driverOptions key", () => {
    refusal(() =>
      createExternalAgent(CLAUDE_AGENT_DEFINITION, {
        name: "claude",
        driverOptions: { modle: "claude-haiku-4-5" } as never,
      }),
    );
    refusal(() =>
      createExternalAgent(FX_AGENT_DEFINITION, {
        name: "fx",
        driverOptions: { mcpServers: {} } as never,
      }),
    );
    refusal(() =>
      createExternalAgent(CODEX_AGENT_DEFINITION, {
        name: "codex",
        driverOptions: { inheritHostConfig: true } as never,
      }),
    );
  });
});

describe("every exported driver refuses an unknown option", () => {
  // Each constructor checks its keys before anything else, so no valid config
  // is needed. A driver that extends SubprocessJsonlDriver gets no check from
  // the base class and must call it itself.
  const EXCLUDED: Readonly<Record<string, string>> = {
    PlaceholderExternalAgentDriver:
      "a placeholder that takes no config and never runs",
  };
  const drivers = Object.entries(agents).filter(
    ([name, value]) => name.endsWith("Driver") && typeof value === "function",
  ) as [string, new (config?: unknown) => unknown][];

  test("the guard sees the built-in drivers", () => {
    const names = drivers.map(([name]) => name);
    for (const name of [
      "ClaudeAgentSdkDriver",
      "ClaudeCliDriver",
      "CodexCliDriver",
      "CodexSdkDriver",
      "FxCliDriver",
    ]) {
      expect(names).toContain(name);
    }
    for (const name of Object.keys(EXCLUDED)) {
      expect(names).toContain(name);
    }
  });

  for (const [name, Driver] of drivers) {
    if (name in EXCLUDED) continue;
    test(`${name}: new ${name}({ notAnOption: 1 }) throws EXTERNAL_AGENT_OPTION_UNKNOWN`, () => {
      const error = refusal(() => new Driver({ notAnOption: 1 }));
      expect(error.message).toContain(name);
      expect(error.message).toContain('"notAnOption"');
    });
  }
});
