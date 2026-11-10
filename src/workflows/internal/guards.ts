/**
 * Small type guards shared by the workflow modules. Not exported from any
 * public barrel.
 */

/**
 * Checks for a non-null object that is not an array. Class instances and
 * objects with any prototype pass; use {@link isPlainRecord} for JSON-like
 * data.
 *
 * @param value - Value to check.
 * @returns True for a non-null, non-array object.
 * @internal
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks for a plain object: a non-array object whose prototype is
 * `Object.prototype` or `null`.
 *
 * @param value - Value to check.
 * @returns True for a plain object.
 * @internal
 */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Checks the `code` property of a thrown value, as Node file-system errors
 * carry it.
 *
 * @param error - Thrown value.
 * @param code - Expected code, such as `ENOENT`.
 * @returns True when `error` is an object whose `code` equals `code`.
 * @internal
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
