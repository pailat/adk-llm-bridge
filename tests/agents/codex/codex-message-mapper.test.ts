import { describe, expect, test } from "bun:test";
import {
  codexThreadStartedId,
  normalizeCodexJsonlEvent,
  normalizeCodexSdkEvent,
} from "../../../src/agents/driver/codex-message-mapper.js";

const QUOTA = "You've hit your usage limit. Try again later.";

describe("Codex message mapper: stream shapes", () => {
  test("a stream error and an item error classify the same in both profiles", () => {
    const sdkStream = normalizeCodexSdkEvent({ type: "error", message: QUOTA });
    const sdkItem = normalizeCodexSdkEvent({
      type: "item.completed",
      item: { type: "error", message: QUOTA },
    });
    const jsonlStream = normalizeCodexJsonlEvent({
      type: "error",
      message: QUOTA,
    });
    const jsonlItem = normalizeCodexJsonlEvent({
      type: "item.completed",
      item: { type: "error", message: QUOTA },
    });

    for (const event of [sdkStream[0], sdkItem[0], jsonlStream, jsonlItem]) {
      expect(event).toMatchObject({
        type: "error",
        message: QUOTA,
        code: "QUOTA_EXHAUSTED",
        recoverable: false,
      });
    }
  });

  test("a rate limit stays recoverable in both profiles", () => {
    const message = "Rate limit reached, retry in 20s";
    const sdk = normalizeCodexSdkEvent({ type: "error", message })[0];
    const jsonl = normalizeCodexJsonlEvent({ type: "error", message });

    expect(sdk).toMatchObject({ recoverable: true });
    expect(jsonl).toMatchObject({ recoverable: true });
    expect((sdk as { code?: string }).code).toBe(
      (jsonl as { code?: string }).code,
    );
  });

  test("turn.completed carries the usage the shared helper computes, with no invented cost", () => {
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 7,
    };
    const sdk = normalizeCodexSdkEvent({ type: "turn.completed", usage })[0];
    const jsonl = normalizeCodexJsonlEvent({ type: "turn.completed", usage });

    for (const event of [sdk, jsonl]) {
      expect(event).toMatchObject({ type: "completed" });
      const reported = (event as { usage?: Record<string, unknown> }).usage;
      expect(reported).toBeDefined();
      expect(reported).not.toHaveProperty("costUsd");
      expect(reported).not.toHaveProperty("cost");
    }
    expect((sdk as { usage?: unknown }).usage).toEqual(
      (jsonl as { usage?: unknown }).usage,
    );
  });

  test("usage fields Codex did not send stay absent", () => {
    const event = normalizeCodexSdkEvent({
      type: "turn.completed",
      usage: { input_tokens: 5 },
    })[0] as { usage?: Record<string, unknown> };

    expect(event.usage).toBeDefined();
    expect(Object.keys(event.usage ?? {})).not.toContain("cacheReadTokens");
    expect(Object.values(event.usage ?? {})).not.toContain(undefined);
  });

  test("turn.failed becomes an error then a completed(1) in the SDK profile only", () => {
    const failed = { type: "turn.failed", error: { message: "boom" } };

    expect(normalizeCodexSdkEvent(failed).map((e) => e.type)).toEqual([
      "error",
      "completed",
    ]);
    expect(normalizeCodexJsonlEvent(failed)).toMatchObject({
      type: "error",
      message: "boom",
    });
  });
});

describe("Codex message mapper: items", () => {
  test("a command item yields a call and a result in the SDK profile", () => {
    const events = normalizeCodexSdkEvent({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        status: "completed",
        exit_code: 0,
        aggregated_output: "a\n",
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_result",
    ]);
  });

  test("an MCP item opens a call on start and closes it on completion in the JSONL profile", () => {
    const item = {
      id: "m1",
      type: "mcp_tool_call",
      tool: "workflow_get",
      arguments: {},
    };

    expect(
      normalizeCodexJsonlEvent({ type: "item.started", item }),
    ).toMatchObject({ type: "tool_call", name: "workflow_get", callId: "m1" });
    expect(
      normalizeCodexJsonlEvent({ type: "item.updated", item }),
    ).toBeUndefined();
    expect(
      normalizeCodexJsonlEvent({
        type: "item.completed",
        item: { ...item, result: { ok: true } },
      }),
    ).toMatchObject({ type: "tool_result", callId: "m1" });
  });

  test("older text shapes still map in the JSONL profile", () => {
    expect(
      normalizeCodexJsonlEvent({
        type: "response.output_text.delta",
        delta: "hi",
      }),
    ).toMatchObject({ type: "output", content: "hi" });
    expect(normalizeCodexJsonlEvent({ type: "turn.started" })).toBeUndefined();
  });

  test("a bridge-shaped line passes through, a malformed one is dropped", () => {
    expect(
      normalizeCodexJsonlEvent({
        type: "output",
        content: "x",
        stream: "stdout",
      }),
    ).toMatchObject({ type: "output", content: "x" });
    expect(normalizeCodexJsonlEvent({ type: "output" })).toBeUndefined();
  });
});

describe("Codex message mapper: thread id", () => {
  test("reads thread_id or thread.id", () => {
    expect(
      codexThreadStartedId({ type: "thread.started", thread_id: "a" }),
    ).toBe("a");
    expect(
      codexThreadStartedId({ type: "thread.started", thread: { id: "b" } }),
    ).toBe("b");
    expect(codexThreadStartedId({ type: "thread.started" })).toBeUndefined();
  });
});
