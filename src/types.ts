/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Type definitions for adk-llm-bridge.
 *
 * This module contains all TypeScript interfaces and types used throughout
 * the library for configuration, streaming, and provider-specific options.
 *
 * @module types
 */

import type { LlmResponse } from "@google/adk";

// =============================================================================
// Base Provider Types
// =============================================================================

/**
 * Base configuration shared by all LLM providers.
 *
 * All provider-specific configurations extend this interface.
 *
 * @example
 * ```typescript
 * const config: BaseProviderConfig = {
 *   model: "anthropic/claude-sonnet-4",
 *   apiKey: "your-api-key",
 *   timeout: 30000
 * };
 * ```
 */
export interface BaseProviderConfig {
  /**
   * The model identifier in provider/model format.
   *
   * @example "anthropic/claude-sonnet-4"
   * @example "openai/gpt-4o"
   */
  model: string;

  /**
   * Base URL for the API endpoint.
   *
   * @defaultValue Provider-specific default URL
   */
  baseURL?: string;

  /**
   * API key for authentication.
   *
   * @defaultValue Value from environment variables
   */
  apiKey?: string;

  /**
   * Request timeout in milliseconds.
   *
   * @defaultValue 60000 (60 seconds)
   */
  timeout?: number;

  /**
   * Maximum number of retry attempts for failed requests.
   *
   * @defaultValue 2
   */
  maxRetries?: number;
}

// =============================================================================
// AI Gateway Types
// =============================================================================

/**
 * Configuration options for the AI Gateway (Vercel) provider.
 *
 * Extends {@link BaseProviderConfig} with no additional options.
 * AI Gateway uses standard OpenAI-compatible configuration.
 *
 * @example
 * ```typescript
 * const config: AIGatewayConfig = {
 *   model: "anthropic/claude-sonnet-4",
 *   apiKey: process.env.AI_GATEWAY_API_KEY
 * };
 * ```
 *
 * @see {@link BaseProviderConfig} for inherited options
 */
export interface AIGatewayConfig extends BaseProviderConfig {}

/**
 * Options for registering AI Gateway with ADK's LLMRegistry.
 *
 * These options apply to all models created through the registry.
 *
 * @example
 * ```typescript
 * registerAIGateway({
 *   apiKey: process.env.AI_GATEWAY_API_KEY,
 *   baseURL: "https://custom-gateway.example.com/v1"
 * });
 * ```
 */
export interface RegisterOptions {
  /**
   * Base URL for the API endpoint.
   *
   * @defaultValue "https://ai-gateway.vercel.sh/v1"
   */
  baseURL?: string;

  /**
   * API key for authentication.
   *
   * @defaultValue process.env.AI_GATEWAY_API_KEY || process.env.OPENAI_API_KEY
   */
  apiKey?: string;
}

// =============================================================================
// OpenRouter Types
// =============================================================================

/**
 * OpenRouter provider routing preferences.
 *
 * Controls how OpenRouter selects and routes requests to underlying providers.
 * These preferences are sent as part of the request body.
 *
 * @see {@link https://openrouter.ai/docs#provider-routing|OpenRouter Provider Routing}
 *
 * @example
 * ```typescript
 * const preferences: OpenRouterProviderPreferences = {
 *   order: ["Anthropic", "Google"],
 *   allow_fallbacks: true,
 *   sort: "price"
 * };
 * ```
 */
export interface OpenRouterProviderPreferences {
  /**
   * Preferred provider order.
   *
   * Providers are tried in this order before falling back to others.
   *
   * @example ["Anthropic", "Google", "OpenAI"]
   */
  order?: string[];

  /**
   * Allow fallback to other providers if preferred ones are unavailable.
   *
   * @defaultValue true
   */
  allow_fallbacks?: boolean;

  /**
   * Require providers to support all parameters in the request.
   *
   * If true, providers that don't support certain parameters will be skipped.
   */
  require_parameters?: boolean;

  /**
   * Data collection policy for the request.
   *
   * - `"allow"`: Allow providers to use data for training
   * - `"deny"`: Prevent data collection
   */
  data_collection?: "allow" | "deny";

  /**
   * Sort available providers by criteria.
   *
   * - `"price"`: Cheapest first
   * - `"throughput"`: Highest throughput first
   * - `"latency"`: Lowest latency first
   */
  sort?: "price" | "throughput" | "latency";

  /**
   * Only use these providers.
   *
   * Requests will fail if none of these providers are available.
   *
   * @example ["Anthropic"]
   */
  only?: string[];

  /**
   * Never use these providers.
   *
   * @example ["Together", "Fireworks"]
   */
  ignore?: string[];
}

/**
 * Configuration options for the OpenRouter provider.
 *
 * Extends {@link BaseProviderConfig} with OpenRouter-specific options
 * for site attribution and provider routing.
 *
 * @example
 * ```typescript
 * const config: OpenRouterConfig = {
 *   model: "anthropic/claude-sonnet-4",
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   siteUrl: "https://myapp.com",
 *   appName: "My Application",
 *   provider: {
 *     sort: "price",
 *     allow_fallbacks: true
 *   }
 * };
 * ```
 *
 * @see {@link BaseProviderConfig} for inherited options
 * @see {@link OpenRouterProviderPreferences} for routing options
 */
export interface OpenRouterConfig extends BaseProviderConfig {
  /**
   * Your site URL for OpenRouter leaderboard rankings.
   *
   * Sent as the `HTTP-Referer` header. Sites with more usage rank higher.
   *
   * @example "https://myapp.com"
   */
  siteUrl?: string;

  /**
   * Your application name for OpenRouter leaderboard rankings.
   *
   * Sent as the `X-Title` header. Appears in OpenRouter's app rankings.
   *
   * @example "My AI Assistant"
   */
  appName?: string;

  /**
   * Provider routing preferences.
   *
   * Controls how OpenRouter selects providers for this request.
   *
   * @see {@link OpenRouterProviderPreferences}
   */
  provider?: OpenRouterProviderPreferences;
}

/**
 * Options for registering OpenRouter with ADK's LLMRegistry.
 *
 * These options apply to all models created through the registry.
 *
 * @example
 * ```typescript
 * registerOpenRouter({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   siteUrl: "https://myapp.com",
 *   appName: "My Application"
 * });
 * ```
 */
export interface OpenRouterRegisterOptions {
  /**
   * Base URL for the API endpoint.
   *
   * @defaultValue "https://openrouter.ai/api/v1"
   */
  baseURL?: string;

  /**
   * API key for authentication.
   *
   * @defaultValue process.env.OPENROUTER_API_KEY
   */
  apiKey?: string;

  /**
   * Your site URL for OpenRouter leaderboard rankings.
   *
   * @example "https://myapp.com"
   */
  siteUrl?: string;

  /**
   * Your application name for OpenRouter leaderboard rankings.
   *
   * @example "My AI Assistant"
   */
  appName?: string;
}

// =============================================================================
// Custom LLM Provider Types
// =============================================================================

/**
 * Configuration options for custom LLM providers.
 *
 * Use this to connect any API that implements the OpenAI chat completions
 * interface, such as Ollama, LM Studio, vLLM, Azure OpenAI, or self-hosted models.
 *
 * @example
 * ```typescript
 * // Ollama
 * const config: CustomLlmConfig = {
 *   name: "ollama",
 *   model: "llama3",
 *   baseURL: "http://localhost:11434/v1"
 * };
 * ```
 *
 * @example
 * ```typescript
 * // Azure OpenAI
 * const config: CustomLlmConfig = {
 *   name: "azure",
 *   model: "gpt-4",
 *   baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
 *   headers: { "api-key": process.env.AZURE_API_KEY },
 *   queryParams: { "api-version": "2024-02-01" }
 * };
 * ```
 *
 * @see {@link BaseProviderConfig} for inherited options
 * @see {@link createCustomLlm} for the factory function
 */
export interface CustomLlmConfig extends BaseProviderConfig {
  /**
   * Provider name for identification in logs and error messages.
   *
   * Used to generate error codes like `OLLAMA_ERROR` or `AZURE_ERROR`.
   *
   * @defaultValue "CUSTOM"
   * @example "ollama"
   * @example "azure"
   * @example "vllm"
   */
  name?: string;

  /**
   * Additional HTTP headers to include in all requests.
   *
   * Useful for custom authentication schemes or provider-specific headers.
   *
   * @example
   * ```typescript
   * headers: {
   *   "api-key": process.env.AZURE_API_KEY,
   *   "X-Custom-Header": "value"
   * }
   * ```
   */
  headers?: Record<string, string>;

  /**
   * Query parameters to append to all API requests.
   *
   * Required by some providers like Azure OpenAI for API versioning.
   *
   * @example
   * ```typescript
   * queryParams: {
   *   "api-version": "2024-02-01"
   * }
   * ```
   */
  queryParams?: Record<string, string>;

  /**
   * Additional options to include in the request body.
   *
   * These are spread into the chat completion request, allowing
   * provider-specific parameters beyond the standard OpenAI API.
   *
   * @example
   * ```typescript
   * providerOptions: {
   *   temperature: 0.7,
   *   custom_field: "value"
   * }
   * ```
   */
  providerOptions?: Record<string, unknown>;
}

// =============================================================================
// OpenAI Provider Types
// =============================================================================

/**
 * Configuration options for the OpenAI provider.
 *
 * Extends {@link BaseProviderConfig} with OpenAI-specific options
 * for organization and project identification.
 *
 * @example
 * ```typescript
 * const config: OpenAIProviderConfig = {
 *   model: "gpt-4.1",
 *   apiKey: process.env.OPENAI_API_KEY,
 *   organization: "org-xxx",
 *   project: "proj-xxx"
 * };
 * ```
 *
 * @see {@link BaseProviderConfig} for inherited options
 * @see {@link OpenAI} for the factory function
 */
export interface OpenAIProviderConfig extends BaseProviderConfig {
  /**
   * OpenAI organization ID.
   *
   * Sent as the `OpenAI-Organization` header for organization-scoped requests.
   *
   * @example "org-xxx"
   */
  organization?: string;

  /**
   * OpenAI project ID.
   *
   * Sent as the `OpenAI-Project` header for project-scoped requests.
   *
   * @example "proj-xxx"
   */
  project?: string;
}

/**
 * Options for registering OpenAI with ADK's LLMRegistry.
 *
 * These options apply to all models created through the registry.
 *
 * @example
 * ```typescript
 * registerOpenAI({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   organization: "org-xxx"
 * });
 * ```
 */
export interface OpenAIRegisterOptions {
  /**
   * API key for authentication.
   *
   * @defaultValue process.env.OPENAI_API_KEY
   */
  apiKey?: string;

  /**
   * OpenAI organization ID.
   *
   * @example "org-xxx"
   */
  organization?: string;

  /**
   * OpenAI project ID.
   *
   * @example "proj-xxx"
   */
  project?: string;
}

// =============================================================================
// xAI Provider Types
// =============================================================================

/**
 * Configuration options for the xAI (Grok) provider.
 *
 * Extends {@link BaseProviderConfig} with no additional options.
 * xAI uses standard OpenAI-compatible configuration.
 *
 * @example
 * ```typescript
 * const config: XAIProviderConfig = {
 *   model: "grok-4",
 *   apiKey: process.env.XAI_API_KEY
 * };
 * ```
 *
 * @see {@link BaseProviderConfig} for inherited options
 * @see {@link XAI} for the factory function
 */
export interface XAIProviderConfig extends BaseProviderConfig {}

/**
 * Options for registering xAI with ADK's LLMRegistry.
 *
 * These options apply to all models created through the registry.
 *
 * @example
 * ```typescript
 * registerXAI({
 *   apiKey: process.env.XAI_API_KEY
 * });
 * ```
 */
export interface XAIRegisterOptions {
  /**
   * API key for authentication.
   *
   * @defaultValue process.env.XAI_API_KEY
   */
  apiKey?: string;
}

// =============================================================================
// Streaming Types (shared)
// =============================================================================

/**
 * Accumulator for tool call data during streaming.
 *
 * Used internally to collect partial tool call information
 * as chunks arrive from the API.
 *
 * @internal
 */
export interface ToolCallAccumulator {
  /** Unique identifier for the tool call */
  id: string;

  /** Name of the function being called */
  name: string;

  /** JSON string of accumulated function arguments */
  arguments: string;
}

/**
 * Accumulator state for streaming responses.
 *
 * Tracks the accumulated text and tool calls across multiple stream chunks.
 * Created using {@link createStreamAccumulator}.
 *
 * @example
 * ```typescript
 * const accumulator = createStreamAccumulator();
 *
 * for await (const chunk of stream) {
 *   const result = convertStreamChunk(chunk, accumulator);
 *   if (result.isComplete) {
 *     return result.response;
 *   }
 * }
 * ```
 *
 * @see {@link createStreamAccumulator}
 * @see {@link convertStreamChunk}
 */
export interface StreamAccumulator {
  /** Accumulated text content from all chunks */
  text: string;

  /** Map of tool call index to accumulated tool call data */
  toolCalls: Map<number, ToolCallAccumulator>;
}

/**
 * Result from processing a stream chunk.
 *
 * Contains either a partial update or the final complete response.
 *
 * @see {@link convertStreamChunk}
 */
export interface StreamChunkResult {
  /**
   * The LLM response, present when chunk contains meaningful content.
   *
   * For intermediate chunks, this may be a partial response.
   * For the final chunk, this is the complete accumulated response.
   */
  response?: LlmResponse;

  /**
   * Whether the stream has completed.
   *
   * When `true`, the `response` contains the final accumulated result.
   */
  isComplete: boolean;
}
