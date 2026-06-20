/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI-compatible LLM base class.
 *
 * This module provides the base class for LLM providers that use
 * OpenAI-compatible APIs (chat completions endpoint). Providers can
 * be created either by extending this class or by using a declarative
 * {@link ProviderDefinition}.
 *
 * @module core/openai-compatible-llm
 */

import type { LlmRequest, LlmResponse } from "@google/adk";
import OpenAI from "openai";
import { convertRequest } from "../converters/request.js";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../converters/response.js";
import type { BaseProviderConfig } from "../types.js";
import { BaseProviderLlm } from "./base-provider-llm.js";
import { resolveConfig } from "./config-resolver.js";
import type { ProviderDefinition } from "./provider-definition.js";

/**
 * Configuration for the underlying OpenAI client.
 *
 * These options are passed directly to the OpenAI SDK constructor.
 */
export interface OpenAIClientConfig {
  /** Base URL for the API endpoint. */
  baseURL: string;
  /** API key for authentication. */
  apiKey: string;
  /** Request timeout in milliseconds. */
  timeout: number;
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Additional HTTP headers to include in all requests. */
  defaultHeaders?: Record<string, string>;
}

/**
 * Base class for LLM providers that use OpenAI-compatible APIs.
 *
 * Supports two construction modes:
 *
 * 1. **Declarative** (recommended): Pass a {@link ProviderDefinition} that
 *    describes the provider's configuration. Config resolution is automatic.
 *
 * 2. **Manual**: Pass a {@link BaseProviderConfig} + {@link OpenAIClientConfig}
 *    with pre-resolved values. Used by CustomLlm which has unique URL logic.
 *
 * @example
 * ```typescript
 * // Declarative (most providers)
 * const llm = new OpenAICompatibleLlm(MY_DEFINITION, { model: "gpt-4o" });
 *
 * // Manual (Custom provider)
 * class CustomLlm extends OpenAICompatibleLlm {
 *   constructor(config) {
 *     super(config, { baseURL, apiKey, timeout, maxRetries });
 *   }
 * }
 * ```
 */
export class OpenAICompatibleLlm extends BaseProviderLlm {
  /** Model patterns for LLMRegistry — set by createProviderClass(). */
  static supportedModels: (string | RegExp)[] = [];

  /** @protected */
  protected readonly client: OpenAI;

  private readonly _errorPrefix: string;
  private readonly _getRequestOptions?: () => Record<string, unknown>;

  /** Declarative constructor: definition + config */
  constructor(definition: ProviderDefinition, config: BaseProviderConfig);
  /** Manual constructor: config + clientConfig (for CustomLlm) */
  constructor(config: BaseProviderConfig, clientConfig: OpenAIClientConfig);
  constructor(
    first: ProviderDefinition | BaseProviderConfig,
    second: BaseProviderConfig | OpenAIClientConfig,
  ) {
    // Detect which overload: ProviderDefinition has 'id', BaseProviderConfig has 'model'
    if ("id" in first && "model" in second) {
      // Declarative mode
      const definition = first as ProviderDefinition;
      const config = second as BaseProviderConfig;

      super(config);
      this._errorPrefix = definition.errorPrefix;

      const resolved = resolveConfig(definition, config);
      this.client = new OpenAI({
        baseURL: resolved.baseURL,
        apiKey: resolved.apiKey,
        timeout: resolved.timeout,
        maxRetries: resolved.maxRetries,
        defaultHeaders: Object.keys(resolved.headers).length
          ? resolved.headers
          : undefined,
      });

      if (definition.buildRequestOptions) {
        const buildFn = definition.buildRequestOptions;
        const configRef = config as unknown as Record<string, unknown>;
        this._getRequestOptions = () => buildFn(configRef);
      }
    } else {
      // Manual mode (CustomLlm)
      const config = first as BaseProviderConfig;
      const clientConfig = second as OpenAIClientConfig;

      super(config);
      this._errorPrefix = "CUSTOM";
      this.client = new OpenAI({
        baseURL: clientConfig.baseURL,
        // OpenAI SDK v6.37 requires a non-empty credential at construction
        // time. Custom OpenAI-compatible providers such as Ollama, vLLM, and
        // LM Studio often do not require API keys, so use a harmless dummy key
        // only for manual/custom mode when the caller intentionally omitted one.
        apiKey: clientConfig.apiKey || "adk-llm-bridge-custom-provider",
        timeout: clientConfig.timeout,
        maxRetries: clientConfig.maxRetries,
        defaultHeaders: clientConfig.defaultHeaders,
      });
    }
  }

  /** Returns the provider error prefix. */
  protected getErrorPrefix(): string {
    return this._errorPrefix;
  }

  /** Returns provider-specific request options. */
  protected getProviderRequestOptions(): Record<string, unknown> {
    return this._getRequestOptions?.() ?? {};
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    try {
      const { messages, tools, params, toolChoice } = convertRequest(
        llmRequest,
        this.model,
      );

      if (stream) {
        yield* this.streamResponse(messages, tools, params, toolChoice);
      } else {
        yield await this.singleResponse(messages, tools, params, toolChoice);
      }
    } catch (error) {
      yield this.createErrorResponse(error, this.getErrorPrefix());
    }
  }

  private async singleResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
    params?: Record<string, unknown>,
    toolChoice?: OpenAI.ChatCompletionToolChoiceOption,
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...params,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
      ...this.getProviderRequestOptions(),
    });
    return convertResponse(response);
  }

  private async *streamResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
    params?: Record<string, unknown>,
    toolChoice?: OpenAI.ChatCompletionToolChoiceOption,
  ): AsyncGenerator<LlmResponse, void> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...params,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
      ...this.getProviderRequestOptions(),
    });

    const acc = createStreamAccumulator();

    // OpenAI with stream_options.include_usage emits the cumulative usage in a
    // SEPARATE, choices-empty chunk that arrives AFTER the finish chunk. If we
    // broke the loop on finish we would drop that usage. Instead, stash the
    // final (isComplete) response, keep draining the stream so the trailing
    // usage chunk is read into acc.usage, then merge and yield it last.
    let finalResponse: LlmResponse | undefined;

    for await (const chunk of stream) {
      const { response, isComplete } = convertStreamChunk(chunk, acc);
      if (isComplete) {
        // Hold the final response; do not break — a usage-only chunk may follow.
        finalResponse = response;
        continue;
      }
      if (response) yield response;
    }

    if (finalResponse) {
      // acc.usage is repopulated by a post-finish usage chunk (if any); prefer
      // it over whatever was captured before finish.
      if (acc.usage) finalResponse.usageMetadata = acc.usage;
      yield finalResponse;
    }
  }
}
