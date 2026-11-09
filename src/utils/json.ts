/**
 * JSON utilities that parse model and provider payloads without losing large
 * integers.
 */

/** Result of {@link tryParseJson}. */
export type JsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "invalid-json" | "not-an-object"; error?: string };

/** Result of {@link parseJson}. */
export type JsonValueResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const INTEGER_SOURCE = /^-?\d+$/;

/**
 * Reviver that keeps integers beyond `Number.MAX_SAFE_INTEGER` exact by
 * returning their source text as a string (IDs such as 19-digit Zoho Desk
 * ticket IDs would otherwise be silently rounded by IEEE 754). Decimals and
 * safe integers are untouched. Runs on parsed tokens, so a string value that
 * merely *contains* digits is never rewritten. `context.source` is passed by
 * every supported runtime (Node 22 and later, Bun).
 */
function preserveUnsafeIntegers(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (
    typeof value === "number" &&
    context?.source !== undefined &&
    INTEGER_SOURCE.test(context.source) &&
    !Number.isSafeInteger(value)
  ) {
    return context.source;
  }
  return value;
}

/**
 * Parses any JSON value, keeping large integers exact.
 *
 * @remarks
 * Integers beyond `Number.MAX_SAFE_INTEGER` become strings of their exact
 * source text, at any depth and also at the top level. Unlike
 * {@link tryParseJson}, arrays and scalars are returned as they are, and
 * empty input is invalid JSON.
 *
 * @param str - The JSON text.
 * @returns The value, or the parse error message.
 * @internal
 */
export function parseJson(str: string): JsonValueResult {
  try {
    return {
      ok: true,
      value: JSON.parse(str, preserveUnsafeIntegers as never) as unknown,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parses a JSON object (tool-call arguments) and reports failure explicitly.
 *
 * - Integers beyond `Number.MAX_SAFE_INTEGER` become strings of their exact
 *   source text (no precision loss).
 * - Empty or whitespace-only input is a valid "no arguments" call: `{}`.
 * - Invalid JSON (for example arguments truncated by `max_tokens`) returns
 *   `{ ok: false, reason: "invalid-json" }`.
 * - Valid JSON that is not a plain object (array, string, number, `null`)
 *   returns `{ ok: false, reason: "not-an-object" }`.
 *
 * Use this when the caller must tell a broken payload from an empty one.
 *
 * @param str - The JSON text
 * @internal
 */
export function tryParseJson(str: string): JsonParseResult {
  if (typeof str !== "string" || str.trim() === "") {
    return { ok: true, value: {} };
  }

  const parsed = parseJson(str);
  if (!parsed.ok) {
    return { ok: false, reason: "invalid-json", error: parsed.error };
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not-an-object" };
  }
  return { ok: true, value: value as Record<string, unknown> };
}
