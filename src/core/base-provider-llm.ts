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
import { BaseLlm, InputValidationError } from "@google/adk";
import { getProviderConfig } from "../config.js";
import type { BaseProviderConfig, ErrorMode } from "../types.js";
import { ProviderLlmError } from "./provider-llm-error.js";

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
 *     stream?: boolean,
 *     abortSignal?: AbortSignal
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
    if (!config.model?.trim()) {
      throw new InputValidationError(
        "[adk-llm-bridge] model is required and cannot be empty.",
      );
    }
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
   * @param abortSignal - Optional signal used to cancel the provider request
   * @returns An async generator yielding LLM responses
   *
   * @abstract
   */
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
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
   * Resolves the effective {@link ErrorMode}: instance config, then the global
   * provider config (`setProviderConfig`), then `"throw"`.
   *
   * @param providerId - Provider id used to look up the global config
   * @protected
   */
  protected resolveErrorMode(providerId: string): ErrorMode {
    const global = getProviderConfig(providerId as "ai-gateway") as
      | { errorMode?: ErrorMode }
      | undefined;
    return this.config.errorMode ?? global?.errorMode ?? "throw";
  }

  /**
   * Reports a failed provider call according to `errorMode`.
   *
   * Call it from the `catch` of `generateContentAsync`, after handling aborts:
   * `yield this.handleProviderError(error, { prefix, providerId })`.
   *
   * - `"response"`: returns the error `LlmResponse` (see
   *   {@link createErrorResponse}) for the caller to yield.
   * - `"throw"` (default): throws a {@link ProviderLlmError} whose `code` is the
   *   same code `"response"` would have used, so ADK events keep their
   *   `errorCode`, plugins' `onModelErrorCallback` runs, and `RoutedLlm` can
   *   fail over.
   *
   * @param error - The caught value
   * @param options.prefix - Provider error prefix (e.g. `"OPENAI"`)
   * @param options.providerId - Provider id for the global config lookup
   * @returns The error response (only in `"response"` mode)
   * @throws {ProviderLlmError} in `"throw"` mode
   * @protected
   */
  protected handleProviderError(
    error: unknown,
    options: { prefix: string; providerId: string },
  ): LlmResponse {
    const response = this.createErrorResponse(error, options.prefix);
    if (this.resolveErrorMode(options.providerId) === "response") {
      return response;
    }
    const status =
      error !== null &&
      typeof error === "object" &&
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined;
    throw new ProviderLlmError({
      code: response.errorCode as string,
      detail: response.errorMessage as string,
      provider: options.prefix,
      status,
      cause: error,
    });
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
