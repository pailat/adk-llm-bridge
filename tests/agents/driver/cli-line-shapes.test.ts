/**
 * How the CLI drivers read unusual stdout lines: error lines with a `null`
 * or non-string detail, legacy bridge-like shapes, terminal lines from the
 * child, and how a failed exit and long stderr lines are reported.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import {
  collectTail,
  readLines,
  STDERR_LINE_CHARS,
} from "../../../src/agents/driver/lines.js";
import {
  bridgeEvent,
  exitErrorEvent,
} from "../../../src/agents/driver/shared.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from "../../../src/agents/index.js";
import { noHostMcpServers } from "../helpers.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

const jsonl = (values: unknown[]) =>
  values.map((value) => `${JSON.stringify(value)}\n`);

function claudeRun(lines: unknown[], exitCode = 0, stderr: string[] = []) {
  const driver = new ClaudeCliDriver({
    spawn: () => ({
      stdout: jsonl(lines),
      stderr: stderr.map((line) => `${line}\n`),
      exited: Promise.resolve(exitCode),
    }),
    env: {},
  });
  return collect(
    driver.run({ provider: CLAUDE_PROVIDER, context: {} as never }),
  );
}

function codexRun(lines: unknown[], exitCode = 0) {
  const driver = new CodexCliDriver({
    listMcpServers: noHostMcpServers,
    spawn: () => ({ stdout: jsonl(lines), exited: Promise.resolve(exitCode) }),
  });
  return collect(
    driver.run({
      provider: CODEX_PROVIDER,
      context: { input: "hi" } as never,
      workingDirectory: "/repo",
    }),
  );
}

const completedEvents = (events: ExternalAgentEvent[]) =>
  events.filter((event) => event.type === "completed");

describe("error lines with a null or malformed detail", () => {
  const line = { type: "error", message: 5, error: null };

  test("Claude reports a generic error instead of throwing", () => {
    expect(new ClaudeCliDriver().parseClaudeLine(JSON.stringify(line))).toEqual(
      {
        type: "error",
        message: "Claude CLI error",
        code: undefined,
        recoverable: true,
        timestamp: expect.any(Number),
      },
    );
  });

  test("an object detail gives its string message and code", () => {
    const detailed = {
      type: "error",
      error: { message: "boom", code: "E1" },
    };
    expect(
      new ClaudeCliDriver().parseClaudeLine(JSON.stringify(detailed)),
    ).toMatchObject({ message: "boom", code: "E1" });
  });
});

describe("legacy line shapes that look like bridge events", () => {
  test("bridgeEvent leaves a malformed output, tool_call or tool_result to the driver", () => {
    expect(bridgeEvent({ type: "output", text: "x" })).toBeUndefined();
    expect(
      bridgeEvent({ type: "tool_call", tool_name: "Read" }),
    ).toBeUndefined();
    expect(bridgeEvent({ type: "tool_result", result: 1 })).toBeUndefined();
    expect(bridgeEvent({ type: "output", text: "x" }, "drop")).toBe("drop");
    expect(bridgeEvent({ type: "completed" })).toBe("drop");
  });

  test("Claude reads a legacy output and tool_call", () => {
    const driver = new ClaudeCliDriver();
    expect(
      driver.parseClaudeLine(
        JSON.stringify({ type: "output", text: "legacy text" }),
      ),
    ).toMatchObject({ type: "output", content: "legacy text" });
    expect(
      driver.parseClaudeLine(
        JSON.stringify({
          type: "tool_call",
          tool_name: "Read",
          tool_input: { path: "a.ts" },
        }),
      ),
    ).toMatchObject({
      type: "tool_call",
      name: "Read",
      input: { path: "a.ts" },
    });
  });

  test("Codex drops them", async () => {
    const events = await codexRun([
      { type: "output", text: "legacy text" },
      { type: "tool_call", tool_name: "Read" },
    ]);
    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
  });
});

describe("terminal lines from the child", () => {
  test("Claude sends one completed, after the exit, even when a complete line came first", async () => {
    const events = await claudeRun([
      { type: "complete", exitCode: "0", signal: 9 },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "output",
      "completed",
    ]);
    expect(completedEvents(events)).toEqual([
      { type: "completed", exitCode: 0, timestamp: expect.any(Number) },
    ]);
  });

  test("Claude reports a failed exit after a result line", async () => {
    const events = await claudeRun(
      [{ type: "result", subtype: "success", num_turns: 1 }],
      2,
      ["Error: crashed"],
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({ code: "CLAUDE_CLI_EXIT" });
    expect(completedEvents(events)[0]).toMatchObject({
      exitCode: 2,
      numTurns: 1,
    });
  });

  test("Codex reports the failed exit after turn.completed", async () => {
    const events = await codexRun(
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      ],
      1,
    );
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "error",
      "completed",
    ]);
    expect(events[1]).toMatchObject({ code: "CODEX_CLI_EXIT" });
    expect(events[2]).toMatchObject({
      exitCode: 1,
      usage: { inputTokens: 3, outputTokens: 1 },
    });
  });
});

describe("exitErrorEvent", () => {
  test("classifies the last stderr line, not an earlier warning", () => {
    const event = exitErrorEvent({
      runtime: "Claude CLI",
      exitCode: 1,
      stderr: [
        "Warning: no such file ~/.claude/settings.json, using defaults",
        "",
        "Error: 503 Service Unavailable",
      ],
      code: "CLAUDE_CLI_EXIT",
    });
    expect(event.recoverable).toBe(true);
    expect(event.message).toBe(
      "Warning: no such file ~/.claude/settings.json, using defaults\nError: 503 Service Unavailable",
    );
  });

  test("a final auth failure is not recoverable", () => {
    const event = exitErrorEvent({
      runtime: "Claude CLI",
      exitCode: 1,
      stderr: ["starting", "Error: invalid API key"],
      code: "CLAUDE_CLI_EXIT",
    });
    expect(event.recoverable).toBe(false);
  });

  test("keeps the end of a long tail, cut to 4096 characters", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line ${i} ${"x".repeat(60)}`,
    );
    const event = exitErrorEvent({
      runtime: "Codex CLI",
      exitCode: 1,
      stderr: lines,
      code: "CODEX_CLI_EXIT",
    });
    expect(event.message.length).toBe(4096);
    expect(event.message.startsWith("...")).toBe(true);
    expect(event.message.endsWith(lines.at(-1) as string)).toBe(true);
  });

  test("an empty tail names the runtime and exit code", () => {
    expect(
      exitErrorEvent({
        runtime: "Codex CLI",
        exitCode: 3,
        stderr: ["  "],
        code: "CODEX_CLI_EXIT",
      }).message,
    ).toBe("Codex CLI exited with code 3");
  });
});

describe("long lines without a newline", () => {
  test("readLines keeps the start of an overlong line and skips the rest", async () => {
    const chunk = "a".repeat(STDERR_LINE_CHARS);
    async function* source() {
      for (let i = 0; i < 50; i++) yield chunk;
      yield "b\nnext\n";
    }
    const lines = await collect(
      readLines(source(), { maxLineChars: STDERR_LINE_CHARS }),
    );
    expect(lines).toEqual([`${chunk}...`, "next"]);
  });

  test("collectTail cuts an overlong stderr line", async () => {
    const target: string[] = [];
    async function* source() {
      for (let i = 0; i < 50; i++) yield "z".repeat(1000);
      yield "\nError: last\n";
    }
    await collectTail(source(), target);
    expect(target).toEqual([
      `${"z".repeat(STDERR_LINE_CHARS)}...`,
      "Error: last",
    ]);
  });

  test("readLines without a cap keeps long lines whole", async () => {
    const long = "c".repeat(STDERR_LINE_CHARS * 2);
    expect(await collect(readLines([`${long}\n`]))).toEqual([long]);
  });
});
