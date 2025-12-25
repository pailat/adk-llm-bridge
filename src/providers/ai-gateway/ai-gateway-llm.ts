/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * AI Gateway LLM implementation.
 *
 * This module provides the main LLM class for Vercel AI Gateway integration.
 *
 * @module providers/ai-gateway/ai-gateway-llm
 */

import { getProviderConfig } from "../../config";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  ENV,
  MODEL_PATTERNS,
} from "../../constants";
import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import type { AIGatewayConfig } from "../../types";

/**
 * LLM implementation for Vercel AI Gateway.
 *
 * Provides access to 100+ models from multiple providers (Anthropic, OpenAI, Google, etc.)
 * through a unified OpenAI-compatible API.
 *
 * Configuration is resolved in the following priority order:
 * 1. Instance configuration (constructor parameter)
 * 2. Global configuration (via `setProviderConfig("ai-gateway", ...)`)
 * 3. Environment variables (`AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`)
 * 4. Default values
 *
 * @example
 * ```typescript
 * // Direct instantiation
 * const llm = new AIGatewayLlm({
 *   model: "anthropic/claude-sonnet-4",
 *   apiKey: "your-api-key"
 * });
 *
 * // Use with ADK agent
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   llm: llm
 * });
 * ```
 *
 * @see {@link AIGateway} for the factory function alternative
 * @see {@link registerAIGateway} for ADK registry integration
 */
export class AIGatewayLlm extends OpenAICompatibleLlm {
  /**
   * Model patterns supported by AI Gateway.
   *
   * Matches any model in "provider/model" format (e.g., "anthropic/claude-sonnet-4").
   * Actual model availability is validated at runtime by the API.
   *
   * @static
   */
  static readonly supportedModels = MODEL_PATTERNS;

  /**
   * Creates a new AI Gateway LLM instance.
   *
   * @param config - Configuration options for the LLM
   *
   * @example
   * ```typescript
   * const llm = new AIGatewayLlm({
   *   model: "anthropic/claude-sonnet-4",
   *   apiKey: process.env.AI_GATEWAY_API_KEY,
   *   timeout: 30000
   * });
   * ```
   */
  constructor(config: AIGatewayConfig) {
    const globalConfig = getProviderConfig("ai-gateway") ?? {};

    const baseURL =
      config.baseURL ??
      globalConfig.baseURL ??
      process.env[ENV.AI_GATEWAY_URL] ??
      process.env[ENV.OPENAI_BASE_URL] ??
      DEFAULT_BASE_URL;

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[ENV.AI_GATEWAY_API_KEY] ??
      process.env[ENV.OPENAI_API_KEY] ??
      "";

    super(config, {
      baseURL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  /**
   * Returns the error prefix for AI Gateway errors.
   *
   * @returns "AI_GATEWAY"
   * @protected
   */
  protected getErrorPrefix(): string {
    return "AI_GATEWAY";
  }
}
