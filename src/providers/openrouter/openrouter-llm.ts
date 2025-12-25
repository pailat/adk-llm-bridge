/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenRouter LLM implementation.
 *
 * This module provides the main LLM class for OpenRouter integration.
 *
 * @module providers/openrouter/openrouter-llm
 */

import { getProviderConfig } from "../../config";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  OPENROUTER_BASE_URL,
  OPENROUTER_ENV,
  OPENROUTER_MODEL_PATTERNS,
} from "../../constants";
import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import type { OpenRouterConfig } from "../../types";

/**
 * LLM implementation for OpenRouter.
 *
 * Provides access to 100+ models with advanced features:
 * - Provider routing and fallbacks
 * - Price/latency/throughput optimization
 * - Site attribution for leaderboard rankings
 *
 * Configuration is resolved in the following priority order:
 * 1. Instance configuration (constructor parameter)
 * 2. Global configuration (via `setProviderConfig("openrouter", ...)`)
 * 3. Environment variables (`OPENROUTER_API_KEY`, etc.)
 * 4. Default values
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = new OpenRouterLlm({
 *   model: "anthropic/claude-sonnet-4",
 *   apiKey: process.env.OPENROUTER_API_KEY
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With site attribution and provider preferences
 * const llm = new OpenRouterLlm({
 *   model: "anthropic/claude-sonnet-4",
 *   siteUrl: "https://myapp.com",
 *   appName: "My App",
 *   provider: {
 *     sort: "latency",
 *     allow_fallbacks: true,
 *     only: ["Anthropic", "Google"]
 *   }
 * });
 * ```
 *
 * @see {@link OpenRouter} for the factory function alternative
 * @see {@link registerOpenRouter} for ADK registry integration
 * @see {@link OpenRouterConfig} for configuration options
 */
export class OpenRouterLlm extends OpenAICompatibleLlm {
  /**
   * Model patterns supported by OpenRouter.
   *
   * Matches any model in "provider/model" format (e.g., "anthropic/claude-sonnet-4").
   *
   * @static
   */
  static readonly supportedModels = OPENROUTER_MODEL_PATTERNS;

  /**
   * OpenRouter-specific configuration stored for request options.
   *
   * @private
   */
  private readonly openRouterConfig: OpenRouterConfig;

  /**
   * Creates a new OpenRouter LLM instance.
   *
   * @param config - Configuration options including model, API key, and provider preferences
   *
   * @example
   * ```typescript
   * const llm = new OpenRouterLlm({
   *   model: "anthropic/claude-sonnet-4",
   *   apiKey: process.env.OPENROUTER_API_KEY,
   *   provider: { sort: "price" }
   * });
   * ```
   */
  constructor(config: OpenRouterConfig) {
    const globalConfig = getProviderConfig("openrouter") ?? {};

    const baseURL =
      config.baseURL ?? globalConfig.baseURL ?? OPENROUTER_BASE_URL;

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[OPENROUTER_ENV.API_KEY] ??
      "";

    // Build default headers for OpenRouter ranking
    const defaultHeaders: Record<string, string> = {};

    const siteUrl =
      config.siteUrl ??
      globalConfig.siteUrl ??
      process.env[OPENROUTER_ENV.SITE_URL];

    const appName =
      config.appName ??
      globalConfig.appName ??
      process.env[OPENROUTER_ENV.APP_NAME];

    if (siteUrl) {
      defaultHeaders["HTTP-Referer"] = siteUrl;
    }
    if (appName) {
      defaultHeaders["X-Title"] = appName;
    }

    super(config, {
      baseURL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      defaultHeaders:
        Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });

    this.openRouterConfig = config;
  }

  /**
   * Returns the error prefix for OpenRouter errors.
   *
   * @returns "OPENROUTER"
   * @protected
   */
  protected getErrorPrefix(): string {
    return "OPENROUTER";
  }

  /**
   * Returns OpenRouter-specific request options.
   *
   * Includes provider preferences for routing control.
   *
   * @returns Object with provider preferences if configured
   * @protected
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    const options: Record<string, unknown> = {};

    if (this.openRouterConfig.provider) {
      options.provider = this.openRouterConfig.provider;
    }

    return options;
  }
}
