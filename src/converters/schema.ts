/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Shared schema normalization.
 *
 * Converts Gemini-style schemas (UPPERCASE type names, int64 counts as
 * strings) to the JSON-Schema-style form expected by OpenAI-compatible APIs
 * and Anthropic. Used by tool conversion and structured-output mapping across
 * providers.
 *
 * @module converters/schema
 */

/**
 * Count keywords that `@google/genai` types as int64, which travels as a JSON
 * string (ADK turns zod `.min(2)` into `minItems: "2"`). JSON Schema requires
 * integers here; OpenAI and xAI reject a string with a 400.
 */
const INT64_COUNT_KEYWORDS: ReadonlySet<string> = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minProperties",
  "maxProperties",
]);

/**
 * Numeric bound keywords. `@google/genai` types them as numbers, but a
 * hand-written Gemini schema may still carry them as strings.
 */
const NUMBER_BOUND_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

/**
 * Keywords whose value is a map from names to sub-schemas (the map keys are
 * property names, not keywords).
 */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/**
 * Keywords whose value is instance data, not a schema. They are copied
 * verbatim: normalizing them would rewrite the caller's data.
 */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "example",
  "examples",
  "enum",
  "const",
]);

/** Canonical non-negative integer: no sign, no leading zeros, no exponent. */
const CANONICAL_NON_NEGATIVE_INT = /^(?:0|[1-9]\d*)$/;

/** Canonical JSON number literal. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Coerces a count keyword value. Only a canonical non-negative integer string
 * within the safe-integer range is converted; anything else is kept as is so
 * the provider reports it rather than this layer guessing.
 */
function coerceCount(value: unknown): unknown {
  if (typeof value !== "string" || !CANONICAL_NON_NEGATIVE_INT.test(value)) {
    return value;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

/** Coerces a numeric bound given as a canonical, finite JSON number string. */
function coerceBound(value: unknown): unknown {
  if (typeof value !== "string" || !JSON_NUMBER.test(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function normalizeSchemaArray(value: unknown[]): unknown[] {
  return value.map((item) =>
    isPlainObject(item) ? normalizeNode(item) : item,
  );
}

function normalizeNode(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "type" && typeof value === "string") {
      // Convert UPPERCASE type to lowercase (OBJECT -> object, STRING -> string)
      result[key] = value.toLowerCase();
    } else if (INT64_COUNT_KEYWORDS.has(key)) {
      result[key] = coerceCount(value);
    } else if (NUMBER_BOUND_KEYWORDS.has(key)) {
      result[key] = coerceBound(value);
    } else if (DATA_KEYWORDS.has(key)) {
      result[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
      const map: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        map[name] = isPlainObject(sub) ? normalizeNode(sub) : sub;
      }
      result[key] = map;
    } else if (isPlainObject(value)) {
      // Single sub-schema: items, additionalProperties, not, if/then/else...
      result[key] = normalizeNode(value);
    } else if (Array.isArray(value)) {
      // Sub-schema lists (anyOf, oneOf, allOf, prefixItems, items[]) are
      // normalized; primitive lists (required, propertyOrdering) pass through.
      result[key] = normalizeSchemaArray(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Normalizes a Gemini-style schema to a JSON-Schema-style schema.
 *
 * - UPPERCASE type names become lowercase (`OBJECT` -> `object`).
 * - int64 count keywords (`minItems`, `maxItems`, `minLength`, `maxLength`,
 *   `minProperties`, `maxProperties`) given as canonical non-negative integer
 *   strings become integers (`"2"` -> `2`).
 * - Numeric bounds (`minimum`, `maximum`, `exclusiveMinimum`,
 *   `exclusiveMaximum`, `multipleOf`) given as JSON number strings become
 *   numbers.
 *
 * It recurses into every sub-schema position (`properties` and other schema
 * maps, `items`, `prefixItems`, `anyOf`/`oneOf`/`allOf`,
 * `additionalProperties`, `not`, ...). Instance data (`default`, `example`,
 * `examples`, `enum`, `const`) is copied verbatim. The function is
 * idempotent.
 *
 * @param schema - The schema object to normalize
 * @returns The normalized schema, or undefined if the input is not an object
 *
 * @example
 * ```typescript
 * normalizeSchema({ type: "ARRAY", minItems: "2", items: { type: "STRING" } });
 * // Returns: { type: "array", minItems: 2, items: { type: "string" } }
 * ```
 */
export function normalizeSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (!isPlainObject(schema)) return undefined;
  return normalizeNode(schema);
}
