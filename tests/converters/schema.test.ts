import { describe, expect, it } from "bun:test";
import {
  normalizeJsonSchemaCounts,
  normalizeSchema,
} from "../../src/converters/schema.js";

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

describe("normalizeSchema int64 coercion", () => {
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

describe("normalizeJsonSchemaCounts", () => {
  it("converts digit-string counts at the root", () => {
    expect(
      normalizeJsonSchemaCounts({
        type: "string",
        minLength: "1",
        maxLength: "40",
      }),
    ).toEqual({ type: "string", minLength: 1, maxLength: 40 });
  });

  it("recurses into every sub-schema position", () => {
    const input = {
      type: "object",
      minProperties: "1",
      maxProperties: "9",
      properties: {
        tags: { type: "array", minItems: "2", items: { maxLength: "8" } },
      },
      patternProperties: { "^x-": { minLength: "3" } },
      additionalProperties: { maxLength: "5" },
      prefixItems: [{ minLength: "1" }],
      anyOf: [{ minItems: "1" }],
      oneOf: [{ maxItems: "2" }],
      allOf: [{ minProperties: "0" }],
      not: { maxLength: "0" },
      $defs: { word: { type: "string", minLength: "4" } },
      definitions: { legacy: { maxItems: "7" } },
    };
    expect(normalizeJsonSchemaCounts(input)).toEqual({
      type: "object",
      minProperties: 1,
      maxProperties: 9,
      properties: {
        tags: { type: "array", minItems: 2, items: { maxLength: 8 } },
      },
      patternProperties: { "^x-": { minLength: 3 } },
      additionalProperties: { maxLength: 5 },
      prefixItems: [{ minLength: 1 }],
      anyOf: [{ minItems: 1 }],
      oneOf: [{ maxItems: 2 }],
      allOf: [{ minProperties: 0 }],
      not: { maxLength: 0 },
      $defs: { word: { type: "string", minLength: 4 } },
      definitions: { legacy: { maxItems: 7 } },
    });
  });

  it("changes nothing but counts", () => {
    const input = {
      type: "OBJECT",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      "x-vendor": { minItems: "keep-me?" },
      minimum: "1",
      properties: {
        minItems: { type: "Integer", default: "3" },
        mode: { enum: ["A"], const: "A", examples: [{ minItems: "2" }] },
      },
      required: ["minItems"],
      additionalProperties: false,
    };
    expect(normalizeJsonSchemaCounts(input)).toEqual(input);
  });

  it("leaves counts that are not canonical digit strings alone", () => {
    const input = {
      minItems: "two",
      maxItems: "-1",
      minLength: "02",
      maxLength: "1.5",
      minProperties: "9007199254740993",
      maxProperties: 3,
    };
    expect(normalizeJsonSchemaCounts(input)).toEqual(input);
  });

  it("does not mutate the input", () => {
    const input = {
      type: "object",
      minProperties: "1",
      properties: { tags: { type: "array", minItems: "2" } },
      anyOf: [{ maxLength: "3" }],
    };
    const snapshot = structuredClone(input);
    const out = normalizeJsonSchemaCounts(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect(out.properties).not.toBe(input.properties);
  });

  it("is idempotent", () => {
    const once = normalizeJsonSchemaCounts({
      items: { minItems: "2" },
      maxLength: "4",
    });
    expect(normalizeJsonSchemaCounts(once)).toEqual(once);
  });
});

describe("__proto__ property names", () => {
  const raw =
    '{"type":"object","__proto__":{"description":"root"},"properties":{"__proto__":{"type":"string","minLength":"1"},"name":{"type":"string"}},"required":["__proto__"]}';

  for (const [label, normalize] of [
    ["normalizeJsonSchemaCounts", normalizeJsonSchemaCounts],
    ["normalizeSchema", normalizeSchema],
  ] as const) {
    it(`${label} keeps __proto__ at the root and under properties`, () => {
      const input = JSON.parse(raw) as Record<string, unknown>;
      const out = normalize(input) as Record<string, unknown>;
      const properties = out.properties as Record<string, unknown>;

      expect(Object.hasOwn(out, "__proto__")).toBe(true);
      expect(Object.hasOwn(properties, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({
        description: "root",
      });
      expect(
        Object.getOwnPropertyDescriptor(properties, "__proto__")?.value,
      ).toEqual({ type: "string", minLength: 1 });
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
      expect(JSON.stringify(properties)).toBe(
        '{"__proto__":{"type":"string","minLength":1},"name":{"type":"string"}}',
      );
      expect(JSON.stringify(out)).toContain(
        '"__proto__":{"description":"root"}',
      );
    });
  }
});

describe("normalizeJsonSchemaCounts keyword positions", () => {
  it("copies non-sub-schema keywords verbatim", () => {
    const input = {
      type: "object",
      "x-vendor": { minItems: "3" },
      discriminator: {
        propertyName: "kind",
        mapping: { a: "#/$defs/a", minLength: "1" },
      },
      xml: { name: "root", maxLength: "2" },
      externalDocs: { url: "https://example.com", minItems: "1" },
      "x-list": [{ minItems: "4" }],
    };
    const out = normalizeJsonSchemaCounts(input);
    expect(out).toEqual(input);
    expect(out["x-vendor"]).toEqual({ minItems: "3" });
  });

  it("normalizes the remaining sub-schema positions", () => {
    // Built from JSON: a literal with a `then` key is a thenable.
    const input = JSON.parse(
      '{"contains":{"minLength":"1"},"propertyNames":{"maxLength":"16"},' +
        '"unevaluatedProperties":{"minLength":"2"},"unevaluatedItems":{"maxItems":"3"},' +
        '"additionalItems":{"minLength":"4"},"contentSchema":{"minProperties":"1"},' +
        '"dependentSchemas":{"a":{"minProperties":"2"}},"if":{"minItems":"1"},' +
        '"then":{"maxItems":"2"},"else":{"maxItems":"0"},"items":[{"minLength":"5"}]}',
    ) as Record<string, unknown>;
    expect(JSON.stringify(normalizeJsonSchemaCounts(input))).toBe(
      '{"contains":{"minLength":1},"propertyNames":{"maxLength":16},' +
        '"unevaluatedProperties":{"minLength":2},"unevaluatedItems":{"maxItems":3},' +
        '"additionalItems":{"minLength":4},"contentSchema":{"minProperties":1},' +
        '"dependentSchemas":{"a":{"minProperties":2}},"if":{"minItems":1},' +
        '"then":{"maxItems":2},"else":{"maxItems":0},"items":[{"minLength":5}]}',
    );
  });

  it("leaves normalizeSchema recursing into unknown keywords", () => {
    expect(normalizeSchema({ "x-vendor": { minItems: "3" } })).toEqual({
      "x-vendor": { minItems: 3 },
    });
  });
});
