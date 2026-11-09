import { describe, expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { CodexSdkDriver } from "../../../src/agents/driver/codex-sdk.js";
import {
  claudeInitModel,
  claudeResultBaseline,
  claudeResultSummary,
  codexTurnUsage,
} from "../../../src/agents/driver/run-summary.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
} from "../../../src/agents/provider/schema.js";
import { noHostMcpServers } from "../helpers.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("claudeResultSummary", () => {
  test("sums several models and keeps the per-model breakdown", () => {
    expect(
      claudeResultSummary({
        type: "result",
        total_cost_usd: 0.03,
        num_turns: 2,
        duration_ms: 10,
        modelUsage: {
          "claude-haiku-5-5": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 100,
            costUSD: 0.01,
          },
          "claude-sonnet-5-5": {
            inputTokens: 20,
            outputTokens: 7,
            cacheCreationInputTokens: 3,
            costUSD: 0.02,
          },
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 3,
        totalCostUsd: 0.03,
        scope: "run",
        byModel: {
          "claude-haiku-5-5": {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 100,
            totalCostUsd: 0.01,
          },
          "claude-sonnet-5-5": {
            inputTokens: 20,
            outputTokens: 7,
            cacheCreationInputTokens: 3,
            totalCostUsd: 0.02,
          },
        },
      },
      numTurns: 2,
      durationMs: 10,
    });
  });

  test("falls back to snake_case usage without modelUsage", () => {
    expect(
      claudeResultSummary({
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_input_tokens: 9,
        },
      }),
    ).toEqual({
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 9,
        scope: "run",
      },
    });
  });

  test("drops invalid numbers instead of sending zeros or NaN", () => {
    expect(
      claudeResultSummary({
        num_turns: "3",
        duration_ms: -1,
        total_cost_usd: Number.NaN,
        usage: {},
        modelUsage: { m: { contextWindow: 1 } },
      }),
    ).toEqual({});
  });

  test("claudeInitModel only reads system/init", () => {
    expect(
      claudeInitModel({ type: "system", subtype: "init", model: "m" }),
    ).toBe("m");
    expect(claudeInitModel({ type: "assistant", model: "m" })).toBeUndefined();
  });
});

describe("codexTurnUsage", () => {
  test("inputTokens excludes the cached tokens", () => {
    expect(
      codexTurnUsage({
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 50,
      }),
    ).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadInputTokens: 800,
    });
  });

  test("missing or empty usage is undefined", () => {
    expect(codexTurnUsage(undefined)).toBeUndefined();
    expect(codexTurnUsage({})).toBeUndefined();
  });
});

describe("Codex SDK driver", () => {
  test("model getter exposes the configured model", () => {
    expect(new CodexSdkDriver({ model: "gpt-5.5" }).model).toBe("gpt-5.5");
    expect(new CodexSdkDriver().model).toBeUndefined();
  });

  test("turn.completed carries usage", () => {
    expect(
      new CodexSdkDriver().normalizeEvent({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
      }),
    ).toEqual([
      {
        type: "completed",
        exitCode: 0,
        usage: { inputTokens: 6, outputTokens: 2, cacheReadInputTokens: 4 },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("file_change becomes a built-in tool_call/tool_result pair", () => {
    const changes = [{ path: "src/a.ts", kind: "update" }];
    expect(
      new CodexSdkDriver().normalizeEvent({
        type: "item.completed",
        item: { id: "fc-1", type: "file_change", changes, status: "failed" },
      }),
    ).toEqual([
      {
        type: "tool_call",
        name: "file_change",
        input: { changes },
        callId: "fc-1",
        metadata: {
          itemType: "file_change",
          builtin: true,
          status: "failed",
          title: "Codex: file_change call",
        },
        timestamp: expect.any(Number),
      },
      {
        type: "tool_result",
        name: "file_change",
        result: { changes, status: "failed" },
        callId: "fc-1",
        error: "Codex patch failed",
        metadata: {
          itemType: "file_change",
          builtin: true,
          status: "failed",
          title: "Codex: file_change failed",
        },
        timestamp: expect.any(Number),
      },
    ]);
  });

  test("a completed web_search becomes a built-in tool pair", () => {
    const events = new CodexSdkDriver().normalizeEvent({
      type: "item.completed",
      item: { id: "ws-1", type: "web_search", query: "adk" },
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_result",
    ]);
    expect(events[0]).toMatchObject({
      name: "web_search",
      input: { query: "adk" },
      callId: "ws-1",
      metadata: { builtin: true },
    });
  });

  test("command_execution result includes the aggregated output", () => {
    const events = new CodexSdkDriver().normalizeEvent({
      type: "item.completed",
      item: {
        id: "c-1",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a.ts\n",
        exit_code: 0,
        status: "completed",
      },
    });

    expect(events[1]).toMatchObject({
      type: "tool_result",
      result: { command: "ls", exitCode: 0, output: "a.ts\n" },
    });
  });
});

describe("Codex CLI driver", () => {
  test("turn.completed usage goes on the one completed event, sent after the exit", async () => {
    const driver = new CodexCliDriver({
      listMcpServers: noHostMcpServers,
      spawn: () => ({
        stdout: (async function* () {
          yield `${JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 5,
            },
          })}\n`;
        })(),
        exited: Promise.resolve(0),
      }),
    });
    const events = await collect(
      driver.run({
        provider: CODEX_PROVIDER,
        context: { input: "hi" } as never,
        workingDirectory: "/repo",
      }),
    );

    expect(events.filter((event) => event.type === "completed")).toEqual([
      {
        type: "completed",
        exitCode: 0,
        usage: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 20 },
        timestamp: expect.any(Number),
      },
    ]);
  });
});

describe("Claude CLI driver", () => {
  test("the result line's model and usage go on completed", async () => {
    const lines = [
      { type: "system", subtype: "init", model: "claude-haiku-5-5" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "PONG" }] },
      },
      {
        type: "result",
        subtype: "success",
        result: "PONG",
        num_turns: 1,
        duration_ms: 900,
        total_cost_usd: 0.001,
        modelUsage: {
          "claude-haiku-5-5": {
            inputTokens: 5,
            outputTokens: 2,
            costUSD: 0.001,
          },
        },
      },
    ];
    const driver = new ClaudeCliDriver({
      spawn: () => ({
        stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
        stderr: [],
        exited: Promise.resolve(0),
      }),
      env: {},
    });
    const events: ExternalAgentEvent[] = await collect(
      driver.run({
        provider: CLAUDE_PROVIDER,
        context: {} as never,
        instruction: "Reply PONG",
      }),
    );

    expect(events.at(-1)).toEqual({
      type: "completed",
      exitCode: 0,
      model: "claude-haiku-5-5",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        totalCostUsd: 0.001,
        scope: "run",
      },
      numTurns: 1,
      durationMs: 900,
      timestamp: expect.any(Number),
    });
  });

  test("a result line without text gives its summary to the one completed event", async () => {
    const driver = new ClaudeCliDriver({
      spawn: () => ({
        stdout: [
          `${JSON.stringify({ type: "result", subtype: "success", num_turns: 2 })}\n`,
        ],
        stderr: [],
        exited: Promise.resolve(0),
      }),
      env: {},
    });
    const events = await collect(
      driver.run({ provider: CLAUDE_PROVIDER, context: {} as never }),
    );

    expect(events.filter((event) => event.type === "completed")).toEqual([
      {
        type: "completed",
        exitCode: 0,
        numTurns: 2,
        timestamp: expect.any(Number),
      },
    ]);
  });
});

describe("Codex SDK progress itemId", () => {
  test("progress outputs carry itemId equal to the builtin callId", () => {
    const driver = new CodexSdkDriver();
    for (const item of [
      {
        id: "c-9",
        type: "command_execution",
        command: "ls",
        status: "in_progress",
      },
      { id: "m-9", type: "mcp_tool_call", tool: "t", status: "in_progress" },
      { id: "w-9", type: "web_search", query: "adk" },
    ]) {
      const [progress] = driver.normalizeEvent({ type: "item.started", item });
      const completed = driver.normalizeEvent({
        type: "item.completed",
        item: { ...item, status: "completed" },
      });
      expect(progress).toMatchObject({
        type: "output",
        metadata: { itemId: item.id },
      });
      expect(completed[0]).toMatchObject({
        type: "tool_call",
        callId: item.id,
      });
    }
  });

  test("a progress item without an id has no itemId", () => {
    const [progress] = new CodexSdkDriver().normalizeEvent({
      type: "item.started",
      item: { type: "web_search", query: "adk" },
    });
    expect(
      progress?.type === "output" && "itemId" in (progress.metadata ?? {}),
    ).toBe(false);
  });
});

describe("Codex CLI tool calls", () => {
  const run = async (lines: unknown[]) =>
    collect(
      new CodexCliDriver({
        listMcpServers: noHostMcpServers,
        spawn: () => ({
          stdout: (async function* () {
            for (const line of lines) yield `${JSON.stringify(line)}\n`;
          })(),
          exited: Promise.resolve(0),
        }),
      }).run({
        provider: CODEX_PROVIDER,
        context: { input: "hi" } as never,
        workingDirectory: "/repo",
      }),
    );

  test("item.updated does not emit a second tool_call for the same callId", async () => {
    const item = { id: "cmd-1", type: "command_execution", command: "ls" };
    const events = await run([
      { type: "item.started", item: { ...item, status: "in_progress" } },
      { type: "item.updated", item: { ...item, status: "in_progress" } },
      { type: "item.updated", item: { ...item, status: "in_progress" } },
      {
        type: "item.completed",
        item: { ...item, status: "completed", aggregated_output: "a.ts\n" },
      },
    ]);

    expect(
      events
        .filter(
          (event) => event.type === "tool_call" || event.type === "tool_result",
        )
        .map((event) => [
          event.type,
          "callId" in event ? event.callId : undefined,
        ]),
    ).toEqual([
      ["tool_call", "cmd-1"],
      ["tool_result", "cmd-1"],
    ]);
  });

  test("the command_execution tool_call carries the command", async () => {
    const events = await run([
      {
        type: "item.started",
        item: { id: "cmd-2", type: "command_execution", command: "git status" },
      },
    ]);

    expect(events.find((event) => event.type === "tool_call")).toEqual({
      type: "tool_call",
      name: "command_execution",
      input: { command: "git status" },
      callId: "cmd-2",
      metadata: { itemType: "command_execution", builtin: true },
      timestamp: undefined,
    });
  });

  test("an MCP tool_call still reads its arguments", async () => {
    const events = await run([
      {
        type: "item.started",
        item: {
          id: "m-2",
          type: "mcp_tool_call",
          tool: "lookup",
          arguments: { q: 1 },
        },
      },
    ]);

    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      name: "lookup",
      input: { q: 1 },
      callId: "m-2",
    });
  });
});

describe("claudeResultSummary with a previous result", () => {
  const usage = (cacheRead: number, cost: number) => ({
    total_cost_usd: cost,
    modelUsage: { m: { cacheReadInputTokens: cacheRead, costUSD: cost } },
  });

  test("subtracts the previous cumulative counters, scope run", () => {
    expect(claudeResultSummary(usage(6768, 0.75), usage(3366, 0.25))).toEqual({
      model: "m",
      usage: { cacheReadInputTokens: 3402, totalCostUsd: 0.5, scope: "run" },
    });
  });

  test("a counter that went down reports the session total, scope session", () => {
    expect(claudeResultSummary(usage(10, 0.5), usage(50, 0.25))).toEqual({
      model: "m",
      usage: { cacheReadInputTokens: 10, totalCostUsd: 0.5, scope: "session" },
    });
    expect(claudeResultSummary(usage(60, 0.125), usage(50, 0.25))).toEqual({
      model: "m",
      usage: {
        cacheReadInputTokens: 60,
        totalCostUsd: 0.125,
        scope: "session",
      },
    });
  });

  test("without previous, a resumed run is scope session and a fresh one scope run", () => {
    expect(claudeResultSummary(usage(10, 0.5), undefined, true)).toEqual({
      model: "m",
      usage: { cacheReadInputTokens: 10, totalCostUsd: 0.5, scope: "session" },
    });
    expect(claudeResultSummary(usage(10, 0.5))).toEqual({
      model: "m",
      usage: { cacheReadInputTokens: 10, totalCostUsd: 0.5, scope: "run" },
    });
  });
});

describe("claudeResultSummary previous edge cases", () => {
  test("a model new in this run counts from zero", () => {
    expect(
      claudeResultSummary(
        {
          modelUsage: {
            a: { outputTokens: 9, costUSD: 0.75 },
            b: { outputTokens: 7, costUSD: 0.5 },
          },
        },
        { modelUsage: { a: { outputTokens: 4, costUSD: 0.25 } } },
      ).usage,
    ).toEqual({
      outputTokens: 12,
      totalCostUsd: 1,
      scope: "run",
      byModel: {
        a: { outputTokens: 5, totalCostUsd: 0.5 },
        b: { outputTokens: 7, totalCostUsd: 0.5 },
      },
    });
  });

  test("a model of previous missing now means no usable baseline", () => {
    expect(
      claudeResultSummary(
        { modelUsage: { a: { outputTokens: 7, costUSD: 0.5 } } },
        { modelUsage: { b: { outputTokens: 99, costUSD: 0.25 } } },
      ).usage,
    ).toEqual({ outputTokens: 7, totalCostUsd: 0.5, scope: "session" });
  });

  test("a counter missing in previous means no usable baseline", () => {
    expect(
      claudeResultSummary(
        { modelUsage: { a: { outputTokens: 7, inputTokens: 3 } } },
        { modelUsage: { a: { outputTokens: 2 } } },
      ).usage,
    ).toEqual({ outputTokens: 7, inputTokens: 3, scope: "session" });
    expect(claudeResultSummary({ total_cost_usd: 0.5 }, {}).usage).toEqual({
      totalCostUsd: 0.5,
      scope: "session",
    });
  });

  test("only total_cost_usd present is subtracted", () => {
    expect(
      claudeResultSummary({ total_cost_usd: 0.5 }, { total_cost_usd: 0.25 })
        .usage,
    ).toEqual({ totalCostUsd: 0.25, scope: "run" });
  });

  test("claudeResultBaseline keeps only the counters", () => {
    expect(
      claudeResultBaseline({
        result: "long text",
        total_cost_usd: 1,
        modelUsage: { m: { inputTokens: 2, contextWindow: 9, costUSD: 1 } },
      }),
    ).toEqual({
      total_cost_usd: 1,
      modelUsage: { m: { inputTokens: 2, costUSD: 1 } },
    });
  });
});
