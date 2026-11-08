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

describe("normalizeSchema int64 coercion (e2e-llm F2)", () => {
  it('coerces count keywords given as "2" to integers', () => {
    expect(
      normalizeSchema({
        type: "ARRAY",
        minItems: "2",
        maxItems: "4",
        items: {
          type: "STRING",
          minLength: "1",
          maxLength: "10",
        },
      }),
    ).toEqual({
      type: "array",
      minItems: 2,
      maxItems: 4,
      items: { type: "string", minLength: 1, maxLength: 10 },
    });
    expect(
      normalizeSchema({
        type: "OBJECT",
        minProperties: "0",
        maxProperties: "3",
      }),
    ).toEqual({ type: "object", minProperties: 0, maxProperties: 3 });
  });

  it("recurses into every sub-schema position", () => {
    const tagged = { type: "STRING", minLength: "2" };
    const expected = { type: "string", minLength: 2 };
    expect(
      normalizeSchema({
        type: "OBJECT",
        properties: { a: tagged },
        patternProperties: { "^x": tagged },
        $defs: { d: tagged },
        additionalProperties: tagged,
        anyOf: [tagged],
        oneOf: [tagged],
        allOf: [tagged],
        not: tagged,
        prefixItems: [tagged],
        items: tagged,
      }),
    ).toEqual({
      type: "object",
      properties: { a: expected },
      patternProperties: { "^x": expected },
      $defs: { d: expected },
      additionalProperties: expected,
      anyOf: [expected],
      oneOf: [expected],
      allOf: [expected],
      not: expected,
      prefixItems: [expected],
      items: expected,
    });
  });

  it("treats properties as a name map (property names that look like keywords)", () => {
    expect(
      normalizeSchema({
        type: "OBJECT",
        properties: {
          minItems: { type: "INTEGER" },
          default: { type: "STRING", maxLength: "3" },
          type: { type: "STRING" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        minItems: { type: "integer" },
        default: { type: "string", maxLength: 3 },
        type: { type: "string" },
      },
    });
  });

  it("keeps non-canonical or unsafe count strings verbatim", () => {
    for (const value of ["-1", "02", "1.5", "1e3", " 2", "", "abc"]) {
      expect(normalizeSchema({ minItems: value })).toEqual({ minItems: value });
    }
    expect(normalizeSchema({ maxLength: "9007199254740993" })).toEqual({
      maxLength: "9007199254740993",
    });
  });

  it("leaves numeric counts and bounds unchanged", () => {
    const schema = {
      type: "integer",
      minimum: -9007199254740991,
      maximum: 5,
      minItems: 2,
    };
    expect(normalizeSchema(schema)).toEqual(schema);
  });

  it("coerces numeric bounds given as JSON number strings", () => {
    expect(
      normalizeSchema({
        type: "NUMBER",
        minimum: "-3",
        maximum: "1.5",
        exclusiveMinimum: "0",
        exclusiveMaximum: "1e3",
        multipleOf: "0.5",
      }),
    ).toEqual({
      type: "number",
      minimum: -3,
      maximum: 1.5,
      exclusiveMinimum: 0,
      exclusiveMaximum: 1000,
      multipleOf: 0.5,
    });
    expect(normalizeSchema({ minimum: "abc", maximum: "1e999" })).toEqual({
      minimum: "abc",
      maximum: "1e999",
    });
  });

  it("copies instance data (default, example, examples, enum, const) verbatim", () => {
    const data = { type: "OBJECT", minItems: "2" };
    expect(
      normalizeSchema({
        type: "OBJECT",
        default: data,
        example: data,
        examples: [data],
        enum: [data],
        const: data,
      }),
    ).toEqual({
      type: "object",
      default: data,
      example: data,
      examples: [data],
      enum: [data],
      const: data,
    });
  });

  it("is idempotent after coercion", () => {
    const once = normalizeSchema({
      type: "ARRAY",
      minItems: "2",
      items: { type: "STRING", maxLength: "5" },
    });
    expect(normalizeSchema(once)).toEqual(once);
  });

  it("does not mutate its input", () => {
    const input = { type: "ARRAY", minItems: "2", items: { type: "STRING" } };
    const copy = structuredClone(input);
    normalizeSchema(input);
    expect(input).toEqual(copy);
  });
});
