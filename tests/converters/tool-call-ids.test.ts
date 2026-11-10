import { describe, expect, it } from "bun:test";
import {
  generateToolCallId,
  isPortableToolCallId,
  ToolCallIdCorrelator,
} from "../../src/converters/tool-call-ids.js";

const track = (
  ids: ToolCallIdCorrelator,
  id: string | undefined,
  name: string,
): string => {
  const resolved = ids.callId(id);
  ids.track({ id: resolved, name, generated: !id });
  return resolved;
};

describe("generateToolCallId / isPortableToolCallId", () => {
  it("generates unique portable IDs", () => {
    const a = generateToolCallId();
    expect(a).toMatch(/^call_[0-9a-f]{32}$/);
    expect(a).not.toBe(generateToolCallId());
    expect(isPortableToolCallId(a)).toBe(true);
  });

  it("rejects empty, long and non-portable IDs", () => {
    expect(isPortableToolCallId("")).toBe(false);
    expect(isPortableToolCallId("a".repeat(65))).toBe(false);
    expect(isPortableToolCallId("a b")).toBe(false);
    expect(isPortableToolCallId("fc.1:x")).toBe(false);
    expect(isPortableToolCallId("toolu_01-A")).toBe(true);
  });
});

describe("ToolCallIdCorrelator", () => {
  it("keeps explicit IDs untouched by default and treats '' as missing", () => {
    const ids = new ToolCallIdCorrelator();
    expect(ids.callId("fc.1:x")).toBe("fc.1:x");
    expect(ids.callId("")).toMatch(/^call_/);
    expect(ids.callId(undefined)).toMatch(/^call_/);
  });

  it("an explicit response ID wins and leaves other pending calls", () => {
    const ids = new ToolCallIdCorrelator();
    track(ids, "a", "f");
    track(ids, "b", "f");
    expect(ids.response("b", "f")).toBe("b");
    expect(ids.response(undefined, "f")).toBe("a");
  });

  it("pairs a missing response ID with the generated same-name call", () => {
    const ids = new ToolCallIdCorrelator();
    track(ids, "explicit", "f");
    const generated = track(ids, undefined, "f");
    expect(ids.response(undefined, "f")).toBe(generated);
    expect(ids.response(undefined, "f")).toBe("explicit");
  });

  it("an unmatched name gets a fresh ID and keeps pending calls", () => {
    const ids = new ToolCallIdCorrelator();
    const call = track(ids, undefined, "f");
    const orphan = ids.response(undefined, "other");
    expect(orphan).not.toBe(call);
    expect(ids.response(undefined, "f")).toBe(call);
  });

  it("without a name takes the first generated, else the first pending", () => {
    const ids = new ToolCallIdCorrelator();
    track(ids, "e1", "f");
    const g = track(ids, undefined, "g");
    expect(ids.response(undefined, undefined)).toBe(g);
    expect(ids.response(undefined, undefined)).toBe("e1");
    expect(ids.response(undefined, undefined)).toMatch(/^call_/);
  });

  it("one-to-one: a call and its missing-ID response share the ID", () => {
    const ids = new ToolCallIdCorrelator();
    const call = track(ids, undefined, "lookup");
    expect(ids.response(undefined, "lookup")).toBe(call);
  });

  describe("sanitize", () => {
    it("rewrites non-portable explicit IDs, stable for call and response", () => {
      const ids = new ToolCallIdCorrelator({ sanitize: true });
      const call = track(ids, "fc.1:x", "f");
      expect(call).toMatch(/^call_[0-9a-f]{32}$/);
      expect(ids.callId("fc.1:x")).toBe(call);
      expect(ids.response("fc.1:x", "f")).toBe(call);
    });

    it("leaves portable IDs and generates for missing ones", () => {
      const ids = new ToolCallIdCorrelator({ sanitize: true });
      expect(ids.callId("toolu_01ABC")).toBe("toolu_01ABC");
      expect(ids.callId("")).toMatch(/^call_/);
    });

    it("maps different invalid IDs to different replacements", () => {
      const ids = new ToolCallIdCorrelator({ sanitize: true });
      expect(ids.callId("a b")).not.toBe(ids.callId("a.b"));
    });
  });
});
