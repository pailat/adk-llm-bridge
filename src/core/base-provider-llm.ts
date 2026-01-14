/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Base LLM provider class for adk-llm-bridge.
 *
 * This module provides the abstract base class that all LLM providers extend.
 * It handles common functionality like error response creation and ADK integration.
 *
 * @module core/base-provider-llm
 */

import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import { BaseLlm } from "@google/adk";
import type { BaseProviderConfig } from "../types";

/**
 * Abstract base class for all LLM providers in adk-llm-bridge.
 *
 * Extends ADK's `BaseLlm` and provides common infrastructure for error handling
 * and configuration management. All provider implementations (AI Gateway,
 * OpenRouter, custom providers) should extend this class.
 *
 * @abstract
 *
 * @example
 * ```typescript
 * class CustomLlm extends BaseProviderLlm {
 *   static supportedModels = [/^custom\/.+$/];
 *
 *   async *generateContentAsync(
 *     llmRequest: LlmRequest,
 *     stream?: boolean
 *   ): AsyncGenerator<LlmResponse, void> {
 *     try {
 *       // Implementation here
 *       yield response;
 *     } catch (error) {
 *       yield this.createErrorResponse(error, "CUSTOM");
 *     }
 *   }
 * }
 * ```
 *
 * @see {@link OpenAICompatibleLlm} for OpenAI-compatible API implementations
 */
export abstract class BaseProviderLlm extends BaseLlm {
  /**
   * Provider configuration.
   *
   * Contains the resolved configuration including model, API key, base URL, etc.
   *
   * @protected
   */
  protected readonly config: BaseProviderConfig;

  /**
   * Creates a new BaseProviderLlm instance.
   *
   * @param config - Provider configuration options
   */
  constructor(config: BaseProviderConfig) {
    super({ model: config.model });
    this.config = config;
  }

  /**
   * Generates content from the LLM.
   *
   * This is the main method that must be implemented by all providers.
   * It should handle both streaming and non-streaming responses.
   *
   * @param llmRequest - The ADK LLM request containing messages and tools
   * @param stream - Whether to stream the response (default: false)
   * @returns An async generator yielding LLM responses
   *
   * @abstract
   */
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void>;

  /**
   * Establishes a bidirectional streaming connection.
   *
   * This method is required by ADK's BaseLlm interface but is not supported
   * by OpenAI-compatible APIs. It always throws an error.
   *
   * @param _ - The LLM request (unused)
   * @returns Never - always throws
   * @throws Error indicating bidirectional streaming is not supported
   */
  async connect(_: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.constructor.name} does not support bidirectional streaming`,
    );
  }

  /**
   * Creates a standardized error response for ADK.
   *
   * Converts JavaScript errors into ADK-compatible LlmResponse objects
   * with appropriate error codes and messages.
   *
   * @param error - The error that occurred (Error instance or any value)
   * @param prefix - Provider-specific error prefix (e.g., "AI_GATEWAY", "OPENROUTER")
   * @returns An LlmResponse with error information and turnComplete: true
   *
   * @protected
   *
   * @example
   * ```typescript
   * try {
   *   // API call
   * } catch (error) {
   *   yield this.createErrorResponse(error, "MY_PROVIDER");
   *   // Returns: { errorCode: "MY_PROVIDER_ERROR", errorMessage: "...", turnComplete: true }
   * }
   * ```
   */
  protected createErrorResponse(error: unknown, prefix: string): LlmResponse {
    const isApiError =
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number";

    return {
      errorCode: isApiError
        ? `API_ERROR_${(error as { status: number }).status}`
        : `${prefix}_ERROR`,
      errorMessage: error instanceof Error ? error.message : String(error),
      turnComplete: true,
    };
  }
}
