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
import { InputValidationError } from "@google/adk";
import { getProviderConfig } from "../../config.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../../constants.js";
import { BaseProviderLlm } from "../../core/base-provider-llm.js";
import { annotateLlmSpan, recordLlmError } from "../../core/telemetry.js";
import type { AnthropicProviderConfig } from "../../types.js";
import { LogCode, resetWarnOnce, warnOnce } from "../../utils/log.js";
import { clampPositive } from "../../utils/validate.js";

/** Environment variable names for Anthropic configuration. */
const ANTHROPIC_ENV = { API_KEY: "ANTHROPIC_API_KEY" } as const;

/** Marker read by ADK's ContentRequestProcessor to treat a model as Claude. */
const CLAUDE_MODEL_SYMBOL = Symbol.for("google.adk.claudeModel");

/** Default max tokens for Anthropic requests. */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/** Model patterns for Anthropic models. Matches claude-* */
export const ANTHROPIC_MODEL_PATTERNS = [/claude-.*/];

/**
 * Resets the one-time warning memory. Test-only.
 *
 * @internal
 */
export function _resetAnthropicWarningState(): void {
  resetWarnOnce();
}

import type { AnthropicGenerationParams } from "./converters/request.js";
import {
  applyAnthropicPromptCaching,
  convertAnthropicRequest,
} from "./converters/request.js";
import {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./converters/response.js";

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
   * Whether opt-in prompt caching is enabled for this instance.
   *
   * @private
   */
  private readonly promptCaching: boolean;

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

    if (!apiKey) {
      throw new InputValidationError(
        `[anthropic] API key is required. Provide it via config, ` +
          `setProviderConfig("anthropic", { apiKey }), or set the ANTHROPIC_API_KEY env var.`,
      );
    }

    this.maxTokens = clampPositive(
      config.maxTokens ??
        globalConfig.maxTokens ??
        DEFAULT_ANTHROPIC_MAX_TOKENS,
      DEFAULT_ANTHROPIC_MAX_TOKENS,
      1,
    );

    this.promptCaching =
      config.promptCaching ?? globalConfig.promptCaching ?? false;

    // Same precedence as the OpenAI-compatible providers (resolveConfig):
    // instance config -> global config -> default.
    this.client = new AnthropicSDK({
      apiKey,
      timeout: clampPositive(
        config.timeout ?? globalConfig.timeout ?? DEFAULT_TIMEOUT,
        DEFAULT_TIMEOUT,
        1000,
      ),
      maxRetries: clampPositive(
        config.maxRetries ?? globalConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
        DEFAULT_MAX_RETRIES,
        0,
      ),
    });

    // Opt in to ADK's Claude handling: ContentRequestProcessor keeps the
    // `adk-*` function call/response ids for Claude models, detected by this
    // symbol or by a /^claude-/ model name. The symbol also covers aliases such
    // as `us.anthropic.claude-...` that the name check misses.
    (this as unknown as Record<symbol, boolean>)[CLAUDE_MODEL_SYMBOL] = true;
  }

  /**
   * Generates content from the Anthropic API.
   *
   * Converts the ADK request to Anthropic format, makes the API call,
   * and converts the response back to ADK format.
   *
   * @param llmRequest - The ADK LLM request
   * @param stream - Whether to stream the response (default: false)
   * @param abortSignal - Optional signal used to cancel the provider request
   * @returns An async generator yielding LLM responses
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    annotateLlmSpan({ provider: "anthropic", baseURL: this.client.baseURL });
    try {
      // Anthropic rejects an empty `messages` array, and recent Claude models
      // reject a conversation that ends with an assistant turn. Apply ADK's own
      // fix-up (as GoogleLlm does) on a copy so the caller's request is intact.
      const request: LlmRequest = {
        ...llmRequest,
        contents: [...(llmRequest.contents ?? [])],
      };
      this.maybeAppendUserContent(request);

      const { messages, system, tools, params, toolChoice } =
        convertAnthropicRequest(request);

      if (stream) {
        yield* this.streamResponse(
          messages,
          system,
          tools,
          params,
          toolChoice,
          abortSignal,
        );
      } else {
        yield await this.singleResponse(
          messages,
          system,
          tools,
          params,
          toolChoice,
          abortSignal,
        );
      }
    } catch (error) {
      if (abortSignal?.aborted) return;
      recordLlmError(error);
      yield this.handleProviderError(error, {
        prefix: "ANTHROPIC",
        providerId: "anthropic",
      });
    }
  }

  /**
   * Builds the shared request parameters for the Anthropic API.
   *
   * Per-request `config.maxOutputTokens` (params.max_tokens) overrides the
   * instance default. Anthropic requires `max_tokens` to always be present.
   *
   * @private
   */
  private buildRequestParams(
    messages: AnthropicSDK.MessageParam[],
    system: string | undefined,
    tools: AnthropicSDK.Tool[] | undefined,
    params?: AnthropicGenerationParams,
    toolChoice?: AnthropicSDK.ToolChoice,
  ): AnthropicSDK.MessageCreateParamsNonStreaming {
    const { max_tokens, ...sampling } = params ?? {};

    // Anthropic requires max_tokens to be strictly greater than the thinking
    // budget. When extended thinking is enabled, raise max_tokens if the
    // configured/default value would not leave room for the response.
    let resolvedMaxTokens = max_tokens ?? this.maxTokens;
    if (sampling.thinking?.type === "enabled") {
      const minMaxTokens = sampling.thinking.budget_tokens + 1;
      if (resolvedMaxTokens <= sampling.thinking.budget_tokens) {
        resolvedMaxTokens = minMaxTokens;
      }
    }

    // Opt-in prompt caching: attach ephemeral cache breakpoints to the static
    // prefix (system block + last tool). When disabled, the system string and
    // tools pass through unchanged (no behavior change).
    let systemField: AnthropicSDK.MessageCreateParams["system"] = system;
    let toolsField = tools;
    if (this.promptCaching) {
      const cached = applyAnthropicPromptCaching(system, tools);
      if (cached.system) systemField = cached.system;
      if (cached.tools) toolsField = cached.tools;
    }

    // thinking + forced tool_choice -> 400. Anthropic only allows tool_choice
    // auto/none when extended thinking is enabled; { type: "any" } and
    // { type: "tool", name } both error. When thinking is on, downgrade any
    // forced choice (structured-output's forced json_output tool, or a
    // functionCallingConfig ANY/VALIDATED mapping) to { type: "auto" } so
    // thinking + forced-tool never co-occur. Structured output therefore
    // becomes best-effort under thinking; "none" is preserved (still valid).
    let resolvedToolChoice = toolChoice;
    if (
      sampling.thinking?.type === "enabled" &&
      (toolChoice?.type === "any" || toolChoice?.type === "tool")
    ) {
      resolvedToolChoice = { type: "auto" };
      warnOnce(
        LogCode.THINKING_TOOL_CHOICE_DOWNGRADED,
        "Anthropic forbids a forced tool_choice while extended thinking is " +
          "enabled; downgrading tool_choice to { type: 'auto' }. Structured " +
          "output / forced function calling is best-effort in this request. " +
          "Disable thinking to force tool use.",
      );
    }

    return {
      model: this.model,
      max_tokens: resolvedMaxTokens,
      messages,
      ...sampling,
      ...(systemField ? { system: systemField } : {}),
      ...(toolsField?.length ? { tools: toolsField } : {}),
      ...(resolvedToolChoice && toolsField?.length
        ? { tool_choice: resolvedToolChoice }
        : {}),
    };
  }

  /**
   * Makes a single (non-streaming) API request.
   *
   * @private
   */
  private async singleResponse(
    messages: AnthropicSDK.MessageParam[],
    system: string | undefined,
    tools: AnthropicSDK.Tool[] | undefined,
    params?: AnthropicGenerationParams,
    toolChoice?: AnthropicSDK.ToolChoice,
    abortSignal?: AbortSignal,
  ): Promise<LlmResponse> {
    const response = await this.client.messages.create(
      this.buildRequestParams(messages, system, tools, params, toolChoice),
      abortSignal ? { signal: abortSignal } : undefined,
    );
    annotateLlmSpan({
      provider: "anthropic",
      model: response.model,
      responseId: response.id,
    });
    return convertAnthropicResponse(response);
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
    params?: AnthropicGenerationParams,
    toolChoice?: AnthropicSDK.ToolChoice,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const stream = this.client.messages.stream(
      this.buildRequestParams(messages, system, tools, params, toolChoice),
      abortSignal ? { signal: abortSignal } : undefined,
    );

    const acc = createAnthropicStreamAccumulator();

    for await (const event of stream) {
      if (abortSignal?.aborted) return;
      if (event.type === "message_start") {
        annotateLlmSpan({
          provider: "anthropic",
          model: event.message?.model,
          responseId: event.message?.id,
        });
      }
      const { response, isComplete } = convertAnthropicStreamEvent(event, acc);
      if (response) yield response;
      if (isComplete) break;
    }
  }
}
