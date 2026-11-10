/**
 * Base LLM provider class for adk-llm-bridge.
 *
 * This module provides the abstract base class that all LLM providers extend.
 * It handles common functionality like error response creation and ADK integration.
 */

import type { BaseLlmConnection, LlmRequest, LlmResponse } from "@google/adk";
import { BaseLlm, InputValidationError } from "@google/adk";
import { getProviderConfig } from "../config.js";
import type { BaseProviderConfig, ErrorMode } from "../types.js";
import { LogCode, warnOnce } from "../utils/log.js";
import { httpStatusOf, ProviderLlmError } from "./provider-llm-error.js";

/**
 * Whether `model` matches one of `patterns` on the whole name, the way ADK's
 * `LLMRegistry.resolve` matches: each pattern is wrapped as `^(?:source)$`
 * with its own flags. `undefined` patterns accept any model.
 */
function matchesModelPatterns(
  model: string,
  patterns: readonly (string | RegExp)[] | undefined,
): boolean {
  if (patterns === undefined) return true;
  return patterns.some((pattern) =>
    new RegExp(
      `^(?:${pattern instanceof RegExp ? pattern.source : pattern})$`,
      pattern instanceof RegExp ? pattern.flags : undefined,
    ).test(model),
  );
}

/**
 * Abstract base class for all LLM providers in adk-llm-bridge.
 *
 * Extends ADK's `BaseLlm` and provides common infrastructure for error handling
 * and configuration management. All provider implementations (AI Gateway,
 * OpenRouter, custom providers) should extend this class.
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
   */
  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void>;

  /**
   * A copy of the request whose contents a provider can send as they are.
   *
   * @remarks
   * Contents with no parts are dropped (the converters send nothing for
   * them), then ADK's `maybeAppendUserContent` adds a user turn when no
   * contents remain or the last one is not from the user, as ADK's `GoogleLlm`
   * does. Many endpoints reject a request with no user message or one that
   * ends with an assistant turn. The caller's request is not changed.
   *
   * @param llmRequest - The request from ADK.
   * @returns A shallow copy with its own `contents` array.
   */
  protected withUserTurn(llmRequest: LlmRequest): LlmRequest {
    const request: LlmRequest = {
      ...llmRequest,
      contents: (llmRequest.contents ?? []).filter(
        (content) => content.parts?.length,
      ),
    };
    this.maybeAppendUserContent(request);
    return request;
  }

  /**
   * The model id to send for a request.
   *
   * @remarks
   * ADK sets `llmRequest.model` to the agent's model (this instance's
   * `model`), and a `beforeModelCallback` or plugin may rewrite it. The
   * rewrite is honored only when the id is one this provider accepts: it
   * matches one of `patterns` on the whole name, as ADK's `LLMRegistry`
   * matches (`^(?:pattern)$`). A prefixed id (`openai/gpt-4o` on OpenAI) or
   * another provider's id (`gpt-4o` on Anthropic) is never sent: this
   * instance's own `model` is sent instead and a
   * `[REQUEST_MODEL_IGNORED]` warning is logged once per process. A blank or
   * missing `llmRequest.model` silently means this instance's `model`.
   *
   * @param llmRequest - The request from ADK.
   * @param patterns - The provider's model patterns; `undefined` accepts any
   *   non-blank id (a provider configured by hand, such as `CustomLlm`).
   * @returns The id to put in the provider request.
   */
  protected requestModel(
    llmRequest: LlmRequest,
    patterns: readonly (string | RegExp)[] | undefined,
  ): string {
    const requested = llmRequest.model;
    if (typeof requested !== "string" || !requested.trim()) return this.model;
    if (requested === this.model) return this.model;
    if (matchesModelPatterns(requested, patterns)) return requested;
    warnOnce(
      LogCode.REQUEST_MODEL_IGNORED,
      `llmRequest.model ${JSON.stringify(requested)} is not a model id this ` +
        `provider accepts; sending ${JSON.stringify(this.model)} instead.`,
    );
    return this.model;
  }

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
   * @param options - `prefix` is the provider error prefix (e.g. `"OPENAI"`);
   *   `providerId` is the provider id for the global config lookup; `code`,
   *   when set, is used instead of the code derived from `error`.
   * @returns The error response (only in `"response"` mode)
   * @throws {@link ProviderLlmError} in `"throw"` mode
   */
  protected handleProviderError(
    error: unknown,
    options: { prefix: string; providerId: string; code?: string },
  ): LlmResponse {
    const response = this.createErrorResponse(
      error,
      options.prefix,
      options.code,
    );
    if (this.resolveErrorMode(options.providerId) === "response") {
      return response;
    }
    throw new ProviderLlmError({
      code: response.errorCode as string,
      detail: response.errorMessage as string,
      provider: options.providerId,
      status: httpStatusOf(error),
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
   * @param code - Code to use instead of the derived `API_ERROR_<status>` or
   *   `<prefix>_ERROR`
   * @returns An LlmResponse with error information and turnComplete: true
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
  protected createErrorResponse(
    error: unknown,
    prefix: string,
    code?: string,
  ): LlmResponse {
    const status = httpStatusOf(error);
    return {
      errorCode:
        code ??
        (status !== undefined ? `API_ERROR_${status}` : `${prefix}_ERROR`),
      errorMessage: error instanceof Error ? error.message : String(error),
      turnComplete: true,
    };
  }
}
