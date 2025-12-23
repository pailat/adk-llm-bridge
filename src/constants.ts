// =============================================================================
// AI Gateway
// =============================================================================

export const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";
export const DEFAULT_TIMEOUT = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

// Match any model with format "provider/model"
// AI Gateway validates model availability at runtime
export const MODEL_PATTERNS: (string | RegExp)[] = [/^.+\/.+$/];

export const ENV = {
  AI_GATEWAY_URL: "AI_GATEWAY_URL",
  AI_GATEWAY_API_KEY: "AI_GATEWAY_API_KEY",
  OPENAI_BASE_URL: "OPENAI_BASE_URL",
  OPENAI_API_KEY: "OPENAI_API_KEY",
} as const;

// =============================================================================
// OpenRouter
// =============================================================================

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter uses same provider/model pattern as AI Gateway
export const OPENROUTER_MODEL_PATTERNS: (string | RegExp)[] = [/^.+\/.+$/];

export const OPENROUTER_ENV = {
  API_KEY: "OPENROUTER_API_KEY",
  SITE_URL: "OPENROUTER_SITE_URL",
  APP_NAME: "OPENROUTER_APP_NAME",
} as const;

// =============================================================================
// Provider IDs
// =============================================================================

export const PROVIDER_IDS = {
  AI_GATEWAY: "ai-gateway",
  OPENROUTER: "openrouter",
} as const;
