// =============================================================================
// Core (for building custom providers)
// =============================================================================

export { BaseProviderLlm } from "./core/base-provider-llm";
export { OpenAICompatibleLlm } from "./core/openai-compatible-llm";
export type { OpenAIClientConfig } from "./core/openai-compatible-llm";

// =============================================================================
// AI Gateway Provider
// =============================================================================

export { AIGatewayLlm } from "./providers/ai-gateway";
export { AIGateway } from "./providers/ai-gateway";
export {
  registerAIGateway,
  isAIGatewayRegistered,
} from "./providers/ai-gateway";

// =============================================================================
// OpenRouter Provider
// =============================================================================

export { OpenRouterLlm } from "./providers/openrouter";
export { OpenRouter } from "./providers/openrouter";
export {
  registerOpenRouter,
  isOpenRouterRegistered,
} from "./providers/openrouter";

// =============================================================================
// Types
// =============================================================================

export type {
  // Base types
  BaseProviderConfig,
  // AI Gateway types
  AIGatewayConfig,
  RegisterOptions,
  // OpenRouter types
  OpenRouterConfig,
  OpenRouterProviderPreferences,
  OpenRouterRegisterOptions,
  // Streaming types
  ToolCallAccumulator,
  StreamAccumulator,
  StreamChunkResult,
} from "./types";

// =============================================================================
// Constants
// =============================================================================

export {
  MODEL_PATTERNS,
  DEFAULT_BASE_URL,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_PATTERNS,
  PROVIDER_IDS,
} from "./constants";

// =============================================================================
// Configuration
// =============================================================================

export {
  // Multi-provider API
  setProviderConfig,
  getProviderConfig,
  resetProviderConfig,
  resetAllConfigs,
  // Legacy API (deprecated but still exported for backward compatibility)
  setConfig,
  getConfig,
  resetConfig,
} from "./config";

// =============================================================================
// Converters (for building custom providers)
// =============================================================================

export { convertRequest } from "./converters/request";
export {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "./converters/response";
