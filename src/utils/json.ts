/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * JSON utilities for parsing tool-call arguments without losing large integers.
 *
 * @module utils/json
 */

/** Result of {@link tryParseJson}. */
export type JsonParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "invalid-json" | "not-an-object"; error?: string };

/**
 * Whether this runtime passes `context.source` (the raw token text) to
 * `JSON.parse` revivers (V8 >= 11.4, Node >= 22, Bun). Evaluated once.
 */
const SUPPORTS_PARSE_SOURCE: boolean = (() => {
  try {
    let supported = false;
    JSON.parse("1", (_key, value, context?: { source?: string }) => {
      supported = context?.source === "1";
      return value;
    });
    return supported;
  } catch {
    return false;
  }
})();

const INTEGER_SOURCE = /^-?\d+$/;

/**
 * Reviver that keeps integers beyond `Number.MAX_SAFE_INTEGER` exact by
 * returning their source text as a string (IDs such as 19-digit Zoho Desk
 * ticket IDs would otherwise be silently rounded by IEEE 754). Decimals and
 * safe integers are untouched. Runs on parsed tokens, so a string value that
 * merely *contains* digits is never rewritten.
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
 * Legacy fallback for runtimes without `context.source`: quotes integers of 17+
 * digits with a regex before parsing. Imperfect (it can touch digits inside a
 * string value) but it is the previous behavior.
 */
function quoteLargeIntegers(str: string): string {
  return str.replace(
    /([:[,])\s*(-?\d{17,})(?!\.\d)(?=\s*[,\]}])/g,
    (_, delimiter, num) => `${delimiter} "${num}"`,
  );
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
  return parseJsonObject(str, SUPPORTS_PARSE_SOURCE);
}

/**
 * Implementation of {@link tryParseJson} with the `context.source` capability
 * injected, so the legacy fallback path stays testable on runtimes that have
 * the capability.
 *
 * @internal
 */
export function parseJsonObject(
  str: string,
  supportsParseSource: boolean,
): JsonParseResult {
  if (typeof str !== "string" || str.trim() === "") {
    return { ok: true, value: {} };
  }

  let parsed: unknown;
  try {
    parsed = supportsParseSource
      ? JSON.parse(str, preserveUnsafeIntegers as never)
      : JSON.parse(quoteLargeIntegers(str));
  } catch (error) {
    return {
      ok: false,
      reason: "invalid-json",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not-an-object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Parses tool-call arguments, returning `{}` on any failure.
 *
 * Same parsing as {@link tryParseJson}; prefer that when a broken payload must
 * not be mistaken for "no arguments".
 *
 * @param str - The JSON string to parse
 * @returns The parsed object, or an empty object if parsing fails or the
 *   result is not a plain object
 *
 * @internal
 */
export function safeJsonParse(str: string): Record<string, unknown> {
  const result = tryParseJson(str);
  return result.ok ? result.value : {};
}
