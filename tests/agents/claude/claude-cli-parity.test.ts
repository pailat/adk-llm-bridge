import { describe, expect, test } from "bun:test";
import {
  ClaudeCliDriver,
  type ClaudeCliDriverConfig,
  type ClaudeCliSpawn,
} from "../../../src/agents/driver/claude-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/provider/schema.js";

function spawnLines(lines: readonly unknown[], exitCode = 0): ClaudeCliSpawn {
  return () => ({
    stdout: lines.map((line) => `${JSON.stringify(line)}\n`),
    stderr: [],
    exited: Promise.resolve(exitCode),
  });
}

async function runLines(
  lines: readonly unknown[],
  exitCode = 0,
  config: ClaudeCliDriverConfig = {},
): Promise<ExternalAgentEvent[]> {
  const driver = new ClaudeCliDriver({
    ...config,
    spawn: spawnLines(lines, exitCode),
    env: {},
  });
  const events: ExternalAgentEvent[] = [];
  for await (const event of driver.run({
    provider: CLAUDE_PROVIDER,
    context: { input: "hi" } as never,
    permissions: { mode: "ask", allowNetwork: true },
  })) {
    events.push(event);
  }
  return events;
}

const request = {
  provider: CLAUDE_PROVIDER,
  context: { input: "hi" } as never,
  permissions: { mode: "ask" as const, allowNetwork: true },
};

describe("ClaudeCliDriver model, maxTurns and systemPrompt", () => {
  test("pass the CLI flags before the user's own args", () => {
    const args = new ClaudeCliDriver({
      model: "haiku",
      maxTurns: 3,
      systemPrompt: "-You review code.",
      args: ["--verbose"],
    }).buildArgs(request);
    const at = (flag: string) => args.indexOf(flag);
    expect(args).toContain("--model=haiku");
    expect(args).toContain("--max-turns=3");
    // Joined to its flag, so a value that starts with `-` stays a value.
    expect(args).toContain("--system-prompt=-You review code.");
    expect(at("--model=haiku")).toBeLessThan(args.lastIndexOf("--verbose"));
    expect(args.at(-1)).toBe("--verbose");
    expect(args).not.toContain("hi");
  });

  test("are left out when unset", () => {
    const args = new ClaudeCliDriver().buildArgs(request);
    expect(
      args.filter((arg) => /^--(model|max-turns|system-prompt)(=|$)/.test(arg)),
    ).toEqual([]);
  });

  test("model is the driver's request model", () => {
    expect(new ClaudeCliDriver({ model: "haiku" }).model).toBe("haiku");
    expect(new ClaudeCliDriver().model).toBeUndefined();
  });

  test.each([0, -1, 1.5, Number.NaN])("maxTurns %p is rejected", (maxTurns) => {
    expect(() => new ClaudeCliDriver({ maxTurns })).toThrow("maxTurns");
  });

  test.each(["", "  "])("a blank model %p is rejected", (model) => {
    expect(() => new ClaudeCliDriver({ model })).toThrow("model");
  });
});

describe("ClaudeCliDriver result errors", () => {
  test("a max-turns stop is MAX_TURNS_EXCEEDED, not CLAUDE_CLI_EXIT", async () => {
    const events = await runLines(
      [
        { type: "system", subtype: "init" },
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 3,
        },
      ],
      1,
    );
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "MAX_TURNS_EXCEEDED",
      recoverable: false,
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      exitCode: 1,
      numTurns: 3,
    });
  });

  test("the result's error messages are kept", async () => {
    const events = await runLines(
      [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["tool crashed"],
        },
      ],
      1,
    );
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "tool crashed" });
  });

  test("an assistant error is classified and keeps its text", async () => {
    const events = await runLines(
      [
        {
          type: "assistant",
          error: "model_not_found",
          message: {
            content: [
              { type: "text", text: "There's an issue with the model." },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "There's an issue with the model.",
        },
      ],
      1,
    );
    expect(events.filter((event) => event.type === "output")).toEqual([]);
    const errors = events.filter((event) => event.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: "model_not_found: There's an issue with the model.",
      code: "INVALID_REQUEST",
      recoverable: false,
    });
  });

  test("a non-zero exit without a result error is still CLAUDE_CLI_EXIT", async () => {
    const events = await runLines([{ type: "system", subtype: "init" }], 2);
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ code: "CLAUDE_CLI_EXIT" }),
    ]);
  });
});

describe("ClaudeCliDriver tool events", () => {
  test("tool_use and tool_result blocks become paired tool events", async () => {
    const events = await runLines([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "a.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "file text",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done." }] },
      },
      { type: "result", subtype: "success", result: "Done." },
    ]);
    expect(
      events
        .filter(
          (event) => event.type !== "started" && event.type !== "completed",
        )
        .map((event) => {
          if (event.type === "output") return ["output", event.content];
          if (event.type === "tool_call")
            return ["tool_call", event.name, event.callId, event.input];
          if (event.type === "tool_result")
            return ["tool_result", event.name, event.callId, event.result];
          return [event.type];
        }),
    ).toEqual([
      ["output", "Reading."],
      ["tool_call", "Read", "toolu_1", { file_path: "a.ts" }],
      ["tool_result", "Read", "toolu_1", "file text"],
      ["output", "Done."],
    ]);
  });

  test("a failed tool result carries its error", async () => {
    const events = await runLines([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "denied",
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: "ok" },
    ]);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({
      name: "Bash",
      callId: "t1",
      error: "denied",
    });
  });
});
