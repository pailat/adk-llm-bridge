/**
 * Custom LLM provider implementation.
 *
 * This module provides an LLM class for connecting to any API that implements
 * the OpenAI chat completions interface, such as Ollama, LM Studio, vLLM,
 * Azure OpenAI, or self-hosted models.
 */

import {
  type ResolvedConfig,
  resolveConfig,
} from "../../core/config-resolver.js";
import {
  isErrorPrefix,
  OpenAICompatibleLlm,
} from "../../core/openai-compatible-llm.js";
import type { ProviderDefinition } from "../../core/provider-definition.js";
import type { CustomProviderConfig } from "../../types.js";

/**
 * Former name of {@link CustomProviderConfig}.
 *
 * @deprecated Use {@link CustomProviderConfig}, the same type under the
 * `<Provider>ProviderConfig` naming scheme. This alias stays until the next
 * major version.
 */
export type CustomLlmProviderConfig = CustomProviderConfig;

const CUSTOM_DEFINITION: ProviderDefinition = {
  id: "custom",
  errorPrefix: "CUSTOM",
  defaultBaseURL: "",
  envKeys: {
    apiKey: ["CUSTOM_LLM_API_KEY"],
    baseURL: ["CUSTOM_LLM_BASE_URL"],
  },
  modelPatterns: [/.*/],
  envApiKeyOnlyWithEnvBaseURL: true,
};

/**
 * Resolve endpoint settings using the shared provider precedence model.
 *
 * @remarks
 * Security: `CUSTOM_LLM_API_KEY` is used only when the base URL itself comes
 * from `CUSTOM_LLM_BASE_URL`. A base URL set in configuration without a
 * configured `apiKey` (absent, `undefined` or `null`) resolves to no
 * credential, so the env key never reaches another host.
 */
export function resolveCustomConfig(
  config: CustomProviderConfig,
): ResolvedConfig {
  return resolveConfig(CUSTOM_DEFINITION, config);
}

/**
 * Error prefix for a custom provider's name: upper case, with every other
 * character than A-Z and 0-9 turned into `_` (`my-provider` gives
 * `MY_PROVIDER`), or `CUSTOM` when the name is unset or has no letter or
 * digit.
 */
function customErrorPrefix(name: string | undefined): string {
  const prefix = (name ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return isErrorPrefix(prefix) ? prefix : "CUSTOM";
}

/**
 * LLM implementation for any API that supports the chat completions interface.
 *
 * This provider allows connecting to any API that implements the OpenAI
 * chat completions interface. Use this for:
 *
 * - **Local models**: Ollama, LM Studio, vLLM, llama.cpp
 * - **Cloud providers**: Azure OpenAI, Together AI, Anyscale
 * - **Self-hosted**: Any compatible server
 *
 * Unlike AI Gateway and OpenRouter, this provider:
 * - Has no default endpoint; set `baseURL` or `CUSTOM_LLM_BASE_URL`
 * - Allows missing credentials for local servers
 * - Supports custom headers and query parameters
 *
 * @example
 * ```typescript
 * // Ollama
 * const llm = new CustomLlm({
 *   name: "ollama",
 *   model: "llama3",
 *   baseURL: "http://localhost:11434/v1"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Azure OpenAI
 * const llm = new CustomLlm({
 *   name: "azure",
 *   model: "gpt-6.1-sol",
 *   baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-6.1-sol",
 *   headers: { "api-key": process.env.AZURE_API_KEY },
 *   queryParams: { "api-version": "2024-02-01" }
 * });
 * ```
 *
 * @see {@link createCustomLlm} for the factory function
 * @see {@link Custom} for the shorthand alias
 */
export class CustomLlm extends OpenAICompatibleLlm {
  /**
   * Model patterns supported by this provider.
   *
   * Accepts any model identifier since different APIs use different naming conventions.
   */
  static readonly supportedModels = [/.*/];

  /**
   * Provider-specific options to include in requests.
   */
  private readonly providerOptionsConfig?: Record<string, unknown>;

  /**
   * Creates a new custom LLM provider instance.
   *
   * @param config - Configuration options including model and optional endpoint settings
   *
   * @example
   * ```typescript
   * const llm = new CustomLlm({
   *   name: "vllm",
   *   model: "meta-llama/Llama-3-8b",
   *   baseURL: "http://localhost:8000/v1"
   * });
   * ```
   */
  constructor(config: CustomProviderConfig) {
    const resolved = resolveCustomConfig(config);

    // Build final URL with query params if provided
    let finalBaseURL = resolved.baseURL;
    if (config.queryParams && Object.keys(config.queryParams).length > 0) {
      const url = new URL(resolved.baseURL);
      for (const [key, value] of Object.entries(config.queryParams)) {
        url.searchParams.append(key, value);
      }
      finalBaseURL = url.toString();
    }

    super(config, {
      baseURL: finalBaseURL,
      apiKey: resolved.apiKey,
      timeout: resolved.timeout,
      maxRetries: resolved.maxRetries,
      defaultHeaders: config.headers,
      errorPrefix: customErrorPrefix(config.name),
    });

    this.providerOptionsConfig = config.providerOptions;
  }

  /**
   * Returns provider-specific options to include in requests.
   *
   * These options are spread into the chat completion request body,
   * allowing custom parameters beyond the standard OpenAI API.
   *
   * @returns The configured provider options or an empty object
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    return this.providerOptionsConfig ?? {};
  }
}
