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

import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../../constants";
import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import type { CustomLlmConfig } from "../../types";

/**
 * Configuration type with required baseURL for custom providers.
 *
 * Unlike built-in providers (AI Gateway, OpenRouter) which have default URLs,
 * custom providers require an explicit baseURL.
 */
export type CustomLlmProviderConfig = CustomLlmConfig & {
  /**
   * Base URL for the API endpoint (required).
   *
   * @example "http://localhost:11434/v1" // Ollama
   * @example "http://localhost:8000/v1"  // vLLM
   * @example "https://my-resource.openai.azure.com/openai/deployments/gpt-4" // Azure
   */
  baseURL: string;
};

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
 * - Requires explicit `baseURL` configuration
 * - Does not use environment variables for defaults
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
   * @param config - Configuration options including model, baseURL, and optional settings
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
    // Build final URL with query params if provided
    let finalBaseURL = config.baseURL;
    if (config.queryParams && Object.keys(config.queryParams).length > 0) {
      try {
        // Use URL API for proper URL construction
        const url = new URL(config.baseURL);
        for (const [key, value] of Object.entries(config.queryParams)) {
          url.searchParams.append(key, value);
        }
        finalBaseURL = url.toString();
      } catch {
        // Fallback for non-standard URLs (e.g., localhost without protocol)
        const params = new URLSearchParams(config.queryParams);
        const separator = config.baseURL.includes("?") ? "&" : "?";
        finalBaseURL = `${config.baseURL}${separator}${params.toString()}`;
      }
    }

    super(config, {
      baseURL: finalBaseURL,
      apiKey: config.apiKey ?? "",
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
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
