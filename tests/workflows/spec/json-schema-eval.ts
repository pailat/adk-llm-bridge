/**
 * A small JSON Schema (draft 2020-12) evaluator for the tests.
 *
 * @remarks
 * It supports exactly the keywords the run spec schema uses and throws on any
 * other validation keyword, so a keyword added to the schema without
 * evaluator support fails loudly instead of being ignored. Patterns compile
 * with the Unicode flag and lengths count code points, as the specification
 * says.
 */

/** A JSON Schema as a plain object. */
type Schema = Readonly<Record<string, unknown>>;

/** Keywords that only annotate and never change validity. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$defs",
  "title",
  "description",
]);

/** Keywords the evaluator knows how to check. */
const VALIDATION_KEYWORDS: ReadonlySet<string> = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "oneOf",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
]);

/** Whether a value is a non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural JSON equality, for `const` and `enum`. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isObject(left) && isObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every(
        (key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

/** Whether a value has the JSON Schema primitive type. */
function hasType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      throw new Error(`Unsupported type: ${String(type)}`);
  }
}

/** Resolves a local `#/...` reference against the root schema. */
function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported $ref: ${ref}`);
  }
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(node) || !Object.hasOwn(node, key)) {
      throw new Error(`Unresolved $ref: ${ref}`);
    }
    node = node[key];
  }
  if (!isObject(node)) {
    throw new Error(`$ref does not point to a schema: ${ref}`);
  }
  return node;
}

/** Number of code points of a string. */
function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) {
    count++;
  }
  return count;
}

/** Whether `value` is valid against `schema` (a boolean schema is allowed). */
function check(root: Schema, schema: unknown, value: unknown): boolean {
  if (typeof schema === "boolean") {
    return schema;
  }
  if (!isObject(schema)) {
    throw new Error("A schema must be an object or a boolean.");
  }
  for (const key of Object.keys(schema)) {
    if (!ANNOTATION_KEYWORDS.has(key) && !VALIDATION_KEYWORDS.has(key)) {
      throw new Error(`Unsupported keyword: ${key}`);
    }
  }
  if (typeof schema.$ref === "string") {
    if (!check(root, resolveRef(root, schema.$ref), value)) {
      return false;
    }
  }
  if ("type" in schema && !hasType(value, schema.type)) {
    return false;
  }
  if ("const" in schema && !jsonEqual(schema.const, value)) {
    return false;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((item) => jsonEqual(item, value))) {
      return false;
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => check(root, branch, value));
    if (matches.length !== 1) {
      return false;
    }
  }
  if (typeof value === "string") {
    const length = codePointLength(value);
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      return false;
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      return false;
    }
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    ) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return false;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return false;
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      value <= schema.exclusiveMinimum
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return false;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return false;
    }
    if ("items" in schema) {
      if (!value.every((item) => check(root, schema.items, item))) {
        return false;
      }
    }
  }
  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name !== "string" || !Object.hasOwn(value, name)) {
          return false;
        }
      }
    }
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, name) && !check(root, sub, value[name])) {
        return false;
      }
    }
    for (const name of Object.keys(value)) {
      if (
        "propertyNames" in schema &&
        !check(root, schema.propertyNames, name)
      ) {
        return false;
      }
      if (
        !Object.hasOwn(properties, name) &&
        "additionalProperties" in schema
      ) {
        if (!check(root, schema.additionalProperties, value[name])) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Whether a JSON value is valid against a JSON Schema.
 *
 * @param schema - The root schema; `$ref` values resolve inside it.
 * @param value - The JSON value to check.
 * @throws When the schema uses a keyword the evaluator does not support.
 */
export function jsonSchemaAccepts(schema: Schema, value: unknown): boolean {
  return check(schema, schema, value);
}

/** Every keyword the evaluator accepts, for tests that pin the vocabulary. */
export const EVALUATED_KEYWORDS: ReadonlySet<string> = new Set([
  ...ANNOTATION_KEYWORDS,
  ...VALIDATION_KEYWORDS,
]);
