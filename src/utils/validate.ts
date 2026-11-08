/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Runtime validation helpers for configuration boundaries.
 *
 * These are lightweight, zero-dependency checks applied at system boundaries
 * (config resolution, constructor initialization) to fail fast with clear
 * error messages instead of propagating invalid state.
 *
 * Failures are thrown as ADK's `InputValidationError` (a plain `Error`
 * subclass, so `catch`/`instanceof Error` and `message` keep working). Messages
 * never include credentials: URLs are passed through {@link redactUrl}.
 *
 * @module utils/validate
 */

import { InputValidationError } from "@google/adk";

/** Query or fragment parameter names whose values are treated as secrets. */
const SENSITIVE_PARAM =
  /([?&;#](?:api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|secret|client[-_]?secret|password|pwd|signature|sig)=)[^&#\s]*/gi;

/**
 * Masks the credentials ahead of the last `@` in the part before any `?`/`#`.
 * The userinfo starts after `://`, or after the last whitespace when the value
 * has no scheme. Anchoring on the *last* `@` also covers passwords containing
 * `/` or `@`, which make the URL invalid and are exactly what error messages
 * end up quoting.
 */
function redactUserinfo(value: string): string {
  const cut = value.search(/[?#]/);
  const head = cut < 0 ? value : value.slice(0, cut);
  const tail = cut < 0 ? "" : value.slice(cut);
  const at = head.lastIndexOf("@");
  if (at < 0) return value;

  const schemeEnd = head.indexOf("://");
  const start =
    schemeEnd >= 0 && schemeEnd < at
      ? schemeEnd + 3
      : head.slice(0, at).search(/\S*$/);
  const userinfo = head.slice(start, at);
  const mask = userinfo.includes(":") ? "***:***" : "***";
  return `${head.slice(0, start)}${mask}${head.slice(at)}${tail}`;
}

/**
 * Masks credentials in a URL-like string for use in error messages and logs:
 * `user:pass@host` becomes `***:***@host` (`user@host` becomes `***@host`) and
 * the value of sensitive query or fragment parameters (`key`, `api_key`,
 * `token`, `secret`, `password`, `signature`, ...) becomes `***`. Works on
 * strings that are not valid URLs too, which is exactly when validation errors
 * quote them. It errs on the side of over-redacting: everything between the
 * scheme (or the last whitespace) and the last `@` of the authority/path part
 * is masked.
 *
 * @param value - The URL or text containing a URL
 * @returns The same text with secrets masked
 *
 * @internal
 */
export function redactUrl(value: string): string {
  return redactUserinfo(value).replace(SENSITIVE_PARAM, "$1***");
}

/**
 * Asserts that a string value is non-empty.
 *
 * @param value - The string to check
 * @param field - The field name (for error messages)
 * @param context - The provider/module context (for error messages)
 * @returns The validated non-empty string
 * @throws {InputValidationError} If the value is empty or only whitespace
 *
 * @internal
 */
export function requireNonEmpty(
  value: string,
  field: string,
  context: string,
): string {
  if (!value?.trim()) {
    throw new InputValidationError(
      `[${context}] ${field} is required but was empty.`,
    );
  }
  return value;
}

/**
 * Asserts that a string is a valid URL.
 *
 * @param value - The URL string to validate
 * @param field - The field name (for error messages)
 * @param context - The provider/module context (for error messages)
 * @returns The validated URL string
 * @throws {InputValidationError} If the value is not a valid URL; the quoted
 * value has credentials masked
 *
 * @internal
 */
export function requireValidURL(
  value: string,
  field: string,
  context: string,
): string {
  try {
    new URL(value);
    return value;
  } catch {
    throw new InputValidationError(
      `[${context}] Invalid ${field}: "${redactUrl(value)}". Must be a valid URL (e.g., http://localhost:11434/v1).`,
    );
  }
}

/**
 * Clamps a numeric value to be at least `min`, falling back to `fallback`
 * if the value is not a finite number.
 *
 * @param value - The number to clamp
 * @param fallback - The fallback value if input is not finite
 * @param min - The minimum allowed value (default: 0)
 * @returns A finite number >= min
 *
 * @internal
 */
export function clampPositive(
  value: number,
  fallback: number,
  min = 0,
): number {
  return Math.max(Number.isFinite(value) ? value : fallback, min);
}
