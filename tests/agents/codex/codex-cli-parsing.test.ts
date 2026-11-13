import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@google/adk";
import {
  CodexCliDriver,
  type CodexCliSpawn,
} from "../../../src/agents/driver/codex-cli.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CODEX_PROVIDER } from "../../../src/agents/provider/codex.js";
import { noHostMcpServers } from "../helpers.js";

function driverWithLines(lines: string[]) {
  const spawn: CodexCliSpawn = () => ({
    stdout: (async function* () {
      yield `${lines.join("\n")}\n`;
    })(),
    stderr: null,
    exited: Promise.resolve(0),
  });
  return new CodexCliDriver({ listMcpServers: noHostMcpServers, spawn });
}

async function run(lines: string[]): Promise<ExternalAgentEvent[]> {
  const events: ExternalAgentEvent[] = [];
  for await (const event of driverWithLines(lines).run({
    provider: CODEX_PROVIDER,
    context: { input: "hi" } as never,
    permissions: { mode: "read-only" },
  })) {
    events.push(event);
  }
  return events;
}

const warnSpy = spyOn(logger, "warn");
afterEach(() => warnSpy.mockClear());

describe("CodexCliDriver line handling", () => {
  test("an empty turn.failed gets a readable message", async () => {
    for (const line of [
      { type: "turn.failed" },
      { type: "turn.failed", error: {} },
    ]) {
      const events = await run([JSON.stringify(line)]);
      const error = events.find((event) => event.type === "error");
      expect(error).toMatchObject({
        message: "Codex reported turn.failed without an error message",
      });
      expect((error as { message: string }).message).not.toContain("{");
    }
  });

  test("a non-JSON stdout line is logged as a warning and skipped", async () => {
    const events = await run([
      "Codex v0.167.0 starting",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "answer" },
      }),
    ]);
    expect(events.find((event) => event.type === "output")).toMatchObject({
      content: "answer",
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", exitCode: 0 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Codex v0.167.0 starting");
    // The code is part of the one message string.
    expect(warnSpy.mock.calls[0]?.[0]).toContain("[CODEX_CLI_NON_JSON_LINE]");
    expect(warnSpy.mock.calls[0]).toHaveLength(1);
  });

  test("parseEvent returns undefined for a non-JSON line", () => {
    expect(new CodexCliDriver().parseEvent("not json")).toBeUndefined();
  });

  test("an explicit code that is a classifier subtype is classified", async () => {
    const events = await run([
      JSON.stringify({
        type: "error",
        message: "Plan cap",
        code: "quota_exhausted",
      }),
    ]);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: "QUOTA_EXHAUSTED",
      recoverable: false,
    });
  });

  test("Codex rate_limit and server_error codes get neutral codes", async () => {
    for (const [code, expected, recoverable] of [
      ["rate_limit", "RATE_LIMIT", true],
      ["server_error", "SERVER_ERROR", true],
      ["invalid_request", "INVALID_REQUEST", false],
    ] as const) {
      const events = await run([
        JSON.stringify({ type: "error", message: "failed", code }),
      ]);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code: expected,
        recoverable,
      });
    }
  });

  test("an explicit code that is not a subtype is kept", async () => {
    const events = await run([
      JSON.stringify({ type: "error", message: "boom", code: "MY_CODE" }),
    ]);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      code: "MY_CODE",
    });
  });
});
