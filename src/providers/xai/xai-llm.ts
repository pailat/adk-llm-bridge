/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * xAI (Grok) LLM provider implementation.
 *
 * This module provides the xAI-specific LLM class that connects
 * directly to xAI's API for Grok models.
 *
 * @module providers/xai/xai-llm
 */

import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import { getProviderConfig } from "../../config";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../../constants";
import type { XAIProviderConfig } from "../../types";
import { XAI_BASE_URL, XAI_ENV, XAI_MODEL_PATTERNS } from "./constants";

/**
 * xAI (Grok) LLM provider.
 *
 * Provides direct access to xAI's API for Grok models.
 * xAI's API is 100% OpenAI-compatible, using the same request/response format.
 *
 * Configuration priority (highest to lowest):
 * 1. Instance configuration (passed to constructor)
 * 2. Global configuration (via `setProviderConfig("xai", {...})`)
 * 3. Environment variables (`XAI_API_KEY`)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = new XAILlm({ model: "grok-4" });
 *
 * // With explicit API key
 * const llm = new XAILlm({
 *   model: "grok-4",
 *   apiKey: "xai-..."
 * });
 * ```
 *
 * @see {@link XAI} for the recommended factory function
 * @see {@link registerXAI} for LLMRegistry integration
 */
export class XAILlm extends OpenAICompatibleLlm {
  /**
   * Model patterns supported by this provider.
   *
   * Used by ADK's LLMRegistry to match model strings to this provider.
   * Matches: grok-*
   *
   * @static
   */
  static readonly supportedModels = XAI_MODEL_PATTERNS;

  /**
   * Creates a new xAI LLM instance.
   *
   * @param config - Configuration options for the xAI provider
   *
   * @example
   * ```typescript
   * const llm = new XAILlm({
   *   model: "grok-4",
   *   apiKey: process.env.XAI_API_KEY
   * });
   * ```
   */
  constructor(config: XAIProviderConfig) {
    const globalConfig = getProviderConfig("xai") ?? {};

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[XAI_ENV.API_KEY] ??
      "";

    super(config, {
      baseURL: XAI_BASE_URL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  /**
   * Returns the error prefix for xAI-specific errors.
   *
   * @returns "XAI"
   * @protected
   */
  protected getErrorPrefix(): string {
    return "XAI";
  }
}
