import { describe, expect, it } from "bun:test";
import {
  parseJsonObject,
  safeJsonParse,
  tryParseJson,
} from "../../src/utils/json.js";

describe("safeJsonParse", () => {
  it("parses normal JSON unchanged", () => {
    const result = safeJsonParse('{"name": "test", "count": 42}');
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("converts 19-digit integer to string (Zoho ticket ID)", () => {
    const zohoId = "1021987000032211189";
    const result = safeJsonParse(`{"ticketId": ${zohoId}}`);
    expect(result.ticketId).toBe(zohoId);
    expect(typeof result.ticketId).toBe("string");
  });

  it("converts 17-digit integer to string (boundary)", () => {
    const id = "12345678901234567";
    const result = safeJsonParse(`{"id": ${id}}`);
    expect(result.id).toBe(id);
    expect(typeof result.id).toBe("string");
  });

  it("preserves 16-digit integer as number (safe)", () => {
    const result = safeJsonParse('{"id": 1234567890123456}');
    expect(result.id).toBe(1234567890123456);
    expect(typeof result.id).toBe("number");
  });

  it("does NOT convert large decimals", () => {
    const result = safeJsonParse('{"val": 12345678901234567.89}');
    // Should parse without error (the decimal prevents the regex from matching)
    expect(typeof result.val).toBe("number");
  });

  it("converts negative large integer to string", () => {
    const result = safeJsonParse('{"id": -12345678901234567}');
    expect(result.id).toBe("-12345678901234567");
    expect(typeof result.id).toBe("string");
  });

  it("does NOT convert scientific notation", () => {
    const result = safeJsonParse('{"val": 1e20}');
    expect(typeof result.val).toBe("number");
  });

  it("does NOT modify numbers inside JSON strings", () => {
    const result = safeJsonParse('{"note": "ID is 1021987000032211189"}');
    expect(result.note).toBe("ID is 1021987000032211189");
  });

  it("converts multiple large integers in same object", () => {
    const result = safeJsonParse(
      '{"id1": 1021987000032211189, "id2": 9876543210987654321}',
    );
    expect(result.id1).toBe("1021987000032211189");
    expect(result.id2).toBe("9876543210987654321");
  });

  it("converts large integer as first element of array", () => {
    const result = safeJsonParse('{"ids": [1021987000032211189, 42]}');
    expect((result.ids as unknown[])[0]).toBe("1021987000032211189");
    expect((result.ids as unknown[])[1]).toBe(42);
  });

  it("converts large integer as last element of array", () => {
    const result = safeJsonParse('{"ids": [42, 1021987000032211189]}');
    expect((result.ids as unknown[])[0]).toBe(42);
    expect((result.ids as unknown[])[1]).toBe("1021987000032211189");
  });

  it("returns empty object for malformed JSON", () => {
    expect(safeJsonParse("{invalid}")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(safeJsonParse("")).toEqual({});
  });

  it("returns empty object for undefined input", () => {
    expect(safeJsonParse(undefined as unknown as string)).toEqual({});
  });

  it("returns empty object for null input", () => {
    expect(safeJsonParse(null as unknown as string)).toEqual({});
  });

  it("returns empty object for non-string input", () => {
    expect(safeJsonParse(123 as unknown as string)).toEqual({});
  });

  it("handles nested objects with large integers", () => {
    const result = safeJsonParse('{"data": {"ticketId": 1021987000032211189}}');
    expect((result.data as Record<string, unknown>).ticketId).toBe(
      "1021987000032211189",
    );
  });
});

describe("safeJsonParse (source-based parsing)", () => {
  it("does not rewrite digits inside a string value", () => {
    const result = safeJsonParse('{"t":"a: 12345678901234567890, b"}');
    expect(result).toEqual({ t: "a: 12345678901234567890, b" });
  });

  it("keeps an unsafe 16-digit integer exact as a string", () => {
    const result = safeJsonParse('{"id": 9007199254740993}');
    expect(result.id).toBe("9007199254740993");
  });

  it("keeps a long decimal as a number", () => {
    const result = safeJsonParse('{"v": 1.12345678901234567890}');
    expect(typeof result.v).toBe("number");
  });

  it("handles unsafe integers in arrays and nested objects", () => {
    const result = safeJsonParse(
      '{"a":[12345678901234567890],"b":{"c":-12345678901234567}}',
    );
    expect(result).toEqual({
      a: ["12345678901234567890"],
      b: { c: "-12345678901234567" },
    });
  });

  it("returns {} for arrays, primitives and null", () => {
    expect(safeJsonParse("[1,2]")).toEqual({});
    expect(safeJsonParse('"x"')).toEqual({});
    expect(safeJsonParse("5")).toEqual({});
    expect(safeJsonParse("null")).toEqual({});
  });

  it("returns {} for invalid, truncated, empty and non-string input", () => {
    expect(safeJsonParse("{bad")).toEqual({});
    expect(safeJsonParse('{"a":1')).toEqual({});
    expect(safeJsonParse("")).toEqual({});
    expect(safeJsonParse(undefined as unknown as string)).toEqual({});
  });

  it("does not pollute Object.prototype through __proto__", () => {
    const result = safeJsonParse('{"__proto__":{"polluted":true},"a":1}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.a).toBe(1);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

describe("tryParseJson", () => {
  it("distinguishes broken payloads from empty ones", () => {
    expect(tryParseJson("")).toEqual({ ok: true, value: {} });
    expect(tryParseJson("  ")).toEqual({ ok: true, value: {} });
    expect(tryParseJson("{}")).toEqual({ ok: true, value: {} });
    const truncated = tryParseJson('{"a":1');
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.reason).toBe("invalid-json");
  });

  it("reports non-object JSON", () => {
    for (const text of ["[1]", "null", "3", '"s"']) {
      const result = tryParseJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not-an-object");
    }
  });

  it("returns parsed objects with exact large integers", () => {
    expect(tryParseJson('{"id": 1021987000032211189}')).toEqual({
      ok: true,
      value: { id: "1021987000032211189" },
    });
  });
});

describe("parseJsonObject without context.source (legacy fallback)", () => {
  it("quotes integers of 17+ digits like the previous implementation", () => {
    expect(parseJsonObject('{"id": 1021987000032211189}', false)).toEqual({
      ok: true,
      value: { id: "1021987000032211189" },
    });
    expect(
      parseJsonObject(
        '{"a":[12345678901234567],"b":-12345678901234567}',
        false,
      ),
    ).toEqual({
      ok: true,
      value: { a: ["12345678901234567"], b: "-12345678901234567" },
    });
  });

  it("leaves safe integers and long decimals as numbers", () => {
    expect(
      parseJsonObject(
        '{"n": 1234567890123456, "d": 1.12345678901234567}',
        false,
      ),
    ).toEqual({
      ok: true,
      value: { n: 1234567890123456, d: 1.1234567890123457 },
    });
  });

  it("reports invalid and non-object input the same way", () => {
    expect(parseJsonObject('{"a":1', false).ok).toBe(false);
    expect(parseJsonObject("[1]", false)).toEqual({
      ok: false,
      reason: "not-an-object",
    });
    expect(parseJsonObject("", false)).toEqual({ ok: true, value: {} });
  });

  it("agrees with the source-based path for ordinary payloads", () => {
    const text = '{"city":"Paris","n":3,"nested":{"ok":true,"list":[1,2]}}';
    expect(parseJsonObject(text, false)).toEqual(parseJsonObject(text, true));
  });
});
