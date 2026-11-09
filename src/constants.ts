/**
 * Constants and default values for adk-llm-bridge.
 *
 * This module contains all constant values including default URLs,
 * timeouts, environment variable names, and model patterns. Provider URLs and
 * patterns are read from the provider definitions, so they cannot drift.
 */

import { AI_GATEWAY_DEFINITION } from "./providers/ai-gateway/definition.js";
import { OPENROUTER_DEFINITION } from "./providers/openrouter/definition.js";

// =============================================================================
// AI Gateway Constants
// =============================================================================

/**
 * Default base URL for the Vercel AI Gateway API. Equals the provider
 * definition's `defaultBaseURL` (a test keeps them in step); the literal type
 * is part of the public API.
 *
 * @see {@link https://vercel.com/ai-gateway|Vercel AI Gateway}
 */
export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * Default request timeout in milliseconds.
 *
 * @defaultValue 60000 (60 seconds)
 */
export const DEFAULT_TIMEOUT = 60_000;

/**
 * Default maximum number of retry attempts for failed requests.
 *
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
 * @example
 * ```typescript
 * MODEL_PATTERNS[0].test("anthropic/claude-sonnet-5.5"); // true
 * MODEL_PATTERNS[0].test("invalid"); // false
 * ```
 */
export const MODEL_PATTERNS: (string | RegExp)[] = [
  ...AI_GATEWAY_DEFINITION.modelPatterns,
];

// =============================================================================
// OpenRouter Constants
// =============================================================================

/**
 * Default base URL for the OpenRouter API. Equals the provider definition's
 * `defaultBaseURL` (a test keeps them in step); the literal type is part of
 * the public API.
 *
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
 * @example
 * ```typescript
 * OPENROUTER_MODEL_PATTERNS[0].test("anthropic/claude-sonnet-5.5"); // true
 * ```
 */
export const OPENROUTER_MODEL_PATTERNS: (string | RegExp)[] = [
  ...OPENROUTER_DEFINITION.modelPatterns,
];

// =============================================================================
// Provider Identifiers
// =============================================================================

/**
 * Unique identifiers for each provider.
 *
 * The ids `setProviderConfig`, `getProviderConfig` and `resetProviderConfig`
 * take. Custom providers are not listed: they are registered by name.
 */
export const PROVIDER_IDS = {
  /** Identifier for the AI Gateway provider */
  AI_GATEWAY: "ai-gateway",

  /** Identifier for the OpenRouter provider */
  OPENROUTER: "openrouter",

  /** Identifier for the OpenAI provider */
  OPENAI: "openai",

  /** Identifier for the xAI provider */
  XAI: "xai",

  /** Identifier for the Anthropic provider */
  ANTHROPIC: "anthropic",
} as const;
