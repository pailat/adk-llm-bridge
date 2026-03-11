/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Declarative provider definition interface.
 *
 * Providers that use OpenAI-compatible APIs differ only in configuration
 * (URLs, env vars, headers), not behavior. This interface captures those
 * differences as data instead of requiring class inheritance.
 *
 * @module core/provider-definition
 */

/**
 * Environment variable keys for resolving provider configuration.
 */
export interface ProviderEnvKeys {
  /** Env var names to check for API key, in priority order */
  apiKey: string[];
  /** Env var names to check for base URL, in priority order */
  baseURL?: string[];
}

/**
 * Declarative definition for an OpenAI-compatible LLM provider.
 *
 * Instead of creating a subclass for each provider, define the provider
 * as a configuration object. The core infrastructure handles the rest.
 *
 * @example
 * ```typescript
 * const MY_PROVIDER: ProviderDefinition = {
 *   id: "my-provider",
 *   errorPrefix: "MY_PROVIDER",
 *   defaultBaseURL: "https://api.myprovider.com/v1",
 *   envKeys: { apiKey: ["MY_PROVIDER_API_KEY"] },
 *   modelPatterns: [/.+\/.+/],
 * };
 * ```
 */
export interface ProviderDefinition {
  /** Provider ID for the config system (e.g. "ai-gateway", "openrouter") */
  id: string;

  /** Error prefix for error codes (e.g. "AI_GATEWAY" → "AI_GATEWAY_ERROR") */
  errorPrefix: string;

  /** Default base URL when not specified in config or env vars */
  defaultBaseURL: string;

  /** Environment variable names to resolve for apiKey and baseURL */
  envKeys: ProviderEnvKeys;

  /** Model patterns for LLMRegistry matching */
  modelPatterns: (string | RegExp)[];

  /** Build custom HTTP headers from the instance config */
  buildHeaders?: (config: Record<string, unknown>) => Record<string, string>;

  /** Build provider-specific options to merge into request body */
  buildRequestOptions?: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
}
