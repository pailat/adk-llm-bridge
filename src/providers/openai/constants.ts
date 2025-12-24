/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Constants for the OpenAI provider.
 *
 * @module providers/openai/constants
 */

/**
 * OpenAI API base URL.
 */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Environment variable names for OpenAI configuration.
 */
export const OPENAI_ENV = {
  API_KEY: "OPENAI_API_KEY",
  ORGANIZATION: "OPENAI_ORGANIZATION",
  PROJECT: "OPENAI_PROJECT",
} as const;

/**
 * Model patterns for OpenAI models.
 *
 * Matches:
 * - gpt-* (gpt-4, gpt-4o, gpt-4.1, etc.)
 * - o* followed by number (o1, o3, o4-mini, etc.)
 * - chatgpt-* (chatgpt-4o-latest, etc.)
 */
export const OPENAI_MODEL_PATTERNS = [/^gpt-/, /^o[0-9]/, /^chatgpt-/];
