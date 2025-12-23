import type { LlmResponse } from "@google/adk";

// =============================================================================
// Base Provider Types
// =============================================================================

/** Base configuration shared by all providers */
export interface BaseProviderConfig {
  model: string;
  baseURL?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
}

// =============================================================================
// AI Gateway Types
// =============================================================================

export interface AIGatewayConfig extends BaseProviderConfig {}

export interface RegisterOptions {
  baseURL?: string;
  apiKey?: string;
}

// =============================================================================
// OpenRouter Types
// =============================================================================

/** OpenRouter provider routing preferences */
export interface OpenRouterProviderPreferences {
  /** Preferred provider order (e.g., ["Anthropic", "Google"]) */
  order?: string[];
  /** Allow fallback to other providers (default: true) */
  allow_fallbacks?: boolean;
  /** Require providers to support all parameters in request */
  require_parameters?: boolean;
  /** Data collection policy */
  data_collection?: "allow" | "deny";
  /** Sort providers by criteria */
  sort?: "price" | "throughput" | "latency";
  /** Only use these providers */
  only?: string[];
  /** Never use these providers */
  ignore?: string[];
}

export interface OpenRouterConfig extends BaseProviderConfig {
  /** Your site URL for OpenRouter ranking (sent as HTTP-Referer header) */
  siteUrl?: string;
  /** Your app name for OpenRouter ranking (sent as X-Title header) */
  appName?: string;
  /** Provider routing preferences */
  provider?: OpenRouterProviderPreferences;
}

export interface OpenRouterRegisterOptions {
  baseURL?: string;
  apiKey?: string;
  /** Your site URL for OpenRouter ranking */
  siteUrl?: string;
  /** Your app name for OpenRouter ranking */
  appName?: string;
}

// =============================================================================
// Streaming Types (shared)
// =============================================================================

export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamAccumulator {
  text: string;
  toolCalls: Map<number, ToolCallAccumulator>;
}

export interface StreamChunkResult {
  response?: LlmResponse;
  isComplete: boolean;
}
