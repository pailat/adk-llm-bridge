import { z } from "zod";
import { runSpecRegistry } from "./registry.js";
import { RunSpecSchema } from "./schema.js";

type JsonObject = Record<string, unknown>;

/** Narrows a JSON value to a plain object. */
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * zod keeps the description of a registered schema on its definition and
 * emits a bare `$ref` for a property that points at it. Copy the description
 * onto such a property so every property documents itself.
 */
function describeRefProperties(root: JsonObject): void {
  const defs = isObject(root.$defs) ? root.$defs : {};
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    if (isObject(node.properties)) {
      for (const property of Object.values(node.properties)) {
        if (
          isObject(property) &&
          typeof property.$ref === "string" &&
          property.description === undefined
        ) {
          const target = defs[property.$ref.replace("#/$defs/", "")];
          if (isObject(target) && typeof target.description === "string") {
            property.description = target.description;
          }
        }
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
}

/** Freezes a JSON value and everything inside it. */
function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Generates the schema from zod, fills the missing reference descriptions
 * and freezes the result, so a consumer cannot change the shared document.
 */
function buildRunSpecJsonSchema(): Record<string, unknown> {
  const generated: Record<string, unknown> = z.toJSONSchema(RunSpecSchema, {
    target: "draft-2020-12",
    io: "input",
    metadata: runSpecRegistry,
  });
  describeRefProperties(generated);
  return deepFreeze(generated);
}

/**
 * JSON Schema (draft 2020-12) of the run spec shape, input side.
 *
 * @remarks
 * Generated from the zod schema, so the two cannot drift. It carries the
 * shape rules only: types, required keys, closed objects, grammars and
 * bounds. Rules that compare fields with each other or with host rules are
 * checked by `validateRunSpec`. The document is deeply frozen; copy it
 * before changing it.
 *
 * @experimental
 */
export const runSpecJsonSchema: Readonly<Record<string, unknown>> =
  buildRunSpecJsonSchema();
