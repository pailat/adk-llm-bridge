import { describe, expect, it } from "bun:test";
import { parseJson, tryParseJson } from "../../src/utils/json.js";

/** The parsed object, or `{}` when `tryParseJson` reports a failure. */
function objectOf(text: string): Record<string, unknown> {
  const result = tryParseJson(text);
  return result.ok ? result.value : {};
}

describe("tryParseJson values", () => {
  it("parses normal JSON unchanged", () => {
    const result = objectOf('{"name": "test", "count": 42}');
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("converts 19-digit integer to string (Zoho ticket ID)", () => {
    const zohoId = "1021987000032211189";
    const result = objectOf(`{"ticketId": ${zohoId}}`);
    expect(result.ticketId).toBe(zohoId);
    expect(typeof result.ticketId).toBe("string");
  });

  it("converts 17-digit integer to string (boundary)", () => {
    const id = "12345678901234567";
    const result = objectOf(`{"id": ${id}}`);
    expect(result.id).toBe(id);
    expect(typeof result.id).toBe("string");
  });

  it("preserves 16-digit integer as number (safe)", () => {
    const result = objectOf('{"id": 1234567890123456}');
    expect(result.id).toBe(1234567890123456);
    expect(typeof result.id).toBe("number");
  });

  it("does NOT convert large decimals", () => {
    const result = objectOf('{"val": 12345678901234567.89}');
    expect(typeof result.val).toBe("number");
  });

  it("converts negative large integer to string", () => {
    const result = objectOf('{"id": -12345678901234567}');
    expect(result.id).toBe("-12345678901234567");
    expect(typeof result.id).toBe("string");
  });

  it("does NOT convert scientific notation", () => {
    const result = objectOf('{"val": 1e20}');
    expect(typeof result.val).toBe("number");
  });

  it("does NOT modify numbers inside JSON strings", () => {
    const result = objectOf('{"note": "ID is 1021987000032211189"}');
    expect(result.note).toBe("ID is 1021987000032211189");
  });

  it("converts multiple large integers in same object", () => {
    const result = objectOf(
      '{"id1": 1021987000032211189, "id2": 9876543210987654321}',
    );
    expect(result.id1).toBe("1021987000032211189");
    expect(result.id2).toBe("9876543210987654321");
  });

  it("converts large integer as first element of array", () => {
    const result = objectOf('{"ids": [1021987000032211189, 42]}');
    expect((result.ids as unknown[])[0]).toBe("1021987000032211189");
    expect((result.ids as unknown[])[1]).toBe(42);
  });

  it("converts large integer as last element of array", () => {
    const result = objectOf('{"ids": [42, 1021987000032211189]}');
    expect((result.ids as unknown[])[0]).toBe(42);
    expect((result.ids as unknown[])[1]).toBe("1021987000032211189");
  });

  it("returns empty object for malformed JSON", () => {
    expect(objectOf("{invalid}")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(objectOf("")).toEqual({});
  });

  it("returns empty object for undefined input", () => {
    expect(objectOf(undefined as unknown as string)).toEqual({});
  });

  it("returns empty object for null input", () => {
    expect(objectOf(null as unknown as string)).toEqual({});
  });

  it("returns empty object for non-string input", () => {
    expect(objectOf(123 as unknown as string)).toEqual({});
  });

  it("handles nested objects with large integers", () => {
    const result = objectOf('{"data": {"ticketId": 1021987000032211189}}');
    expect((result.data as Record<string, unknown>).ticketId).toBe(
      "1021987000032211189",
    );
  });
});

describe("tryParseJson (source-based parsing)", () => {
  it("does not rewrite digits inside a string value", () => {
    const result = objectOf('{"t":"a: 12345678901234567890, b"}');
    expect(result).toEqual({ t: "a: 12345678901234567890, b" });
  });

  it("keeps an unsafe 16-digit integer exact as a string", () => {
    const result = objectOf('{"id": 9007199254740993}');
    expect(result.id).toBe("9007199254740993");
  });

  it("keeps a long decimal as a number", () => {
    const result = objectOf('{"v": 1.12345678901234567890}');
    expect(typeof result.v).toBe("number");
  });

  it("handles unsafe integers in arrays and nested objects", () => {
    const result = objectOf(
      '{"a":[12345678901234567890],"b":{"c":-12345678901234567}}',
    );
    expect(result).toEqual({
      a: ["12345678901234567890"],
      b: { c: "-12345678901234567" },
    });
  });

  it("returns {} for arrays, primitives and null", () => {
    expect(objectOf("[1,2]")).toEqual({});
    expect(objectOf('"x"')).toEqual({});
    expect(objectOf("5")).toEqual({});
    expect(objectOf("null")).toEqual({});
  });

  it("returns {} for invalid, truncated, empty and non-string input", () => {
    expect(objectOf("{bad")).toEqual({});
    expect(objectOf('{"a":1')).toEqual({});
    expect(objectOf("")).toEqual({});
    expect(objectOf(undefined as unknown as string)).toEqual({});
  });

  it("does not pollute Object.prototype through __proto__", () => {
    const result = objectOf('{"__proto__":{"polluted":true},"a":1}');
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

describe("parseJson", () => {
  it("keeps unsafe integers exact in arrays and at the top level", () => {
    expect(parseJson("[12345678901234567890, 1]")).toEqual({
      ok: true,
      value: ["12345678901234567890", 1],
    });
    expect(parseJson("12345678901234567890")).toEqual({
      ok: true,
      value: "12345678901234567890",
    });
  });

  it("returns scalars, null and objects as they are", () => {
    expect(parseJson('"s"')).toEqual({ ok: true, value: "s" });
    expect(parseJson("null")).toEqual({ ok: true, value: null });
    expect(parseJson('{"a":1.5}')).toEqual({ ok: true, value: { a: 1.5 } });
  });

  it("reports invalid and empty input", () => {
    for (const text of ["", "{bad", "[1,"]) {
      const result = parseJson(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(typeof result.error).toBe("string");
    }
  });
});
