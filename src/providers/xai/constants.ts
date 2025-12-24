/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Constants for the xAI (Grok) provider.
 *
 * @module providers/xai/constants
 */

/**
 * xAI API base URL.
 */
export const XAI_BASE_URL = "https://api.x.ai/v1";

/**
 * Environment variable names for xAI configuration.
 */
export const XAI_ENV = {
  API_KEY: "XAI_API_KEY",
} as const;

/**
 * Model patterns for xAI models.
 *
 * Matches:
 * - grok-* (grok-4, grok-3-beta, grok-code-fast-1, etc.)
 */
export const XAI_MODEL_PATTERNS = [/^grok-/];
