import { describe, expect, it } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { applyAnthropicPromptCaching } from "../../../../src/providers/anthropic/converters/request.js";

const EPH = { type: "ephemeral" } as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const tool = (name: string): Anthropic.Tool => ({
  name,
  description: `${name} tool`,
  input_schema: { type: "object", properties: {} },
});

function countMarkers(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((n: number, v) => n + countMarkers(v), 0);
  }
  if (value && typeof value === "object") {
    return Object.entries(value).reduce(
      (n, [k, v]) => n + (k === "cache_control" ? 1 : countMarkers(v)),
      0,
    );
  }
  return 0;
}

describe("applyAnthropicPromptCaching: conversation breakpoint", () => {
  it("marks the last block of the last message (3 markers with system + tools)", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "mid" }] },
      { role: "user", content: [{ type: "text", text: "last" }] },
    ];
    const r = applyAnthropicPromptCaching("sys", [tool("a")], messages);
    expect(countMarkers(r)).toBe(3);
    expect(r.messages?.[2].content).toEqual([
      { type: "text", text: "last", cache_control: EPH },
    ]);
    // Earlier messages are untouched (mutant b: first message marked).
    expect(r.messages?.[0].content).toBe("first");
    expect(r.messages?.[1].content).toEqual([{ type: "text", text: "mid" }]);
  });

  it("has 2 markers without tools and 2 without system", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "hello" },
    ];
    expect(
      countMarkers(applyAnthropicPromptCaching("sys", undefined, messages)),
    ).toBe(2);
    expect(
      countMarkers(
        applyAnthropicPromptCaching(undefined, [tool("a")], messages),
      ),
    ).toBe(2);
    expect(
      countMarkers(applyAnthropicPromptCaching(undefined, undefined, messages)),
    ).toBe(1);
  });

  it("widens a string last message into a one-block array", () => {
    const r = applyAnthropicPromptCaching(undefined, undefined, [
      { role: "user", content: "hi" },
    ]);
    expect(r.messages?.[0].content).toEqual([
      { type: "text", text: "hi", cache_control: EPH },
    ]);
  });

  it("marks the last tool_result of a multi-block message", () => {
    const r = applyAnthropicPromptCaching(undefined, undefined, [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "one" },
          { type: "tool_result", tool_use_id: "t2", content: "two" },
        ],
      },
    ]);
    const blocks = r.messages?.[0].content as Array<{
      cache_control?: unknown;
    }>;
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual(EPH);
  });

  it("never marks thinking or redacted_thinking: walks back to the previous eligible block", () => {
    const r = applyAnthropicPromptCaching(undefined, undefined, [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "hm", signature: "sig" },
          { type: "redacted_thinking", data: "x" },
        ],
      },
    ]);
    const blocks = r.messages?.[0].content as Array<{
      type: string;
      cache_control?: unknown;
    }>;
    expect(blocks[0].cache_control).toEqual(EPH);
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it("skips an empty trailing text block", () => {
    const r = applyAnthropicPromptCaching(undefined, undefined, [
      {
        role: "user",
        content: [
          { type: "text", text: "real" },
          { type: "text", text: "" },
        ],
      },
    ]);
    const blocks = r.messages?.[0].content as Array<{
      cache_control?: unknown;
    }>;
    expect(blocks[0].cache_control).toEqual(EPH);
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("adds no conversation marker when no block is eligible", () => {
    const r = applyAnthropicPromptCaching(undefined, undefined, [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hm", signature: "s" }],
      },
    ]);
    expect(countMarkers(r)).toBe(0);
  });

  it("accepts image, document and tool_use blocks as eligible", () => {
    for (const block of [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AA" },
      },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "AA" },
      },
      { type: "tool_use", id: "t", name: "n", input: {} },
    ] as unknown as Anthropic.ContentBlockParam[]) {
      const r = applyAnthropicPromptCaching(undefined, undefined, [
        { role: "user", content: [block] },
      ]);
      expect(countMarkers(r)).toBe(1);
    }
  });

  it("puts the ttl on every marker when given", () => {
    const r = applyAnthropicPromptCaching(
      "sys",
      [tool("a")],
      [{ role: "user", content: "hi" }],
      "1h",
    );
    const ttl = { type: "ephemeral", ttl: "1h" } as const;
    const tools = (r.tools ?? []) as Array<{ cache_control?: unknown }>;
    const blocks = (r.messages?.[0]?.content ?? []) as Array<{
      cache_control?: unknown;
    }>;
    expect(r.system?.[0]?.cache_control).toEqual(ttl);
    expect(tools[0]?.cache_control).toEqual(ttl);
    expect(blocks[0]?.cache_control).toEqual(ttl);
  });

  it("omits ttl for 5m (the API default)", () => {
    const r = applyAnthropicPromptCaching("sys", undefined, undefined, "5m");
    expect(r.system?.[0].cache_control).toEqual(EPH);
  });

  it("does not mutate deep-frozen inputs", () => {
    const messages = deepFreeze<Anthropic.MessageParam[]>([
      { role: "user", content: "a" },
      { role: "user", content: [{ type: "text", text: "b" }] },
    ]);
    const tools = deepFreeze([tool("a")]);
    expect(() =>
      applyAnthropicPromptCaching("sys", tools, messages),
    ).not.toThrow();
  });

  it("never exceeds the 4 breakpoint limit", () => {
    const r = applyAnthropicPromptCaching(
      "sys",
      [tool("a"), tool("b")],
      [
        { role: "user", content: [{ type: "text", text: "x" }] },
        { role: "user", content: [{ type: "text", text: "y" }] },
      ],
    );
    expect(countMarkers(r)).toBeLessThanOrEqual(3);
  });
});
