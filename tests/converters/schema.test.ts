import { describe, expect, it } from "bun:test";
import { normalizeSchema } from "../../src/converters/schema.js";

describe("normalizeSchema", () => {
  it("normalizes nested OBJECT/STRING/ARRAY types to lowercase", () => {
    const result = normalizeSchema({
      type: "OBJECT",
      properties: {
        name: { type: "STRING" },
        tags: { type: "ARRAY", items: { type: "STRING" } },
        count: { type: "INTEGER" },
      },
      required: ["name"],
    });

    expect(result).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        count: { type: "integer" },
      },
      required: ["name"],
    });
  });

  it("is idempotent on already-lowercase schemas", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
    };

    expect(normalizeSchema(schema)).toEqual(schema);
  });

  it("returns undefined for non-object input", () => {
    expect(normalizeSchema(null)).toBeUndefined();
    expect(normalizeSchema("string")).toBeUndefined();
    expect(normalizeSchema(42)).toBeUndefined();
  });

  it("preserves arrays of primitives (e.g. required, enum)", () => {
    const result = normalizeSchema({
      type: "STRING",
      enum: ["a", "b", "c"],
    });

    expect(result).toEqual({ type: "string", enum: ["a", "b", "c"] });
  });
});
