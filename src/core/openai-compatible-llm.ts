/**
 * OpenAI-compatible LLM base class.
 *
 * This module provides the base class for LLM providers that use
 * OpenAI-compatible APIs (chat completions endpoint). Providers can
 * be created either by extending this class or by using a declarative
 * {@link ProviderDefinition}.
 */

import {
  InputValidationError,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import OpenAI from "openai";
import { getProviderConfig } from "../config.js";
import { withCacheCreation } from "../converters/cache-usage.js";
import { convertRequest } from "../converters/request.js";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../converters/response.js";
import type { BaseProviderConfig, PromptCachingConfig } from "../types.js";
import { LogCode, warnOnce } from "../utils/log.js";
import { BaseProviderLlm } from "./base-provider-llm.js";
import { resolveConfig } from "./config-resolver.js";
import type {
  PromptCachingCapability,
  ProviderDefinition,
  ReasoningCapability,
} from "./provider-definition.js";
import {
  PROVIDER_ERROR_INCOMPLETE_STREAM,
  PROVIDER_ERROR_NO_CHOICE,
} from "./provider-llm-error.js";
import {
  annotateCacheUsage,
  annotateLlmSpan,
  recordLlmError,
} from "./telemetry.js";

/**
 * Configuration for the underlying OpenAI client.
 *
 * The connection options are passed to the OpenAI SDK constructor;
 * `providerId` and `errorPrefix` name the provider in its errors, so a
 * subclass does not need to override `getErrorPrefix()`.
 */
export interface OpenAIClientConfig {
  /**
   * Base URL for the API endpoint. Required: a missing or blank value throws
   * `InputValidationError`, so `OPENAI_BASE_URL` is never used in its place.
   */
  baseURL: string;
  /** API key for authentication. */
  apiKey: string;
  /** Request timeout in milliseconds. */
  timeout: number;
  /** Maximum number of retry attempts. */
  maxRetries: number;
  /** Additional HTTP headers to include in all requests. */
  defaultHeaders?: Record<string, string>;
  /**
   * Provider id reported on `ProviderLlmError.provider`; must not be blank.
   * Default: `"custom"`. `setProviderConfig` takes built-in ids only, so for
   * another id only the instance's own `errorMode` applies.
   */
  providerId?: string;
  /**
   * Prefix of the `<PREFIX>_ERROR` code for failures without an HTTP status:
   * only A-Z, 0-9 and `_`, with at least one letter or digit (for example
   * `ACME`). Default: `"CUSTOM"`.
   */
  errorPrefix?: string;
}

/**
 * Whether `prefix` keeps `<PREFIX>_ERROR` a stable UPPER_SNAKE code: only
 * A-Z, 0-9 and `_`, with at least one letter or digit.
 *
 * @remarks
 * Two single-class patterns, so the check stays linear in the input length.
 *
 * @param prefix - The candidate prefix.
 * @returns `true` when the prefix is valid.
 *
 * @internal
 */
export function isErrorPrefix(prefix: string): boolean {
  return /^[A-Z0-9_]+$/.test(prefix) && /[A-Z0-9]/.test(prefix);
}

function checkErrorPrefix(prefix: string): string {
  if (!isErrorPrefix(prefix)) {
    throw new InputValidationError(
      `[adk-llm-bridge] errorPrefix must be UPPER_SNAKE (A-Z, 0-9 and _, with a letter or digit), got ${JSON.stringify(prefix)}.`,
    );
  }
  return prefix;
}

// The OpenAI SDK replaces a missing base URL with OPENAI_BASE_URL (or
// api.openai.com), which would send this provider's key to another host.
function checkBaseURL(baseURL: unknown): string {
  if (typeof baseURL !== "string" || !baseURL.trim()) {
    throw new InputValidationError(
      "[adk-llm-bridge] baseURL is required for a manually configured client.",
    );
  }
  return baseURL;
}

function checkProviderId(providerId: string): string {
  if (!providerId.trim()) {
    throw new InputValidationError(
      "[adk-llm-bridge] providerId must not be blank.",
    );
  }
  return providerId;
}

/**
 * Turns off the OpenAI SDK's own environment defaults for hosts they were not
 * issued for.
 *
 * The SDK reads `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY` and
 * `OPENAI_WEBHOOK_SECRET` when an option is `undefined`, and sends the org and
 * project as headers. `null` turns a default off. The `openai` provider keeps
 * the org and project defaults (they are OpenAI's own variables); every other
 * provider, custom ones included, gets none of them. The admin key and the
 * webhook secret are never read: the chat path does not use them.
 *
 * @internal
 */
function sdkEnvOverrides(providerId: string): {
  adminAPIKey: null;
  webhookSecret: null;
  organization?: null;
  project?: null;
} {
  return providerId === "openai"
    ? { adminAPIKey: null, webhookSecret: null }
    : {
        adminAPIKey: null,
        webhookSecret: null,
        organization: null,
        project: null,
      };
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
 *    with pre-resolved values and, optionally, the `providerId` and
 *    `errorPrefix` its errors carry. Used by CustomLlm which has unique URL
 *    logic.
 *
 * @example
 * ```typescript
 * // Declarative (most providers)
 * const llm = new OpenAICompatibleLlm(MY_DEFINITION, { model: "gpt-6.1-sol" });
 *
 * // Manual (Custom provider)
 * class CustomLlm extends OpenAICompatibleLlm {
 *   constructor(config) {
 *     super(config, {
 *       baseURL, apiKey, timeout, maxRetries,
 *       providerId: "acme", errorPrefix: "ACME",
 *     });
 *   }
 * }
 * ```
 */
export class OpenAICompatibleLlm extends BaseProviderLlm {
  /** Model patterns for LLMRegistry — set by createProviderClass(). */
  static supportedModels: (string | RegExp)[] = [];

  protected readonly client: OpenAI;

  private readonly _errorPrefix: string;
  private readonly _providerId: string;
  private readonly _getRequestOptions?: () => Record<string, unknown>;
  /**
   * Declarative reasoning capability from the provider definition.
   *
   * Undefined in manual/CustomLlm mode, which falls back to the strict
   * `"openai-effort"` default in the request converter.
   */
  private readonly _reasoning?: ReasoningCapability;
  /** Prompt-caching capability from the provider definition (undefined = never). */
  private readonly _promptCaching?: PromptCachingCapability;
  /** Resolved `promptCaching` setting: instance, then global, then undefined. */
  private readonly _promptCachingConfig?: PromptCachingConfig;
  /** Output-limit parameter from the provider definition (undefined = `max_tokens`). */
  private readonly _maxTokensParam?: ProviderDefinition["maxTokensParam"];

  /**
   * Model ids a rewritten `llmRequest.model` must match to be sent; see
   * {@link BaseProviderLlm.requestModel}. `undefined` in manual mode.
   */
  private readonly _modelPatterns?: readonly (string | RegExp)[];

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
      this._providerId = definition.id;
      this._reasoning = definition.reasoning;
      this._maxTokensParam = definition.maxTokensParam;
      this._promptCaching = definition.promptCaching;
      if (definition.promptCaching) {
        const global = getProviderConfig(
          definition.id as Parameters<typeof getProviderConfig>[0],
        ) as { promptCaching?: PromptCachingConfig } | undefined;
        this._promptCachingConfig =
          (config as { promptCaching?: PromptCachingConfig }).promptCaching ??
          global?.promptCaching;
      }
      this._modelPatterns = definition.modelPatterns;

      const resolved = resolveConfig(definition, config);
      this.client = new OpenAI({
        ...sdkEnvOverrides(definition.id),
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
      this._errorPrefix = checkErrorPrefix(
        clientConfig.errorPrefix ?? "CUSTOM",
      );
      this._providerId = checkProviderId(clientConfig.providerId ?? "custom");
      this.client = new OpenAI({
        ...sdkEnvOverrides(this._providerId),
        baseURL: checkBaseURL(clientConfig.baseURL),
        // The OpenAI SDK requires a non-empty credential at construction
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

  /**
   * Request-body fields that turn prompt caching on for `model`, or `{}`.
   *
   * Markers live in the provider body only, never in the `LlmRequest`. The
   * default is judged on the model actually sent and on the request itself, so
   * a routed or overridden model, or a one-shot step, is decided per call.
   */
  private cachingRequestOptions(
    model: string,
    tools: OpenAI.ChatCompletionTool[] | undefined,
    messages: OpenAI.ChatCompletionMessageParam[],
  ): Record<string, unknown> {
    const capability = this._promptCaching;
    const setting = this._promptCachingConfig;
    if (!capability || setting === false) return {};
    const explicit = setting !== undefined;
    if (!explicit) {
      if (!capability.defaultModel?.test(model)) return {};
      // Automatic: cache only a request that can be reused, one that declares
      // a tool or already holds an earlier model turn.
      const reusable =
        (tools?.length ?? 0) > 0 ||
        messages.some((m) => m.role === "assistant");
      if (!reusable) return {};
    }

    const ttl = typeof setting === "object" ? setting.ttl : undefined;
    if (capability.style === "gateway-auto") {
      if (ttl === "1h") {
        warnOnce(
          LogCode.PROMPT_CACHE_TTL_IGNORED,
          "AI Gateway chat completions cache for 5 minutes only; " +
            "promptCaching ttl '1h' is ignored and the 5-minute lifetime is used.",
        );
      }
      return { providerOptions: { gateway: { caching: "auto" } } };
    }
    return {
      cache_control:
        ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" },
    };
  }

  /**
   * Generates content from an OpenAI-compatible API.
   *
   * @remarks
   * Failures follow `errorMode`: with `"throw"` (the default) they are thrown
   * as {@link ProviderLlmError}, with `"response"` they are yielded as an error
   * `LlmResponse`. The code is `API_ERROR_<status>`, `<PREFIX>_ERROR`,
   * {@link PROVIDER_ERROR_NO_CHOICE} (a reply with no choice) or
   * {@link PROVIDER_ERROR_INCOMPLETE_STREAM} (a stream that ended before its
   * final chunk, reported after the partial responses). A caller abort never
   * produces an error.
   *
   * @param llmRequest - The ADK LLM request
   * @param stream - Whether to stream the response (default: false)
   * @param abortSignal - Optional signal used to cancel the provider request
   * @returns An async generator yielding LLM responses
   * @throws {@link ProviderLlmError} in `"throw"` mode, with one of the codes
   *   above.
   * @throws `InputValidationError` (from `@google/adk`) in every `errorMode`
   *   when request conversion rejects the request as invalid, such as a
   *   `candidateCount` other than 1, before any provider call. Other
   *   conversion failures follow `errorMode` like provider failures.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    let noChoice: LlmResponse | undefined;
    let incomplete = false;
    let converted = false;
    try {
      // Identify the provider/endpoint on the span up front so even a failed
      // call is attributable; model and response id are added on response.
      annotateLlmSpan({
        provider: this._providerId,
        baseURL: this.client.baseURL,
      });
      const model = this.requestModel(llmRequest, this._modelPatterns);
      const { messages, tools, params, toolChoice } = convertRequest(
        this.withUserTurn(llmRequest),
        model,
        { reasoning: this._reasoning, maxTokensParam: this._maxTokensParam },
      );
      converted = true;

      if (stream) {
        const completed = yield* this.streamResponse(
          model,
          messages,
          tools,
          params,
          toolChoice,
          abortSignal,
        );
        incomplete = !completed && !abortSignal?.aborted;
      } else {
        const response = await this.singleResponse(
          model,
          messages,
          tools,
          params,
          toolChoice,
          abortSignal,
        );
        if (response.errorCode === PROVIDER_ERROR_NO_CHOICE) {
          noChoice = response;
        } else {
          yield response;
        }
      }
    } catch (error) {
      // An invalid request is the caller's mistake: thrown as is in every
      // `errorMode`, not wrapped as a provider failure that `RoutedLlm` would
      // fail over on. Any other conversion failure follows `errorMode`.
      if (!converted && error instanceof InputValidationError) throw error;
      if (abortSignal?.aborted) return;
      recordLlmError(error);
      yield this.handleProviderError(error, {
        prefix: this.getErrorPrefix(),
        providerId: this._providerId,
      });
      return;
    }
    if (noChoice) {
      // A reply without choices is a failed call: it follows `errorMode`
      // like any other error, outside the `try` so a throw is not wrapped.
      const error = new Error(noChoice.errorMessage ?? "No response choice");
      recordLlmError(error);
      yield this.handleProviderError(error, {
        prefix: this.getErrorPrefix(),
        providerId: this._providerId,
        code: PROVIDER_ERROR_NO_CHOICE,
      });
    }
    if (incomplete) {
      // Partials without the final chunk are not a turn: report it so the
      // caller does not take the cut text as the whole answer.
      const error = new Error("Stream ended before the final chunk");
      recordLlmError(error);
      yield this.handleProviderError(error, {
        prefix: this.getErrorPrefix(),
        providerId: this._providerId,
        code: PROVIDER_ERROR_INCOMPLETE_STREAM,
      });
    }
  }

  /**
   * Labels the active model-call span (`call_llm` in ADK 2.4,
   * `generate_content {model}` in ADK 2.5) with this provider's identity.
   */
  private annotateSpan(
    result: Pick<OpenAI.ChatCompletion, "id" | "model">,
  ): void {
    annotateLlmSpan({
      provider: this._providerId,
      model: result.model,
      responseId: result.id,
      baseURL: this.client.baseURL,
    });
  }

  private async singleResponse(
    model: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
    params?: Record<string, unknown>,
    toolChoice?: OpenAI.ChatCompletionToolChoiceOption,
    abortSignal?: AbortSignal,
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create(
      {
        model,
        messages,
        ...params,
        ...(tools?.length ? { tools } : {}),
        ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
        ...this.cachingRequestOptions(model, tools, messages),
        ...this.getProviderRequestOptions(),
      },
      abortSignal ? { signal: abortSignal } : undefined,
    );
    this.annotateSpan(response);
    const converted = convertResponse(response);
    annotateCacheUsage(this._providerId, converted);
    return converted;
  }

  /**
   * Streams one completion. Returns `true` when the final chunk arrived and
   * was yielded, `false` when the stream ended early or the caller aborted.
   */
  private async *streamResponse(
    model: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
    params?: Record<string, unknown>,
    toolChoice?: OpenAI.ChatCompletionToolChoiceOption,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, boolean> {
    const stream = await this.client.chat.completions.create(
      {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...params,
        ...(tools?.length ? { tools } : {}),
        ...(toolChoice && tools?.length ? { tool_choice: toolChoice } : {}),
        ...this.cachingRequestOptions(model, tools, messages),
        ...this.getProviderRequestOptions(),
      },
      abortSignal ? { signal: abortSignal } : undefined,
    );

    const acc = createStreamAccumulator();
    let annotated = false;

    // OpenAI with stream_options.include_usage emits the cumulative usage in a
    // SEPARATE, choices-empty chunk that arrives AFTER the finish chunk. If we
    // broke the loop on finish we would drop that usage. Instead, stash the
    // final (isComplete) response, keep draining the stream so the trailing
    // usage chunk is read into acc.usage, then merge and yield it last.
    let finalResponse: LlmResponse | undefined;

    try {
      for await (const chunk of stream) {
        // Honor cancellation explicitly: never rely on the SDK (or a server
        // that ignores the abort) to stop delivering chunks after the caller
        // aborted.
        if (abortSignal?.aborted) return false;
        if (!annotated) {
          annotated = true;
          this.annotateSpan(chunk);
        }
        const { response, isComplete } = convertStreamChunk(chunk, acc);
        if (isComplete) {
          // Hold the final response; do not break: a usage-only chunk may
          // follow.
          finalResponse = response;
          continue;
        }
        if (response) yield response;
      }
    } catch (error) {
      // The turn is whole once the finish chunk is in: a drop while draining
      // the trailing usage chunk or `[DONE]` only loses the usage, so keep
      // the final response instead of failing the turn.
      if (!finalResponse) throw error;
    }

    if (abortSignal?.aborted) return false;
    if (!finalResponse) return false;

    // acc.usage is repopulated by a post-finish usage chunk (if any); prefer
    // it over whatever was captured before finish.
    if (acc.usage) finalResponse.usageMetadata = acc.usage;
    if (acc.cacheCreationTokens !== undefined) {
      finalResponse.customMetadata = withCacheCreation(
        finalResponse.customMetadata,
        acc.cacheCreationTokens,
      );
    }
    annotateCacheUsage(this._providerId, finalResponse);
    yield finalResponse;
    return true;
  }
}
