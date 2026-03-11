/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * JSON utilities for safe parsing with large integer handling.
 *
 * @module utils/json
 */

/**
 * Safely parses a JSON string, returning an empty object on failure.
 *
 * Pre-processes the JSON string to convert large integers (17+ digits) to
 * strings before parsing, preventing IEEE 754 double precision loss.
 * Numbers with 17+ digits exceed Number.MAX_SAFE_INTEGER (16 digits), so
 * they are silently rounded by JSON.parse — this is especially problematic
 * for IDs like Zoho Desk ticket IDs (19 digits).
 *
 * @param str - The JSON string to parse
 * @returns The parsed object, or empty object if parsing fails
 *
 * @internal
 */
export function safeJsonParse(str: string): Record<string, unknown> {
  try {
    // Pre-process: wrap large integers (17+ digits) in quotes to prevent
    // IEEE 754 precision loss. The pattern matches integers that appear as
    // JSON values (preceded by :, [, or , and followed by ,, ], or }).
    // Negative lookahead (?!\.\d) prevents matching large decimals.
    const safe = str.replace(
      /([:\[,])\s*(-?\d{17,})(?!\.\d)(?=\s*[,\]\}])/g,
      (_, delimiter, num) => `${delimiter} "${num}"`,
    );
    return JSON.parse(safe);
  } catch {
    return {};
  }
}
