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
 * @module utils/validate
 */

/**
 * Asserts that a string value is non-empty.
 *
 * @param value - The string to check
 * @param field - The field name (for error messages)
 * @param context - The provider/module context (for error messages)
 * @returns The validated non-empty string
 * @throws {Error} If the value is empty or only whitespace
 *
 * @internal
 */
export function requireNonEmpty(
  value: string,
  field: string,
  context: string,
): string {
  if (!value?.trim()) {
    throw new Error(`[${context}] ${field} is required but was empty.`);
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
 * @throws {Error} If the value is not a valid URL
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
    throw new Error(
      `[${context}] Invalid ${field}: "${value}". Must be a valid URL (e.g., http://localhost:11434/v1).`,
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
