import type { RegisterOptions, OpenRouterRegisterOptions } from "./types";

type ProviderConfigMap = {
  "ai-gateway": RegisterOptions;
  openrouter: OpenRouterRegisterOptions;
};

type ProviderType = keyof ProviderConfigMap;

const configs: Partial<Record<ProviderType, ProviderConfigMap[ProviderType]>> =
  {};

// =============================================================================
// Multi-provider configuration API
// =============================================================================

/**
 * Sets configuration for a specific provider.
 *
 * @example
 * ```typescript
 * setProviderConfig("ai-gateway", { apiKey: "..." });
 * setProviderConfig("openrouter", { apiKey: "...", siteUrl: "https://myapp.com" });
 * ```
 */
export function setProviderConfig<T extends ProviderType>(
  provider: T,
  options: ProviderConfigMap[T],
): void {
  configs[provider] = { ...options };
}

/**
 * Gets configuration for a specific provider.
 */
export function getProviderConfig<T extends ProviderType>(
  provider: T,
): Readonly<ProviderConfigMap[T]> | undefined {
  return configs[provider] as ProviderConfigMap[T] | undefined;
}

/**
 * Resets configuration for a specific provider.
 */
export function resetProviderConfig(provider: ProviderType): void {
  delete configs[provider];
}

/**
 * Resets all provider configurations.
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
 * @deprecated Use `setProviderConfig("ai-gateway", options)` instead.
 */
export function setConfig(options: RegisterOptions): void {
  setProviderConfig("ai-gateway", options);
}

/**
 * Gets global configuration for AI Gateway.
 * @deprecated Use `getProviderConfig("ai-gateway")` instead.
 */
export function getConfig(): Readonly<RegisterOptions> {
  return getProviderConfig("ai-gateway") ?? {};
}

/**
 * Resets global configuration for AI Gateway.
 * @deprecated Use `resetProviderConfig("ai-gateway")` instead.
 */
export function resetConfig(): void {
  resetProviderConfig("ai-gateway");
}
