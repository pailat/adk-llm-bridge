/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Constants and default values for adk-llm-bridge.
 *
 * This module contains all constant values including default URLs,
 * timeouts, environment variable names, and model patterns.
 *
 * @module constants
 */

// =============================================================================
// AI Gateway Constants
// =============================================================================

/**
 * Default base URL for the Vercel AI Gateway API.
 *
 * @constant
 * @see {@link https://vercel.com/ai-gateway|Vercel AI Gateway}
 */
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * Default request timeout in milliseconds.
 *
 * @constant
 * @defaultValue 60000 (60 seconds)
 */
export const DEFAULT_TIMEOUT = 60_000;

/**
 * Default maximum number of retry attempts for failed requests.
 *
 * @constant
 * @defaultValue 2
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Model patterns for AI Gateway model validation.
 *
 * Matches any model identifier with the format "provider/model".
 * AI Gateway validates actual model availability at runtime.
 *
 * Note: Do not include ^ or $ anchors - ADK's LLMRegistry adds them automatically.
 *
 * @constant
 * @example
 * ```typescript
 * MODEL_PATTERNS[0].test("anthropic/claude-sonnet-4"); // true
 * MODEL_PATTERNS[0].test("invalid"); // false
 * ```
 */
export const MODEL_PATTERNS: (string | RegExp)[] = [/.+\/.+/];

/**
 * Environment variable names for AI Gateway configuration.
 *
 * These environment variables are checked in order when resolving configuration.
 *
 * @constant
 *
 * @example
 * ```bash
 * # Set in your environment or .env file
 * export AI_GATEWAY_API_KEY="your-api-key"
 * export AI_GATEWAY_URL="https://custom-gateway.example.com/v1"
 * ```
 */
export const ENV = {
  /** Environment variable for AI Gateway URL override */
  AI_GATEWAY_URL: "AI_GATEWAY_URL",

  /** Environment variable for AI Gateway API key */
  AI_GATEWAY_API_KEY: "AI_GATEWAY_API_KEY",

  /** Fallback environment variable for base URL (OpenAI compatibility) */
  OPENAI_BASE_URL: "OPENAI_BASE_URL",

  /** Fallback environment variable for API key (OpenAI compatibility) */
  OPENAI_API_KEY: "OPENAI_API_KEY",
} as const;

// =============================================================================
// OpenRouter Constants
// =============================================================================

/**
 * Default base URL for the OpenRouter API.
 *
 * @constant
 * @see {@link https://openrouter.ai/docs|OpenRouter Documentation}
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Model patterns for OpenRouter model validation.
 *
 * Uses the same "provider/model" format as AI Gateway.
 *
 * Note: Do not include ^ or $ anchors - ADK's LLMRegistry adds them automatically.
 *
 * @constant
 * @example
 * ```typescript
 * OPENROUTER_MODEL_PATTERNS[0].test("anthropic/claude-sonnet-4"); // true
 * ```
 */
export const OPENROUTER_MODEL_PATTERNS: (string | RegExp)[] = [/.+\/.+/];

/**
 * Environment variable names for OpenRouter configuration.
 *
 * @constant
 *
 * @example
 * ```bash
 * # Set in your environment or .env file
 * export OPENROUTER_API_KEY="your-api-key"
 * export OPENROUTER_SITE_URL="https://myapp.com"
 * export OPENROUTER_APP_NAME="My Application"
 * ```
 */
export const OPENROUTER_ENV = {
  /** Environment variable for OpenRouter API key */
  API_KEY: "OPENROUTER_API_KEY",

  /** Environment variable for site URL (used for rankings) */
  SITE_URL: "OPENROUTER_SITE_URL",

  /** Environment variable for app name (used for rankings) */
  APP_NAME: "OPENROUTER_APP_NAME",
} as const;

// =============================================================================
// Provider Identifiers
// =============================================================================

/**
 * Unique identifiers for each provider.
 *
 * Used internally for configuration management and registry operations.
 *
 * @constant
 */
export const PROVIDER_IDS = {
  /** Identifier for the AI Gateway provider */
  AI_GATEWAY: "ai-gateway",

  /** Identifier for the OpenRouter provider */
  OPENROUTER: "openrouter",
} as const;
