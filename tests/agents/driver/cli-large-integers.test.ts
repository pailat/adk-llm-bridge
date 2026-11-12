/**
 * The CLI drivers keep integers beyond `Number.MAX_SAFE_INTEGER` exact when
 * they read stdout lines: tool-call inputs and results carry IDs that
 * `JSON.parse` alone would round.
 */

import { describe, expect, test } from "bun:test";
import { ClaudeCliDriver } from "../../../src/agents/driver/claude-cli.js";
import { CodexCliDriver } from "../../../src/agents/driver/codex-cli.js";
import { SubprocessJsonlDriver } from "../../../src/agents/driver/subprocess-jsonl.js";
import type { ExternalAgentEvent } from "../../../src/agents/events.js";
import { CLAUDE_PROVIDER } from "../../../src/agents/index.js";

/** 19 digits: `JSON.parse` turns it into 1234567890123456800. */
const BIG = "1234567890123456789";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("CLI drivers keep large integers exact", () => {
  test("Claude parseClaudeLine keeps a tool input ID", () => {
    const event = new ClaudeCliDriver().parseClaudeLine(
      `{"type":"tool_call","tool_name":"Read","tool_input":{"ticketId":${BIG}}}`,
    );
    expect(event).toMatchObject({
      type: "tool_call",
      input: { ticketId: BIG },
    });
  });

  test("Claude parseClaudeLine still throws SyntaxError for a non-JSON line", () => {
    expect(() => new ClaudeCliDriver().parseClaudeLine("not json")).toThrow(
      SyntaxError,
    );
  });

  test("Claude run keeps a tool_use input ID from stream-json", async () => {
    const driver = new ClaudeCliDriver({
      spawn: () => ({
        stdout: [
          `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"ticketId":${BIG}}}]}}\n`,
          `{"type":"result","subtype":"success","result":"Done."}\n`,
        ],
        stderr: [],
        exited: Promise.resolve(0),
      }),
      env: {},
    });
    const events: ExternalAgentEvent[] = await collect(
      driver.run({ provider: CLAUDE_PROVIDER, context: {} as never }),
    );
    const call = events.find((event) => event.type === "tool_call");
    expect(call).toMatchObject({ input: { ticketId: BIG } });
  });

  test("Codex keeps an MCP tool argument and result ID", () => {
    const driver = new CodexCliDriver();
    expect(
      driver.parseEvent(
        `{"type":"item.started","item":{"id":"c1","type":"mcp_tool_call","tool":"get","arguments":{"ticketId":${BIG}}}}`,
      ),
    ).toMatchObject({ type: "tool_call", input: { ticketId: BIG } });
    const lines = new CodexCliDriver();
    const completed = lines.parseEvent(
      `{"type":"item.completed","item":{"id":"c1","type":"mcp_tool_call","tool":"get","arguments":{},"result":{"ticketId":${BIG}}}}`,
    );
    expect(JSON.stringify(completed)).toContain(`"${BIG}"`);
  });

  test("SubprocessJsonlDriver parseLine keeps a tool input ID", () => {
    const driver = new SubprocessJsonlDriver({ providerId: "x", command: "x" });
    expect(
      driver.parseLine(
        `{"type":"tool_call","name":"get","input":{"ticketId":${BIG}}}`,
      ),
    ).toMatchObject({ type: "tool_call", input: { ticketId: BIG } });
    expect(() => driver.parseLine("not json")).toThrow(SyntaxError);
  });
});
