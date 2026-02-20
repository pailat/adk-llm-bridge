/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Anthropic (Claude) LLM provider implementation.
 *
 * This module provides the Anthropic-specific LLM class that connects
 * directly to Anthropic's Messages API.
 *
 * @module providers/anthropic/anthropic-llm
 */

import AnthropicSDK from "@anthropic-ai/sdk";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { getProviderConfig } from "../../config";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../../constants";
import { BaseProviderLlm } from "../../core/base-provider-llm";
import type { AnthropicProviderConfig } from "../../types";
import {
  ANTHROPIC_ENV,
  ANTHROPIC_MODEL_PATTERNS,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from "./constants";
import { convertAnthropicRequest } from "./converters/request";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./converters/response";

/**
 * Anthropic (Claude) LLM provider.
 *
 * Provides direct access to Anthropic's Messages API for Claude models.
 * Unlike OpenAI-compatible providers, this uses the native Anthropic SDK
 * with custom request/response converters.
 *
 * Configuration priority (highest to lowest):
 * 1. Instance configuration (passed to constructor)
 * 2. Global configuration (via `setProviderConfig("anthropic", {...})`)
 * 3. Environment variables (`ANTHROPIC_API_KEY`)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = new AnthropicLlm({ model: "claude-sonnet-4-5-20250929" });
 *
 * // With max tokens
 * const llm = new AnthropicLlm({
 *   model: "claude-sonnet-4-5-20250929",
 *   apiKey: "...",
 *   maxTokens: 8192
 * });
 * ```
 *
 * @see {@link Anthropic} for the recommended factory function
 * @see {@link registerAnthropic} for LLMRegistry integration
 */
export class AnthropicLlm extends BaseProviderLlm {
  /**
   * Model patterns supported by this provider.
   *
   * Used by ADK's LLMRegistry to match model strings to this provider.
   * Matches: claude-*
   *
   * @static
   */
  static readonly supportedModels = ANTHROPIC_MODEL_PATTERNS;

  /**
   * The Anthropic SDK client instance.
   *
   * @private
   */
  private readonly client: AnthropicSDK;

  /**
   * Maximum tokens to generate in responses.
   *
   * @private
   */
  private readonly maxTokens: number;

  /**
   * Creates a new Anthropic LLM instance.
   *
   * @param config - Configuration options for the Anthropic provider
   *
   * @example
   * ```typescript
   * const llm = new AnthropicLlm({
   *   model: "claude-sonnet-4-5-20250929",
   *   apiKey: process.env.ANTHROPIC_API_KEY,
   *   maxTokens: 4096
   * });
   * ```
   */
  constructor(config: AnthropicProviderConfig) {
    super(config);

    const globalConfig = getProviderConfig("anthropic") ?? {};

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[ANTHROPIC_ENV.API_KEY] ??
      "";

    this.maxTokens =
      config.maxTokens ??
      globalConfig.maxTokens ??
      DEFAULT_ANTHROPIC_MAX_TOKENS;

    this.client = new AnthropicSDK({
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  /**
   * Generates content from the Anthropic API.
   *
   * Converts the ADK request to Anthropic format, makes the API call,
   * and converts the response back to ADK format.
   *
   * @param llmRequest - The ADK LLM request
   * @param stream - Whether to stream the response (default: false)
   * @returns An async generator yielding LLM responses
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    try {
      const { messages, system, tools } = convertAnthropicRequest(llmRequest);

      if (stream) {
        yield* this.streamResponse(messages, system, tools);
      } else {
        yield await this.singleResponse(messages, system, tools);
      }
    } catch (error) {
      yield this.createErrorResponse(error, "ANTHROPIC");
    }
  }

  /**
   * Makes a single (non-streaming) API request.
   *
   * Uses `messages.stream()` internally instead of `messages.create()` so
   * that tool-call arguments arrive as raw JSON fragments (`input_json_delta`)
   * and are parsed by our precision-safe `safeJsonParse`. If we used
   * `messages.create()`, the Anthropic SDK would call `JSON.parse` on the
   * response body before we see it, silently rounding integers larger than
   * Number.MAX_SAFE_INTEGER (e.g. 19-digit Zoho Desk ticket IDs).
   *
   * @private
   */
  private async singleResponse(
    messages: AnthropicSDK.MessageParam[],
    system: string | undefined,
    tools: AnthropicSDK.Tool[] | undefined,
  ): Promise<LlmResponse> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools } : {}),
    });

    const acc = createAnthropicStreamAccumulator();

    for await (const event of stream) {
      const { response, isComplete } = convertAnthropicStreamEvent(event, acc);
      if (isComplete && response) return response;
    }

    return {
      errorCode: "NO_RESPONSE",
      errorMessage: "No complete response received from Anthropic",
      turnComplete: true,
    };
  }

  /**
   * Makes a streaming API request and yields responses as they arrive.
   *
   * @private
   */
  private async *streamResponse(
    messages: AnthropicSDK.MessageParam[],
    system: string | undefined,
    tools: AnthropicSDK.Tool[] | undefined,
  ): AsyncGenerator<LlmResponse, void> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(tools?.length ? { tools } : {}),
    });

    const acc = createAnthropicStreamAccumulator();

    for await (const event of stream) {
      const { response, isComplete } = convertAnthropicStreamEvent(event, acc);
      if (response) yield response;
      if (isComplete) break;
    }
  }
}
