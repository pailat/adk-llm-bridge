/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Small, zero-dependency helpers for configuration boundaries.
 *
 * Configuration failures are thrown as ADK's `InputValidationError` (a plain
 * `Error` subclass) by the callers in `core/config-resolver.ts`,
 * `core/base-provider-llm.ts` and the providers; those messages never include
 * credentials. {@link redactUrl} masks secrets in URL-like text for messages
 * and logs.
 *
 * @module utils/validate
 */

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
