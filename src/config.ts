/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Global configuration management for LLM providers.
 *
 * This module provides functions to set, get, and reset global configuration
 * that applies to all instances of a provider. Configuration set here acts
 * as a fallback when instance-specific configuration is not provided.
 *
 * Configuration priority (highest to lowest):
 * 1. Instance configuration (passed to constructor or factory)
 * 2. Global configuration (set via this module)
 * 3. Environment variables
 * 4. Default values
 *
 * @module config
 *
 * @example
 * ```typescript
 * import { setProviderConfig } from "adk-llm-bridge";
 *
 * // Set global config for AI Gateway
 * setProviderConfig("ai-gateway", {
 *   apiKey: process.env.AI_GATEWAY_API_KEY
 * });
 *
 * // Set global config for OpenRouter
 * setProviderConfig("openrouter", {
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   siteUrl: "https://myapp.com"
 * });
 * ```
 */

import type {
  RegisterOptions,
  OpenRouterRegisterOptions,
  OpenAIRegisterOptions,
  XAIRegisterOptions,
  AnthropicRegisterOptions,
} from "./types";

/**
 * Mapping of provider identifiers to their configuration types.
 *
 * @internal
 */
type ProviderConfigMap = {
  "ai-gateway": RegisterOptions;
  openrouter: OpenRouterRegisterOptions;
  openai: OpenAIRegisterOptions;
  xai: XAIRegisterOptions;
  anthropic: AnthropicRegisterOptions;
};

/**
 * Valid provider type identifiers.
 *
 * @internal
 */
type ProviderType = keyof ProviderConfigMap;

/** Internal storage for provider configurations */
const configs: Partial<Record<ProviderType, ProviderConfigMap[ProviderType]>> =
  {};

// =============================================================================
// Multi-provider Configuration API
// =============================================================================

/**
 * Sets global configuration for a specific provider.
 *
 * This configuration is used as a fallback when creating LLM instances
 * without explicit configuration. Instance configuration always takes
 * precedence over global configuration.
 *
 * @param provider - The provider identifier ("ai-gateway" or "openrouter")
 * @param options - Configuration options for the provider
 *
 * @example
 * ```typescript
 * // Configure AI Gateway globally
 * setProviderConfig("ai-gateway", {
 *   apiKey: "your-api-key",
 *   baseURL: "https://custom-gateway.example.com/v1"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Configure OpenRouter with site attribution
 * setProviderConfig("openrouter", {
 *   apiKey: "your-api-key",
 *   siteUrl: "https://myapp.com",
 *   appName: "My Application"
 * });
 * ```
 */
export function setProviderConfig<T extends ProviderType>(
  provider: T,
  options: ProviderConfigMap[T],
): void {
  configs[provider] = { ...options };
}

/**
 * Gets the current global configuration for a specific provider.
 *
 * @param provider - The provider identifier ("ai-gateway" or "openrouter")
 * @returns The current configuration, or `undefined` if not set
 *
 * @example
 * ```typescript
 * const config = getProviderConfig("ai-gateway");
 * if (config?.apiKey) {
 *   console.log("AI Gateway is configured");
 * }
 * ```
 */
export function getProviderConfig<T extends ProviderType>(
  provider: T,
): Readonly<ProviderConfigMap[T]> | undefined {
  return configs[provider] as ProviderConfigMap[T] | undefined;
}

/**
 * Resets the global configuration for a specific provider.
 *
 * After calling this, the provider will fall back to environment variables
 * or default values.
 *
 * @param provider - The provider identifier ("ai-gateway" or "openrouter")
 *
 * @example
 * ```typescript
 * resetProviderConfig("ai-gateway");
 * ```
 */
export function resetProviderConfig(provider: ProviderType): void {
  delete configs[provider];
}

/**
 * Resets all provider configurations.
 *
 * Useful for testing or when you need to clear all global state.
 *
 * @example
 * ```typescript
 * // In test teardown
 * afterEach(() => {
 *   resetAllConfigs();
 * });
 * ```
 */
export function resetAllConfigs(): void {
  for (const key of Object.keys(configs) as ProviderType[]) {
    delete configs[key];
  }
}

// =============================================================================
// Legacy API (backward compatible)
// =============================================================================

/**
 * Sets global configuration for AI Gateway.
 *
 * @param options - Configuration options
 *
 * @deprecated Use {@link setProviderConfig | setProviderConfig("ai-gateway", options)} instead.
 * This function will be removed in a future major version.
 *
 * @example
 * ```typescript
 * // Old way (deprecated)
 * setConfig({ apiKey: "..." });
 *
 * // New way
 * setProviderConfig("ai-gateway", { apiKey: "..." });
 * ```
 */
export function setConfig(options: RegisterOptions): void {
  setProviderConfig("ai-gateway", options);
}

/**
 * Gets global configuration for AI Gateway.
 *
 * @returns The current AI Gateway configuration
 *
 * @deprecated Use {@link getProviderConfig | getProviderConfig("ai-gateway")} instead.
 * This function will be removed in a future major version.
 */
export function getConfig(): Readonly<RegisterOptions> {
  return getProviderConfig("ai-gateway") ?? {};
}

/**
 * Resets global configuration for AI Gateway.
 *
 * @deprecated Use {@link resetProviderConfig | resetProviderConfig("ai-gateway")} instead.
 * This function will be removed in a future major version.
 */
export function resetConfig(): void {
  resetProviderConfig("ai-gateway");
}
