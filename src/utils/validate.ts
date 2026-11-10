/**
 * Small helpers for configuration boundaries.
 *
 * Configuration failures are thrown as ADK's `InputValidationError` (a plain
 * `Error` subclass), here and by the callers in `core/config-resolver.ts`,
 * `core/base-provider-llm.ts` and the providers; those messages never include
 * credentials or the configured URL.
 */

import { InputValidationError } from "@google/adk";

/**
 * Clamps a numeric value to be at least `min`, falling back to `fallback`
 * if the value is not a finite number.
 *
 * @param value - The number to clamp
 * @param fallback - The fallback value if input is not finite
 * @param min - The minimum allowed value (default: 0)
 * @returns A finite number ≥ min
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

/**
 * Largest `timeout` in milliseconds. The SDKs pass it to `setTimeout`, which
 * stores a signed 32-bit delay: a larger value overflows and fires at once,
 * aborting every request.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Integer options checked at every config boundary, with their upper bound
 * (`undefined` for none).
 */
const INTEGER_OPTION_MAX: Readonly<Record<string, number | undefined>> = {
  timeout: MAX_TIMEOUT_MS,
  maxRetries: undefined,
  maxTokens: undefined,
};

/** Input to {@link resolveIntegerOption}. */
export interface IntegerOptionInput {
  /** Provider id shown in the error, for example `anthropic`. */
  owner: string;
  /** Option name shown in the error, for example `maxRetries`. */
  name: string;
  /** Configured value; `undefined` or `null` means unset. */
  value: unknown;
  /** Value used when `value` is unset. */
  fallback: number;
  /** Smallest accepted value; a smaller integer is raised to it. */
  min: number;
  /** Largest accepted value; a larger one throws. Default: no limit. */
  max?: number;
}

function describeValue(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Throws when a set option is not an integer or is above `max`.
 * `undefined` and `null` count as unset and pass.
 */
function checkIntegerOption(
  owner: string,
  name: string,
  value: unknown,
  max: number | undefined,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InputValidationError(
      `[${owner}] ${name} must be an integer, got ${describeValue(value)}.`,
    );
  }
  if (max !== undefined && value > max) {
    throw new InputValidationError(
      `[${owner}] ${name} must be at most ${max}, got ${value}.`,
    );
  }
}

/**
 * Checks the integer options (`timeout`, `maxRetries`, `maxTokens`) of a
 * register call before they are stored as global config, so a bad value
 * fails at `register*()` and not later, inside an agent run.
 *
 * @param owner - Provider id shown in the error.
 * @param options - The register options; other fields are ignored.
 * @throws {@link InputValidationError} under the same rules as
 *   {@link resolveIntegerOption}.
 *
 * @internal
 */
export function checkIntegerOptions(owner: string, options: object): void {
  const values = options as Record<string, unknown>;
  for (const [name, max] of Object.entries(INTEGER_OPTION_MAX)) {
    checkIntegerOption(owner, name, values[name], max);
  }
}

/**
 * Resolves an integer config option such as `timeout`, `maxRetries` or
 * `maxTokens`.
 *
 * @remarks
 * A value that is not an integer (a fraction, `NaN`, an infinity or a
 * non-number) is a configuration mistake and throws, because the SDKs would
 * otherwise round it, reject it with their own error type, or ignore it. So
 * does a value above `max`. An integer below `min` is a value out of range
 * and is clamped to `min`, as before. `null` counts as unset, wherever it is
 * set.
 *
 * @param input - The option and its bounds.
 * @returns `fallback` when unset, otherwise the integer, at least `min`.
 * @throws {@link InputValidationError} when the value is set and is not an
 *   integer, or is above `max`.
 *
 * @internal
 */
export function resolveIntegerOption(input: IntegerOptionInput): number {
  checkIntegerOption(input.owner, input.name, input.value, input.max);
  if (input.value === undefined || input.value === null) {
    return Math.max(input.fallback, input.min);
  }
  return clampPositive(input.value as number, input.fallback, input.min);
}
