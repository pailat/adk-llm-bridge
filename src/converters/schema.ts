/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Shared schema normalization.
 *
 * Converts Gemini-style schemas (UPPERCASE type names) to the lowercase
 * JSON-Schema-style types expected by OpenAI and Anthropic. Used by tool
 * conversion and structured-output mapping across providers.
 *
 * @module converters/schema
 */

/**
 * Normalizes a Gemini-style schema to a JSON-Schema-style schema.
 *
 * Converts UPPERCASE type names (Gemini format) to lowercase, recursing into
 * nested objects and preserving arrays. Already-lowercase types are left
 * unchanged, making the function idempotent.
 *
 * @param schema - The schema object to normalize
 * @returns The normalized schema, or undefined if the input is not an object
 *
 * @example
 * ```typescript
 * normalizeSchema({ type: "OBJECT", properties: { name: { type: "STRING" } } });
 * // Returns: { type: "object", properties: { name: { type: "string" } } }
 * ```
 */
export function normalizeSchema(
  schema: unknown,
): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;

  const result: Record<string, unknown> = {};
  const input = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(input)) {
    if (key === "type" && typeof value === "string") {
      // Convert UPPERCASE type to lowercase (OBJECT -> object, STRING -> string)
      result[key] = value.toLowerCase();
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // Recursively normalize nested objects (like properties)
      result[key] = normalizeSchema(value);
    } else if (Array.isArray(value)) {
      // Handle arrays (like required) — recurse into object entries (e.g. items[])
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? normalizeSchema(item)
          : item,
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}
