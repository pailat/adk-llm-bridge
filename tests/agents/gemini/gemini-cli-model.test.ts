/**
 * The Gemini CLI driver sends its `model` as `--model=<id>`, keeps the model
 * of the `init` line on `completed` for diagnostics, and refuses a read-only
 * run with a model: plan mode (`--approval-mode=plan`) may route turns to
 * another model than `--model`.
 */

import { describe, expect, test } from "bun:test";
import {
  GeminiCliDriver,
  type GeminiCliSpawn,
} from "../../../src/agents/driver/gemini-cli.js";
import { GEMINI_PLAN_MODE_REASON } from "../../../src/agents/driver/model.js";
import { EXTERNAL_AGENT_MODEL_OVERRIDE } from "../../../src/agents/driver/policy-errors.js";
import {
  type ExternalAgentEvent,
  type ExternalAgentPermissionPolicy,
  type ExternalAgentRunRequest,
  GEMINI_CLI_PROVIDER,
} from "../../../src/agents/index.js";

interface Spawned {
  spawn: GeminiCliSpawn;
  argv(): readonly string[] | undefined;
}

function fakeSpawn(lines: readonly unknown[] = []): Spawned {
  let argv: readonly string[] | undefined;
  return {
    argv: () => argv,
    spawn: (_command, args) => {
      argv = args;
      return {
        stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
        exited: Promise.resolve(0),
      };
    },
  };
}

function request(
  permissions: ExternalAgentPermissionPolicy,
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: GEMINI_CLI_PROVIDER,
    context: { input: "hi" } as never,
    permissions,
    ...overrides,
  };
}

async function collect(
  driver: GeminiCliDriver,
  runRequest: ExternalAgentRunRequest,
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(runRequest)) {
    events.push(event);
  }
  return events;
}

const READ_ONLY: ExternalAgentPermissionPolicy = {
  mode: "read-only",
  allowNetwork: true,
};

describe("GeminiCliDriver model", () => {
  test("sends --model=<id> and keeps the init model on completed", async () => {
    const fake = fakeSpawn([
      { type: "init", session_id: "s", model: "gemini-3-pro" },
      { type: "message", role: "assistant", content: "hi" },
      { type: "result", status: "success" },
    ]);
    const events = await collect(
      new GeminiCliDriver({
        model: "gemini-3-pro",
        spawn: fake.spawn,
        env: { PATH: "/usr/bin:/bin" },
      }),
      request({ mode: "ask", allowNetwork: true }),
    );
    expect(fake.argv()).toContain("--model=gemini-3-pro");
    expect(events[0]).not.toHaveProperty("model");
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      exitCode: 0,
      model: "gemini-3-pro",
    });
  });

  test("the first init line's model is kept", async () => {
    const fake = fakeSpawn([
      { type: "init", session_id: "s", model: "gemini-3-pro" },
      { type: "init", session_id: "s", model: "gemini-3-flash" },
    ]);
    const events = await collect(
      new GeminiCliDriver({ spawn: fake.spawn, env: {} }),
      request({ mode: "ask", allowNetwork: true }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      model: "gemini-3-pro",
    });
  });

  test("a completed without an init line has no model", async () => {
    const fake = fakeSpawn([
      { type: "message", role: "assistant", content: "hi" },
    ]);
    const events = await collect(
      new GeminiCliDriver({ spawn: fake.spawn, env: {} }),
      request({ mode: "ask", allowNetwork: true }),
    );
    expect(events.at(-1)).not.toHaveProperty("model");
  });
});

describe("GeminiCliDriver plan mode (read-only)", () => {
  for (const options of [
    { model: "gemini-3-pro" },
    { model: "gemini-3-pro", requireExplicitModel: true },
  ]) {
    test(`refuses a read-only run with ${JSON.stringify(options)}`, async () => {
      const fake = fakeSpawn();
      const events = await collect(
        new GeminiCliDriver({ ...options, spawn: fake.spawn, env: {} }),
        request(READ_ONLY),
      );
      expect(events.map((event) => event.type)).toEqual([
        "started",
        "error",
        "completed",
      ]);
      expect(events[0]).not.toHaveProperty("modelRouting");
      const error = events[1] as Extract<ExternalAgentEvent, { type: "error" }>;
      expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
      expect(error.message).toContain(GEMINI_PLAN_MODE_REASON);
      expect(events[2]).toMatchObject({ type: "completed", exitCode: 1 });
      expect(fake.argv()).toBeUndefined();
    });
  }

  test("runs read-only without a model, and marks started as plan-mode", async () => {
    const fake = fakeSpawn();
    const events = await collect(
      new GeminiCliDriver({ spawn: fake.spawn, env: {} }),
      request(READ_ONLY),
    );
    expect(events[0]).toMatchObject({
      type: "started",
      modelRouting: "plan-mode",
    });
    expect(fake.argv()).toContain("--approval-mode=plan");
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
  });

  test("an unknown mode maps to plan mode too", async () => {
    const fake = fakeSpawn();
    const events = await collect(
      new GeminiCliDriver({
        model: "gemini-3-pro",
        spawn: fake.spawn,
        env: {},
      }),
      request({ mode: "bogus", allowNetwork: true } as never),
    );
    expect(
      (events[1] as Extract<ExternalAgentEvent, { type: "error" }>).code,
    ).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
  });

  for (const mode of ["ask", "workspace-write"] as const) {
    test(`${mode} with a model runs, without modelRouting`, async () => {
      const fake = fakeSpawn();
      const events = await collect(
        new GeminiCliDriver({
          model: "gemini-3-pro",
          spawn: fake.spawn,
          env: {},
        }),
        request({ mode, allowNetwork: true }),
      );
      expect(events[0]).not.toHaveProperty("modelRouting");
      expect(fake.argv()).toContain("--model=gemini-3-pro");
      expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    });
  }

  test("the env check wins over the plan-mode refusal", async () => {
    const fake = fakeSpawn();
    const events = await collect(
      new GeminiCliDriver({
        model: "gemini-3-pro",
        spawn: fake.spawn,
        env: {},
      }),
      request(READ_ONLY, {
        provider: { ...GEMINI_CLI_PROVIDER, envAllowlist: ["GEMINI_MODEL"] },
        credential: { kind: "env", env: { GEMINI_MODEL: "gemini-flash" } },
      }),
    );
    const error = events[1] as Extract<ExternalAgentEvent, { type: "error" }>;
    expect(error.code).toBe(EXTERNAL_AGENT_MODEL_OVERRIDE);
    expect(error.message).toContain("GEMINI_MODEL");
    expect(error.message).not.toContain(GEMINI_PLAN_MODE_REASON);
  });

  test("a read-only run refused by the env check has no modelRouting", async () => {
    const fake = fakeSpawn();
    const events = await collect(
      new GeminiCliDriver({ spawn: fake.spawn, env: {} }),
      request(READ_ONLY, {
        provider: { ...GEMINI_CLI_PROVIDER, envAllowlist: ["GEMINI_MODEL"] },
        credential: { kind: "env", env: { GEMINI_MODEL: "gemini-flash" } },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[0]).not.toHaveProperty("modelRouting");
    expect(fake.argv()).toBeUndefined();
  });

  test("the plan-mode refusal comes before the network refusal", async () => {
    const fake = fakeSpawn();
    const events = await collect(
      new GeminiCliDriver({
        model: "gemini-3-pro",
        spawn: fake.spawn,
        env: {},
      }),
      request({ mode: "read-only" }),
    );
    expect(
      (events[1] as Extract<ExternalAgentEvent, { type: "error" }>).message,
    ).toContain(GEMINI_PLAN_MODE_REASON);
  });
});
