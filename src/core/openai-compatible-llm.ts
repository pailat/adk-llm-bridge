/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI-compatible LLM base class.
 *
 * This module provides the base class for LLM providers that use
 * OpenAI-compatible APIs (chat completions endpoint).
 *
 * @module core/openai-compatible-llm
 */

import OpenAI from "openai";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { BaseProviderLlm } from "./base-provider-llm";
import { convertRequest } from "../converters/request";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../converters/response";
import type { BaseProviderConfig } from "../types";

/**
 * Configuration for the underlying OpenAI client.
 *
 * These options are passed directly to the OpenAI SDK constructor.
 */
export interface OpenAIClientConfig {
  /**
   * Base URL for the API endpoint.
   *
   * @example "https://ai-gateway.vercel.sh/v1"
   * @example "https://openrouter.ai/api/v1"
   */
  baseURL: string;

  /**
   * API key for authentication.
   */
  apiKey: string;

  /**
   * Request timeout in milliseconds.
   */
  timeout: number;

  /**
   * Maximum number of retry attempts.
   */
  maxRetries: number;

  /**
   * Additional HTTP headers to include in all requests.
   *
   * Useful for provider-specific headers like OpenRouter's site attribution.
   */
  defaultHeaders?: Record<string, string>;
}

/**
 * Base class for LLM providers that use OpenAI-compatible APIs.
 *
 * Handles the common logic for:
 * - Converting ADK requests to OpenAI format
 * - Making chat completion API calls
 * - Processing both streaming and non-streaming responses
 * - Converting responses back to ADK format
 *
 * Extend this class to implement support for any OpenAI-compatible API.
 *
 * @abstract
 *
 * @example
 * ```typescript
 * class MyProviderLlm extends OpenAICompatibleLlm {
 *   static supportedModels = [/^myprovider\/.+$/];
 *
 *   constructor(config: MyProviderConfig) {
 *     super(config, {
 *       baseURL: "https://api.myprovider.com/v1",
 *       apiKey: config.apiKey,
 *       timeout: config.timeout ?? 60000,
 *       maxRetries: config.maxRetries ?? 2
 *     });
 *   }
 *
 *   protected getErrorPrefix(): string {
 *     return "MY_PROVIDER";
 *   }
 * }
 * ```
 *
 * @see {@link BaseProviderLlm} for the parent class
 * @see {@link AIGatewayLlm} for AI Gateway implementation
 * @see {@link OpenRouterLlm} for OpenRouter implementation
 */
export abstract class OpenAICompatibleLlm extends BaseProviderLlm {
  /**
   * The OpenAI SDK client instance.
   *
   * @protected
   */
  protected readonly client: OpenAI;

  /**
   * Creates a new OpenAI-compatible LLM instance.
   *
   * @param config - Provider configuration (model, options)
   * @param clientConfig - OpenAI client configuration (URL, auth, timeouts)
   */
  constructor(config: BaseProviderConfig, clientConfig: OpenAIClientConfig) {
    super(config);
    this.client = new OpenAI({
      baseURL: clientConfig.baseURL,
      apiKey: clientConfig.apiKey,
      timeout: clientConfig.timeout,
      maxRetries: clientConfig.maxRetries,
      defaultHeaders: clientConfig.defaultHeaders,
    });
  }

  /**
   * Returns the provider-specific error prefix for error responses.
   *
   * Override in subclasses to return an appropriate prefix like
   * "AI_GATEWAY" or "OPENROUTER".
   *
   * @returns The error prefix string
   *
   * @abstract
   * @protected
   *
   * @example
   * ```typescript
   * protected getErrorPrefix(): string {
   *   return "MY_PROVIDER";
   * }
   * // Errors will have codes like "MY_PROVIDER_ERROR" or "API_ERROR_429"
   * ```
   */
  protected abstract getErrorPrefix(): string;

  /**
   * Returns provider-specific options to merge into chat completion requests.
   *
   * Override in subclasses to add provider-specific parameters.
   * The returned object is spread into the chat completion request body.
   *
   * @returns An object of additional request options
   *
   * @protected
   *
   * @example
   * ```typescript
   * protected getProviderRequestOptions(): Record<string, unknown> {
   *   return {
   *     provider: {
   *       order: ["Anthropic"],
   *       allow_fallbacks: true
   *     }
   *   };
   * }
   * ```
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    return {};
  }

  /**
   * Generates content from the LLM.
   *
   * Converts the ADK request to OpenAI format, makes the API call,
   * and converts the response back to ADK format.
   *
   * @param llmRequest - The ADK LLM request
   * @param stream - Whether to stream the response (default: false)
   * @returns An async generator yielding LLM responses
   *
   * @example
   * ```typescript
   * // Non-streaming
   * for await (const response of llm.generateContentAsync(request)) {
   *   console.log(response);
   * }
   *
   * // Streaming
   * for await (const response of llm.generateContentAsync(request, true)) {
   *   if (response.text) {
   *     process.stdout.write(response.text);
   *   }
   * }
   * ```
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    try {
      const { messages, tools } = convertRequest(llmRequest);

      if (stream) {
        yield* this.streamResponse(messages, tools);
      } else {
        yield await this.singleResponse(messages, tools);
      }
    } catch (error) {
      yield this.createErrorResponse(error, this.getErrorPrefix());
    }
  }

  /**
   * Makes a single (non-streaming) API request.
   *
   * @param messages - OpenAI format messages
   * @param tools - OpenAI format tools (optional)
   * @returns The converted LLM response
   *
   * @private
   */
  private async singleResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this.getProviderRequestOptions(),
    });
    return convertResponse(response);
  }

  /**
   * Makes a streaming API request and yields responses as they arrive.
   *
   * @param messages - OpenAI format messages
   * @param tools - OpenAI format tools (optional)
   * @returns An async generator yielding LLM responses
   *
   * @private
   */
  private async *streamResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): AsyncGenerator<LlmResponse, void> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      ...(tools?.length ? { tools } : {}),
      ...this.getProviderRequestOptions(),
    });

    const acc = createStreamAccumulator();

    for await (const chunk of stream) {
      const { response, isComplete } = convertStreamChunk(chunk, acc);
      if (response) yield response;
      if (isComplete) break;
    }
  }
}
