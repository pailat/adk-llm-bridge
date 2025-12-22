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
