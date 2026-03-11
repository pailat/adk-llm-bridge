import { describe, expect, it } from "bun:test";
import { safeJsonParse } from "../../src/utils/json";

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
    const result = safeJsonParse(
      '{"note": "ID is 1021987000032211189"}',
    );
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
    const result = safeJsonParse(
      '{"ids": [1021987000032211189, 42]}',
    );
    expect((result.ids as unknown[])[0]).toBe("1021987000032211189");
    expect((result.ids as unknown[])[1]).toBe(42);
  });

  it("converts large integer as last element of array", () => {
    const result = safeJsonParse(
      '{"ids": [42, 1021987000032211189]}',
    );
    expect((result.ids as unknown[])[0]).toBe(42);
    expect((result.ids as unknown[])[1]).toBe("1021987000032211189");
  });

  it("returns empty object for malformed JSON", () => {
    expect(safeJsonParse("{invalid}")).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(safeJsonParse("")).toEqual({});
  });

  it("handles nested objects with large integers", () => {
    const result = safeJsonParse(
      '{"data": {"ticketId": 1021987000032211189}}',
    );
    expect((result.data as Record<string, unknown>).ticketId).toBe(
      "1021987000032211189",
    );
  });
});
