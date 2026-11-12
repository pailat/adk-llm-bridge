/**
 * `smallFastModel` pins the Claude Code small/fast model: the driver sets
 * `ANTHROPIC_SMALL_FAST_MODEL` in the child environment after the model
 * environment refusal, so a host can never forward the variable itself. The
 * refusal is a pattern (any name containing MODEL, a few named variables and
 * a prefix), not a list.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawnOptions,
} from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import { FxCliDriver } from "../../../src/agents/driver/fx-cli.js";
import {
  assertSmallFastModelOption,
  CLAUDE_MODEL_ENV_RULE,
  isClaudeModelEnv,
  stripBracketSuffix,
} from "../../../src/agents/driver/model.js";
import {
  EXTERNAL_AGENT_MODEL_INVALID,
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  EXTERNAL_AGENT_MODEL_REQUIRED,
  EXTERNAL_AGENT_OPTION_UNKNOWN,
  ExternalAgentPolicyError,
} from "../../../src/agents/driver/policy-errors.js";
import {
  CLAUDE_PROVIDER,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";

const PIN = "ANTHROPIC_SMALL_FAST_MODEL";
const SECRET = "value-that-must-not-leak";
const PIN_VALUE = "pin-value-that-must-not-leak";
const REQUEST: ExternalAgentRunRequest = {
  provider: CLAUDE_PROVIDER,
  context: {} as never,
  instruction: "go",
  permissions: { mode: "workspace-write", allowNetwork: true },
};

const INIT = { type: "system", subtype: "init", model: "claude-test" };
const RESULT = {
  type: "result",
  subtype: "success",
  result: "ok",
  session_id: "s-1",
};

type Kind = "sdk" | "cli";
interface Seen {
  env?: Record<string, string | undefined>;
  started: boolean;
}

function build(
  kind: Kind,
  config: Record<string, unknown>,
  seen: Seen = { started: false },
): ExternalAgentDriver {
  if (kind === "sdk") {
    return new ClaudeAgentSdkDriver({
      env: { PATH: "/usr/bin:/bin" },
      pathToClaudeCodeExecutable: "/example/bin/claude",
      ...config,
      sdk: {
        query: ({ options }: { options: Record<string, unknown> }) => {
          seen.started = true;
          seen.env = options.env as Record<string, string | undefined>;
          return (async function* () {
            yield INIT as never;
            yield RESULT as never;
          })() as never;
        },
      },
    } as never);
  }
  return new ClaudeCliDriver({
    env: { PATH: "/usr/bin:/bin" },
    ...config,
    spawn: (
      _command: string,
      _args: string[],
      options: ClaudeCliSpawnOptions,
    ) => {
      seen.started = true;
      seen.env = options.env as Record<string, string | undefined>;
      return {
        stdout: [INIT, RESULT].map((line) => `${JSON.stringify(line)}\n`),
        stderr: [],
        exited: Promise.resolve(0),
      };
    },
  } as never);
}

async function collect(
  driver: ExternalAgentDriver,
  request: ExternalAgentRunRequest = REQUEST,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(request)) events.push(event);
  return events;
}

/** A request whose provider forwards `name` from the credential. */
function forwarding(name: string, value = SECRET): ExternalAgentRunRequest {
  return {
    ...REQUEST,
    provider: { ...CLAUDE_PROVIDER, envAllowlist: [name] },
    credential: { kind: "env", env: { [name]: value } },
  };
}

function errorOf(events: ExternalAgentEvent[]) {
  return events.find(
    (event): event is Extract<ExternalAgentEvent, { type: "error" }> =>
      event.type === "error",
  );
}

function thrown(build: () => unknown): ExternalAgentPolicyError {
  try {
    build();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalAgentPolicyError);
    return error as ExternalAgentPolicyError;
  }
  throw new Error("expected the constructor to throw");
}

const KINDS: readonly Kind[] = ["sdk", "cli"];

describe("the pin reaches the child environment", () => {
  for (const kind of KINDS) {
    test(`${kind}: the child env holds ANTHROPIC_SMALL_FAST_MODEL, buildEnv does not`, async () => {
      const seen: Seen = { started: false };
      const driver = build(kind, { smallFastModel: "claude-haiku-5-5" }, seen);
      const events = await collect(driver);
      expect(errorOf(events)).toBeUndefined();
      expect(seen.env?.[PIN]).toBe("claude-haiku-5-5");
      // Only the pin: ANTHROPIC_DEFAULT_HAIKU_MODEL would remap the alias for
      // the main model and the sub-agents too.
      const modelKeys = Object.keys(seen.env ?? {}).filter((name) =>
        /MODEL/i.test(name),
      );
      expect(modelKeys).toEqual([PIN]);
      const built = (
        driver as unknown as {
          buildEnv(request: ExternalAgentRunRequest): Record<string, unknown>;
        }
      ).buildEnv(REQUEST);
      expect(built).not.toHaveProperty(PIN);
      expect((driver as { smallFastModel?: string }).smallFastModel).toBe(
        "claude-haiku-5-5",
      );
    });

    test(`${kind}: unset, no ANTHROPIC_SMALL_FAST_MODEL key at all`, async () => {
      const seen: Seen = { started: false };
      const driver = build(kind, {}, seen);
      await collect(driver);
      expect(seen.started).toBe(true);
      expect(seen.env).not.toHaveProperty(PIN);
      expect((driver as { smallFastModel?: string }).smallFastModel).toBe(
        undefined,
      );
    });
  }
});

describe("a host cannot forward the variable", () => {
  for (const kind of KINDS) {
    for (const config of [{}, { smallFastModel: "claude-haiku-5-5" }]) {
      test(`${kind}: refused ${Object.keys(config).length ? "with" : "without"} the option`, async () => {
        const seen: Seen = { started: false };
        const events = await collect(
          build(kind, config, seen),
          forwarding(PIN),
        );
        const error = errorOf(events);
        expect(error?.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
        expect(error?.message).toContain(PIN);
        expect(error?.message).not.toContain(SECRET);
        expect(seen.started).toBe(false);
      });
    }

    test(`${kind}: neither the pin value nor the host value reaches a message`, async () => {
      const events = await collect(
        build(kind, { smallFastModel: PIN_VALUE }),
        forwarding(PIN),
      );
      const text = JSON.stringify(events);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PIN_VALUE);
    });
  }
});

describe("the option grammar", () => {
  const bad: unknown[] = ["", " x", "-x", "a\u0007", "x".repeat(257), 7, {}];
  for (const kind of KINDS) {
    for (const value of bad) {
      test(`${kind}: ${JSON.stringify(value)?.slice(0, 20)} is refused`, () => {
        const error = thrown(() => build(kind, { smallFastModel: value }));
        expect(error.code).toBe(EXTERNAL_AGENT_MODEL_INVALID);
        expect(error.message).toContain("smallFastModel");
      });
    }
  }
});

describe("requireExplicitModel", () => {
  for (const kind of KINDS) {
    test(`${kind}: model without smallFastModel is refused`, () => {
      const error = thrown(() =>
        build(kind, { model: "claude-opus-5-5", requireExplicitModel: true }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
      expect(error.message).toContain("smallFastModel");
    });

    for (const alias of [
      "haiku",
      "HAIKU",
      "sonnet",
      "opus[1m]",
      "Fable",
      "best",
      "DEFAULT",
      "opusplan[1m]",
    ]) {
      test(`${kind}: the alias ${alias} is not a full model id`, () => {
        const error = thrown(() =>
          build(kind, {
            model: "claude-opus-5-5",
            requireExplicitModel: true,
            smallFastModel: alias,
          }),
        );
        expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
        expect(error.message).toContain("full model id");
      });
    }

    test(`${kind}: the alias refusal names the tier, never the raw value`, () => {
      const error = thrown(() =>
        build(kind, {
          model: "claude-opus-5-5",
          requireExplicitModel: true,
          smallFastModel: "Opus[raw-secret-text]",
        }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_REQUIRED);
      expect(error.message).toContain('"opus"');
      expect(error.message).not.toContain("raw-secret-text");
    });

    test(`${kind}: a full id is accepted`, () => {
      const driver = build(kind, {
        model: "claude-opus-5-5",
        requireExplicitModel: true,
        smallFastModel: "claude-haiku-5-5",
      });
      expect((driver as { smallFastModel?: string }).smallFastModel).toBe(
        "claude-haiku-5-5",
      );
    });

    test(`${kind}: without requireExplicitModel an alias is accepted`, () => {
      expect(() => build(kind, { smallFastModel: "haiku" })).not.toThrow();
    });

    test(`${kind}: an invalid model wins over a missing smallFastModel`, () => {
      const error = thrown(() =>
        build(kind, { model: "-x", requireExplicitModel: true }),
      );
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_INVALID);
    });
  }
});

describe("the Codex drivers do not take the option", () => {
  // Codex drivers must never set the Claude variable or expose a pin.
  test("Codex and the Claude pin share no state", () => {
    const sdk = new CodexSdkDriver({ sdk: {} as never, model: "gpt-x" });
    const cli = new CodexCliDriver({ model: "gpt-x" });
    expect((sdk as { smallFastModel?: string }).smallFastModel).toBe(undefined);
    expect((cli as { smallFastModel?: string }).smallFastModel).toBe(undefined);
  });
});

describe("stripBracketSuffix equals the old end-anchored regex", () => {
  // The regex it replaced (CodeQL js/polynomial-redos on library input).
  const oldRegex = (value: string) => value.replace(/\[[^\]]*\]$/u, "");
  const cases = [
    "opus[1m]",
    "sonnet[1m]",
    "haiku[1m]",
    "opus",
    "claude-haiku-5-5",
    "a[b[c]",
    "a[b]c]",
    "a]b[c]",
    "[x]",
    "[]",
    "a[]",
    "a]",
    "]",
    "[",
    "a[",
    "a[b",
    "a[b]c",
    "a[b][c]",
    "a][b]",
    "[[]",
    "[]]",
    "[a]]",
    "a[[[b]",
    "a]]]",
    "",
    "]]",
    "][",
    "x[1m][2m]",
  ];
  for (const value of cases) {
    test(`${JSON.stringify(value)}`, () => {
      expect(stripBracketSuffix(value)).toBe(oldRegex(value));
    });
  }

  test("agrees with the regex on every string over [ ] a up to length 8", () => {
    const alphabet = ["[", "]", "a"];
    let checked = 0;
    const walk = (prefix: string) => {
      expect(stripBracketSuffix(prefix)).toBe(oldRegex(prefix));
      checked++;
      if (prefix.length === 8) return;
      for (const ch of alphabet) walk(prefix + ch);
    };
    walk("");
    expect(checked).toBe(9841);
  });

  test("many open brackets return at once", () => {
    for (const input of [
      `a${"[".repeat(50000)}]`,
      `${"[".repeat(50000)}`,
      `${"[]".repeat(25000)}`,
      `a${"[".repeat(50000)}b]`,
    ]) {
      const start = performance.now();
      stripBracketSuffix(input);
      expect(performance.now() - start).toBeLessThan(50);
    }
  });

  test("a long smallFastModel is refused before it reaches the strip", () => {
    const start = performance.now();
    expect(() =>
      assertSmallFastModelOption(
        "ClaudeCliDriver",
        `a${"[".repeat(50000)}]`,
        true,
      ),
    ).toThrow(ExternalAgentPolicyError);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("a driver without the option refuses it with a typed error", () => {
  // smallFastModel is Claude-only. Codex and fx must not drop it silently:
  // a host that passes it believes a small/fast model is pinned.
  const builders: readonly [string, () => unknown][] = [
    [
      "CodexSdkDriver",
      () =>
        new CodexSdkDriver({
          sdk: {} as never,
          model: "gpt-x",
          smallFastModel: "claude-haiku-5-5",
        } as never),
    ],
    [
      "CodexCliDriver",
      () =>
        new CodexCliDriver({
          model: "gpt-x",
          smallFastModel: "claude-haiku-5-5",
        } as never),
    ],
    [
      "FxCliDriver",
      () =>
        new FxCliDriver({
          model: "fx-x",
          smallFastModel: "claude-haiku-5-5",
        } as never),
    ],
  ];
  for (const [name, build] of builders) {
    test(`${name} throws EXTERNAL_AGENT_OPTION_UNKNOWN naming smallFastModel`, () => {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExternalAgentPolicyError);
      const error = thrown as ExternalAgentPolicyError;
      expect(error.code).toBe(EXTERNAL_AGENT_OPTION_UNKNOWN);
      expect(error.message).toContain(name);
      expect(error.message).toContain('"smallFastModel"');
    });
  }
});

describe("the Claude model environment is refused by pattern", () => {
  const names = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CLAUDE_CODE_MODEL_CATALOG",
    "CLAUDE_CODE_MODEL_CATALOG_URL",
    "CLAUDE_CODE_CLIENT_DATA_URL",
    "CLAUDE_CODE_ALLOW_OTHER_MODELS",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
    "CLAUDE_CODE_3P_SEEDED_OPUS_DEFAULT",
    "CLAUDE_CODE_3P_PROBE_WROTE_HAIKU_DEFAULT",
    "CLAUDE_CODE_NO_MODEL_FALLBACK",
    "CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK",
    "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP",
    "CLAUDE_CODE_AUTO_MODE_MODEL",
    "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
    "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
    "CLAUDE_CODE_FOO_MODEL",
    "claude_code_foo_model",
    "claude_code_3p_future_thing",
  ];
  for (const kind of KINDS) {
    for (const name of names) {
      test(`${kind}: ${name}`, async () => {
        const seen: Seen = { started: false };
        const events = await collect(build(kind, {}, seen), forwarding(name));
        const error = errorOf(events);
        expect(error?.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
        expect(error?.message).toContain(name);
        expect(error?.message).not.toContain(SECRET);
        expect(seen.started).toBe(false);
      });
    }
  }

  test("the predicate", () => {
    expect(isClaudeModelEnv("anything_with_Model_inside")).toBe(true);
    expect(isClaudeModelEnv("CLAUDE_CODE_CLIENT_DATA_URL")).toBe(true);
    expect(isClaudeModelEnv("CLAUDE_CODE_3P_X")).toBe(true);
    expect(isClaudeModelEnv("PATH")).toBe(false);
    expect(isClaudeModelEnv("CLAUDE_CODE_TMPDIR")).toBe(false);
    expect(CLAUDE_MODEL_ENV_RULE.review).toContain("2.1.319");
  });
});

describe("what the bridge puts in the env is never refused", () => {
  for (const kind of KINDS) {
    test(`${kind}: no buildEnv name matches the rule`, () => {
      const driver = build(kind, {
        env: { PATH: "/usr/bin:/bin", HOME: "/home/x", USER: "x" },
      }) as unknown as {
        buildEnv(request: ExternalAgentRunRequest): Record<string, unknown>;
      };
      const env = driver.buildEnv({
        ...REQUEST,
        provider: { ...CLAUDE_PROVIDER, envAllowlist: [] },
      });
      expect(Object.keys(env).length).toBeGreaterThan(2);
      for (const name of Object.keys(env)) {
        expect(isClaudeModelEnv(name)).toBe(false);
      }
    });
  }

  test("no Claude provider envAllowlist entry is a model variable", () => {
    for (const name of CLAUDE_PROVIDER.envAllowlist ?? []) {
      expect(isClaudeModelEnv(name)).toBe(false);
    }
  });
});

describe("a region variable is routing, not model choice", () => {
  const regions = [
    "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
    "anthropic_small_fast_model_aws_region",
    "VERTEX_REGION_CLAUDE_HAIKU_5_5",
  ];
  for (const kind of KINDS) {
    for (const name of regions) {
      for (const config of [{}, { smallFastModel: "claude-haiku-5-5" }]) {
        test(`${kind}: ${name} ${Object.keys(config).length ? "with" : "without"} the option`, async () => {
          const seen: Seen = { started: false };
          const events = await collect(
            build(kind, config, seen),
            forwarding(name, "us-east-1"),
          );
          expect(errorOf(events)).toBeUndefined();
          expect(seen.started).toBe(true);
        });
      }
    }
  }
});
