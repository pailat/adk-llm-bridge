/**
 * The Claude CLI names the model it runs on its `system/init` line, so the
 * driver emits `started` with the first output line and carries that model.
 * Every path that ends before any output still starts with `started`.
 */

import { describe, expect, test } from "bun:test";
import {
  ClaudeCliDriver,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import {
  CLAUDE_PROVIDER,
  type ExternalAgentEvent,
  type ExternalAgentRunRequest,
} from "../../../src/agents/index.js";

const INIT = {
  type: "system",
  subtype: "init",
  session_id: "s1",
  model: "claude-opus-5-5",
};

function result(modelUsage: Record<string, unknown>) {
  return {
    type: "result",
    subtype: "success",
    result: "done",
    modelUsage,
  };
}

const USAGE = { inputTokens: 1, outputTokens: 1, costUSD: 0.001 };

function request(
  overrides: Partial<ExternalAgentRunRequest> = {},
): ExternalAgentRunRequest {
  return {
    provider: CLAUDE_PROVIDER,
    context: {} as never,
    instruction: "x",
    permissions: { mode: "ask", allowNetwork: true },
    ...overrides,
  };
}

function spawnLines(
  lines: readonly unknown[],
  options: { exitCode?: number; stderr?: string[] } = {},
): ClaudeCliSpawn {
  return () => ({
    stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
    stderr: (options.stderr ?? []).map((line) => `${line}\n`),
    exited: Promise.resolve(options.exitCode ?? 0),
  });
}

async function collect(
  driver: ClaudeCliDriver,
  runRequest: ExternalAgentRunRequest = request(),
): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run(runRequest)) {
    events.push(event);
  }
  return events;
}

function completedOf(events: readonly ExternalAgentEvent[]) {
  return events.find(
    (event): event is Extract<ExternalAgentEvent, { type: "completed" }> =>
      event.type === "completed",
  );
}

describe("ClaudeCliDriver started carries the init model", () => {
  test("started.model is the model of system/init, and comes first", async () => {
    const before = Date.now();
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([
          INIT,
          {
            type: "assistant",
            message: { content: [{ type: "text", text: "hi" }] },
          },
          result({ "claude-opus-5-5": USAGE }),
        ]),
      }),
    );
    expect(events[0]).toMatchObject({
      type: "started",
      providerId: CLAUDE_PROVIDER.id,
      model: "claude-opus-5-5",
    });
    // The timestamp is the start of the run, not the first line.
    const started = events[0] as Extract<
      ExternalAgentEvent,
      { type: "started" }
    >;
    expect(started.timestamp).toBeGreaterThanOrEqual(before);
    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
  });

  test("a single-model result names completed.model", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([INIT, result({ "claude-sonnet-5-5": USAGE })]),
      }),
    );
    expect(completedOf(events)?.model).toBe("claude-sonnet-5-5");
  });

  test("a multi-model result leaves completed.model to the init model", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([
          INIT,
          result({ "claude-opus-5-5": USAGE, "claude-haiku-5-5": USAGE }),
        ]),
      }),
    );
    expect(completedOf(events)?.model).toBe("claude-opus-5-5");
  });

  test("the first init line wins over a later one", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([
          INIT,
          { ...INIT, model: "claude-haiku-5-5" },
          result({ "claude-opus-5-5": USAGE, "claude-haiku-5-5": USAGE }),
        ]),
      }),
    );
    expect(events[0]).toMatchObject({
      type: "started",
      model: "claude-opus-5-5",
    });
    expect(completedOf(events)?.model).toBe("claude-opus-5-5");
  });

  test("without an init model, started has no model", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([{ type: "system", subtype: "init" }, result({})]),
      }),
    );
    expect(events[0]).toEqual({
      type: "started",
      providerId: CLAUDE_PROVIDER.id,
      timestamp: expect.any(Number),
    });
  });
});

describe("ClaudeCliDriver started is first on every path without output", () => {
  test("a pre-spawn refusal", async () => {
    const events = await collect(
      new ClaudeCliDriver({ env: {}, spawn: spawnLines([]) }),
      request({
        permissions: { mode: "ask", allowedPaths: ["/tmp/project"] },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[0]).not.toHaveProperty("model");
  });

  test("a missing binary at spawn", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: () => {
          throw Object.assign(new Error("spawn claude ENOENT"), {
            code: "ENOENT",
          });
        },
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
  });

  test("an abort before the run starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      new ClaudeCliDriver({ env: {}, spawn: spawnLines([INIT]) }),
      request({ abortSignal: controller.signal }),
    );
    expect(events.map((event) => event.type)).toEqual(["started"]);
  });

  test("an abort before any output", async () => {
    const controller = new AbortController();
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: () => ({
          stdout: (async function* () {
            controller.abort();
            yield `${JSON.stringify(INIT)}\n`;
          })(),
          stderr: [],
          exited: Promise.resolve(143),
        }),
      }),
      request({ abortSignal: controller.signal }),
    );
    expect(events.map((event) => event.type)).toEqual(["started"]);
  });

  test("a process that writes only to stderr and exits", async () => {
    const events = await collect(
      new ClaudeCliDriver({
        env: {},
        spawn: spawnLines([], { exitCode: 1, stderr: ["boom"] }),
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[0]).not.toHaveProperty("model");
  });

  test("a spawn error that is rethrown still follows started", async () => {
    const events: ExternalAgentEvent[] = [];
    const driver = new ClaudeCliDriver({
      env: {},
      spawn: () => {
        throw new Error("unexpected");
      },
    });
    await expect(
      (async () => {
        for await (const event of driver.run(request())) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow("unexpected");
    expect(events.map((event) => event.type)).toEqual(["started"]);
  });
});
