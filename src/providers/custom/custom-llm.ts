/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Custom LLM provider implementation.
 *
 * This module provides an LLM class for connecting to any API that implements
 * the OpenAI chat completions interface, such as Ollama, LM Studio, vLLM,
 * Azure OpenAI, or self-hosted models.
 *
 * @module providers/custom/custom-llm
 */

import {
  resolveConfig,
  type ResolvedConfig,
} from "../../core/config-resolver.js";
import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm.js";
import type { ProviderDefinition } from "../../core/provider-definition.js";
import type { CustomLlmConfig } from "../../types.js";

/**
 * Configuration for custom providers.
 *
 * `baseURL` may be supplied explicitly or through `CUSTOM_LLM_BASE_URL`.
 * `apiKey` is optional for unauthenticated local servers and otherwise falls
 * back to `CUSTOM_LLM_API_KEY`. Explicit values, including an explicitly empty
 * API key, take precedence over environment variables.
 */
export type CustomLlmProviderConfig = CustomLlmConfig;

const CUSTOM_DEFINITION: ProviderDefinition = {
  id: "custom",
  errorPrefix: "CUSTOM",
  defaultBaseURL: "",
  envKeys: {
    apiKey: ["CUSTOM_LLM_API_KEY"],
    baseURL: ["CUSTOM_LLM_BASE_URL"],
  },
  modelPatterns: [/.*/],
};

/** Resolve endpoint settings using the shared provider precedence model. */
export function resolveCustomConfig(
  config: CustomLlmProviderConfig,
): ResolvedConfig {
  return resolveConfig(CUSTOM_DEFINITION, config);
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
 *   model: "gpt-4",
 *   baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
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
   *
   * @static
   */
  static readonly supportedModels = [/.*/];

  /**
   * Provider name used for error prefixes.
   *
   * @private
   */
  private readonly providerName: string;

  /**
   * Provider-specific options to include in requests.
   *
   * @private
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
  constructor(config: CustomLlmProviderConfig) {
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
    });

    this.providerName = config.name ?? "CUSTOM";
    this.providerOptionsConfig = config.providerOptions;
  }

  /**
   * Returns the error prefix for this provider.
   *
   * Sanitizes the provider name to create a valid error code prefix.
   * For example, "my-provider" becomes "MY_PROVIDER".
   *
   * @returns The sanitized provider name in uppercase
   * @protected
   */
  protected getErrorPrefix(): string {
    const sanitized = this.providerName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_");
    return sanitized || "CUSTOM";
  }

  /**
   * Returns provider-specific options to include in requests.
   *
   * These options are spread into the chat completion request body,
   * allowing custom parameters beyond the standard OpenAI API.
   *
   * @returns The configured provider options or an empty object
   * @protected
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    return this.providerOptionsConfig ?? {};
  }
}
