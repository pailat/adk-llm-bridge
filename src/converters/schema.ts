/**
 * Shared schema normalization.
 *
 * Converts Gemini-style schemas (UPPERCASE type names, int64 counts as
 * strings) to the JSON-Schema-style form expected by OpenAI-compatible APIs
 * and Anthropic, and fixes string counts in schemas that are already JSON
 * Schema. Used by tool conversion and structured-output mapping across
 * providers.
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

/**
 * `gemini` rewrites a Gemini-style schema (type names, counts, bounds);
 * `counts` only fixes string counts in a schema that is already JSON Schema.
 */
type NormalizeMode = "gemini" | "counts";

/**
 * JSON Schema keywords whose value is a single sub-schema. In `counts` mode
 * only these, {@link JSON_SCHEMA_ARRAY_KEYWORDS} and
 * {@link SCHEMA_MAP_KEYWORDS} are visited; any other keyword (vendor
 * extensions, `discriminator`, `xml`, ...) is copied verbatim.
 */
const JSON_SCHEMA_SINGLE_KEYWORDS: ReadonlySet<string> = new Set([
  "items",
  "additionalItems",
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);

/** JSON Schema keywords whose value is a list of sub-schemas. */
const JSON_SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
  "items",
]);

/**
 * Writes `value` as an own enumerable property. A plain `target[key] = value`
 * with the key `__proto__` would set the prototype instead and drop the key
 * (for example a tool argument named `__proto__` in a schema from
 * `JSON.parse`).
 */
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeSchemaArray(
  value: unknown[],
  mode: NormalizeMode,
): unknown[] {
  return value.map((item) =>
    isPlainObject(item) ? normalizeNode(item, mode) : item,
  );
}

function normalizeSchemaMap(
  value: Record<string, unknown>,
  mode: NormalizeMode,
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(value)) {
    setOwn(map, name, isPlainObject(sub) ? normalizeNode(sub, mode) : sub);
  }
  return map;
}

/** Normalizes one keyword's value in `gemini` mode. */
function normalizeGeminiValue(key: string, value: unknown): unknown {
  if (key === "type" && typeof value === "string") {
    // Convert UPPERCASE type to lowercase (OBJECT -> object, STRING -> string)
    return value.toLowerCase();
  }
  if (key === "type" && Array.isArray(value)) {
    // JSON Schema type union (["STRING", "NULL"]): lowercase each name.
    return value.map((item) =>
      typeof item === "string" ? item.toLowerCase() : item,
    );
  }
  if (INT64_COUNT_KEYWORDS.has(key)) return coerceCount(value);
  if (NUMBER_BOUND_KEYWORDS.has(key)) return coerceBound(value);
  if (DATA_KEYWORDS.has(key)) return value;
  if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
    return normalizeSchemaMap(value, "gemini");
  }
  // Single sub-schema: items, additionalProperties, not, if/then/else...
  if (isPlainObject(value)) return normalizeNode(value, "gemini");
  // Sub-schema lists (anyOf, oneOf, allOf, prefixItems, items[]) are
  // normalized; primitive lists (required, propertyOrdering) pass through.
  if (Array.isArray(value)) return normalizeSchemaArray(value, "gemini");
  return value;
}

/**
 * Normalizes one keyword's value in `counts` mode: only counts change, and
 * only known sub-schema positions are visited.
 */
function normalizeCountsValue(key: string, value: unknown): unknown {
  if (INT64_COUNT_KEYWORDS.has(key)) return coerceCount(value);
  if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
    return normalizeSchemaMap(value, "counts");
  }
  if (JSON_SCHEMA_SINGLE_KEYWORDS.has(key) && isPlainObject(value)) {
    return normalizeNode(value, "counts");
  }
  if (JSON_SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
    return normalizeSchemaArray(value, "counts");
  }
  return value;
}

function normalizeNode(
  input: Record<string, unknown>,
  mode: NormalizeMode,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    setOwn(
      result,
      key,
      mode === "gemini"
        ? normalizeGeminiValue(key, value)
        : normalizeCountsValue(key, value),
    );
  }
  return result;
}

/**
 * Normalizes a Gemini-style schema to a JSON-Schema-style schema.
 *
 * - UPPERCASE type names become lowercase (`OBJECT` → `object`).
 * - int64 count keywords (`minItems`, `maxItems`, `minLength`, `maxLength`,
 *   `minProperties`, `maxProperties`) given as canonical non-negative integer
 *   strings become integers (`"2"` → `2`).
 * - Numeric bounds (`minimum`, `maximum`, `exclusiveMinimum`,
 *   `exclusiveMaximum`, `multipleOf`) given as JSON number strings become
 *   numbers.
 *
 * It recurses into every sub-schema position (`properties` and other schema
 * maps, `items`, `prefixItems`, `anyOf`/`oneOf`/`allOf`,
 * `additionalProperties`, `not`, ...). Instance data (`default`, `example`,
 * `examples`, `enum`, `const`) is copied verbatim. A property named
 * `__proto__` is kept as an own property. The function is
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
  return normalizeNode(schema, "gemini");
}

/**
 * Fixes int64 count keywords in a schema that is already JSON Schema
 * (`responseJsonSchema`, `parametersJsonSchema`).
 *
 * Count keywords (`minItems`, `maxItems`, `minLength`, `maxLength`,
 * `minProperties`, `maxProperties`) given as canonical non-negative integer
 * strings become integers (`"2"` → `2`), in every JSON Schema sub-schema
 * position: `properties`, `patternProperties`, `dependentSchemas`, `$defs`,
 * `definitions`, `items` (object or array), `prefixItems`,
 * `allOf`/`anyOf`/`oneOf`, `additionalItems`, `contains`,
 * `additionalProperties`, `propertyNames`, `unevaluatedItems`,
 * `unevaluatedProperties`, `not`, `if`/`then`/`else` and `contentSchema`.
 * Nothing else changes: type names keep their case, numeric bounds are kept,
 * and every other keyword (instance data such as `default`, `enum`, `const`;
 * vendor extensions; `discriminator`, `xml`, ...) is copied verbatim. A
 * property named `__proto__` is kept as an own property.
 *
 * A count that is not a canonical digit string (`"two"`, `"-1"`, `"02"`, or a
 * value beyond the safe-integer range) is left as is, as
 * {@link normalizeSchema} does: guessing a number could silently change the
 * schema, and the provider's validator reports the bad value to the caller.
 *
 * The input is not mutated; a new object is returned. The function is
 * idempotent.
 *
 * @param schema - The JSON Schema object
 * @returns A copy with string counts converted to integers
 *
 * @example
 * ```typescript
 * normalizeJsonSchemaCounts({ type: "array", minItems: "2", items: { $ref: "#/$defs/x" } });
 * // Returns: { type: "array", minItems: 2, items: { $ref: "#/$defs/x" } }
 * ```
 *
 * @internal
 */
export function normalizeJsonSchemaCounts(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeNode(schema, "counts");
}
