/**
 * A model variable in the child environment would change the model the
 * runtime runs without the driver knowing. The built-in providers never
 * forward one, but a custom provider `envAllowlist` can: such a run is
 * refused before anything starts, and the message names the variable but
 * never its value.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeAgentSdkDriver } from "../../../src/agents/driver/claude-agent-sdk.js";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  CODEX_MODEL_ENV,
  isClaudeModelEnv,
} from "../../../src/agents/driver/model.js";

/** The names the fixed Claude list held before it became a pattern. */
const CLAUDE_MODEL_ENV: readonly string[] = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
];

import { EXTERNAL_AGENT_MODEL_OVERRIDE } from "../../../src/agents/driver/policy-errors.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  type ExternalAgentDriver,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";
import type { ExternalAgentProviderDefinition } from "../../../src/agents/provider/schema.js";

const SECRET = "value-that-must-not-leak";

interface Harness {
  driver: ExternalAgentDriver;
  provider: ExternalAgentProviderDefinition;
  started(): boolean;
}

function claudeSdk(): Harness {
  let called = false;
  return {
    provider: CLAUDE_PROVIDER,
    started: () => called,
    driver: new ClaudeAgentSdkDriver({
      env: { PATH: "/usr/bin:/bin" },
      pathToClaudeCodeExecutable: "/example/bin/claude",
      sdk: {
        query: () => {
          called = true;
          throw new Error("query must not run");
        },
      } as never,
    }),
  };
}

function claudeCli(): Harness {
  let called = false;
  return {
    provider: CLAUDE_PROVIDER,
    started: () => called,
    driver: new ClaudeCliDriver({
      env: { PATH: "/usr/bin:/bin" },
      spawn: () => {
        called = true;
        throw new Error("spawn must not run");
      },
    }),
  };
}

function codexSdk(): Harness {
  let called = false;
  return {
    provider: CODEX_PROVIDER,
    started: () => called,
    driver: new CodexSdkDriver({
      env: { PATH: "/usr/bin:/bin" },
      codexPathOverride: "/example/bin/codex",
      listMcpServers: async () => [],
      Codex: class {
        constructor() {
          called = true;
        }
        startThread() {
          throw new Error("startThread must not run");
        }
        resumeThread() {
          throw new Error("resumeThread must not run");
        }
      } as never,
    }),
  };
}

function codexCli(): Harness {
  let called = false;
  return {
    provider: CODEX_PROVIDER,
    started: () => called,
    driver: new CodexCliDriver({
      env: { PATH: "/usr/bin:/bin" },
      listMcpServers: async () => [],
      spawn: () => {
        called = true;
        throw new Error("spawn must not run");
      },
    }),
  };
}

const CASES: readonly {
  name: string;
  build: () => Harness;
  names: readonly string[];
}[] = [
  { name: "ClaudeAgentSdkDriver", build: claudeSdk, names: CLAUDE_MODEL_ENV },
  { name: "ClaudeCliDriver", build: claudeCli, names: CLAUDE_MODEL_ENV },
  { name: "CodexSdkDriver", build: codexSdk, names: CODEX_MODEL_ENV },
  { name: "CodexCliDriver", build: codexCli, names: CODEX_MODEL_ENV },
];

async function collect(
  driver: ExternalAgentDriver,
  request: ExternalAgentRunRequest,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(request)) {
    events.push(event);
  }
  return events;
}

function requestWith(
  provider: ExternalAgentProviderDefinition,
  name: string,
): ExternalAgentRunRequest {
  return {
    // A custom provider definition that forwards the model variable.
    provider: { ...provider, envAllowlist: [name] },
    context: { input: "hi" } as never,
    permissions: { mode: "workspace-write", allowNetwork: true },
    credential: { kind: "env", env: { [name]: SECRET } },
  };
}

describe("a model variable in the run's environment is refused", () => {
  for (const { name, build, names } of CASES) {
    for (const variable of names) {
      for (const spelling of [variable, variable.toLowerCase()]) {
        test(`${name}: ${spelling}`, async () => {
          const harness = build();
          const events = await collect(
            harness.driver,
            requestWith(harness.provider, spelling),
          );
          expect(events.map((event) => event.type)).toEqual([
            "started",
            "error",
            "completed",
          ]);
          expect(events[0]).not.toHaveProperty("model");
          const error = events[1] as Extract<
            ExternalAgentEvent,
            { type: "error" }
          >;
          expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
          expect(error.recoverable).toBe(false);
          expect(error.message).toContain(spelling);
          expect(error.message).not.toContain(SECRET);
          expect(events[2]).toMatchObject({ type: "completed", exitCode: 1 });
          expect(harness.started()).toBe(false);
        });
      }
    }
  }

  test("the env check comes before the other pre-spawn refusals", async () => {
    const harness = codexCli();
    const request = requestWith(harness.provider, "OPENAI_BASE_URL");
    // full-access without allowNetwork is refused too, but later.
    const events = await collect(harness.driver, {
      ...request,
      permissions: { mode: "full-access", allowedPaths: ["/tmp/x"] },
    });
    expect(
      (events[1] as Extract<ExternalAgentEvent, { type: "error" }>).code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
  });
});

describe("the built-in providers forward no model variable", () => {
  for (const provider of [CLAUDE_PROVIDER, CODEX_PROVIDER]) {
    test(provider.id, () => {
      const forwarded = (provider.envAllowlist ?? []).filter(
        (name) =>
          isClaudeModelEnv(name) ||
          CODEX_MODEL_ENV.includes(name.toUpperCase()),
      );
      expect(forwarded).toEqual([]);
    });
  }
});

describe("the model env tables", () => {
  test("the Claude predicate refuses every name the old list held", () => {
    for (const name of CLAUDE_MODEL_ENV) {
      expect(isClaudeModelEnv(name)).toBe(true);
    }
  });

  test("the Codex table lists the reviewed variables", () => {
    expect([...CODEX_MODEL_ENV].sort()).toEqual(
      ["CODEX_OSS_BASE_URL", "CODEX_OSS_PORT", "OPENAI_BASE_URL"].sort(),
    );
  });
});
