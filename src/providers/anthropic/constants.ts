/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Constants for the Anthropic (Claude) provider.
 *
 * @module providers/anthropic/constants
 */

/**
 * Anthropic API base URL.
 */
export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/**
 * Environment variable names for Anthropic configuration.
 */
export const ANTHROPIC_ENV = {
  API_KEY: "ANTHROPIC_API_KEY",
} as const;

/**
 * Default max tokens for Anthropic requests.
 *
 * Anthropic requires max_tokens to be specified in every request.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * Model patterns for Anthropic models.
 *
 * Matches:
 * - claude-* (claude-sonnet-4, claude-opus-4-5, claude-3-5-haiku, etc.)
 *
 * Note: Do not include ^ or $ anchors - ADK's LLMRegistry adds them automatically.
 */
export const ANTHROPIC_MODEL_PATTERNS = [/claude-.*/];
