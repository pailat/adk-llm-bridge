/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Declarative provider definition interface.
 *
 * Providers that use OpenAI-compatible APIs differ only in configuration
 * (URLs, env vars, headers), not behavior. This interface captures those
 * differences as data instead of requiring class inheritance.
 *
 * @module core/provider-definition
 */

/**
 * Environment variable keys for resolving provider configuration.
 */
export interface ProviderEnvKeys {
  /** Env var names to check for API key, in priority order */
  apiKey: string[];
  /** Env var names to check for base URL, in priority order */
  baseURL?: string[];
}

/**
 * Declarative reasoning capability for a provider.
 *
 * Controls how ADK `config.thinkingConfig` is mapped onto the request body and
 * whether provider reasoning is round-tripped across turns. This is the
 * provider-aware switch that lets OpenRouter / AI Gateway honor reasoning
 * intent while OpenAI / xAI keep their strict, model-name-gated behavior.
 *
 * - `"openai-effort"` (strict, the default when `reasoning` is undefined):
 *   Emit `reasoning_effort` ONLY when the resolved model is reasoning-capable
 *   (the {@link supportsReasoningEffort} model-name gate). Direct OpenAI
 *   (gpt-5*, o-series) and xAI return a 400 if `reasoning_effort` is sent to a
 *   non-reasoning model, so the name gate MUST be preserved for them.
 *
 * - `"openrouter"` (permissive / native object): ALWAYS emit the native
 *   OpenRouter `reasoning` object (no model-name gate). OpenRouter / AI Gateway
 *   return HTTP 200 and silently ignore reasoning params on non-reasoning
 *   models, so it is safe to always send them — this both enables opt-in
 *   reasoners and steers depth on default reasoners. This style also opts into
 *   capturing `reasoning_details` and echoing the signed reasoning back across
 *   turns (required by signature-strict upstreams like Anthropic / Gemini
 *   thinking routed through OpenRouter).
 */
export interface ReasoningCapability {
  /** Reasoning mapping style (see {@link ReasoningCapability}). */
  style: "openai-effort" | "openrouter";
}

/**
 * Declarative definition for an OpenAI-compatible LLM provider.
 *
 * Instead of creating a subclass for each provider, define the provider
 * as a configuration object. The core infrastructure handles the rest.
 *
 * @example
 * ```typescript
 * const MY_PROVIDER: ProviderDefinition = {
 *   id: "my-provider",
 *   errorPrefix: "MY_PROVIDER",
 *   defaultBaseURL: "https://api.myprovider.com/v1",
 *   envKeys: { apiKey: ["MY_PROVIDER_API_KEY"] },
 *   modelPatterns: [/.+\/.+/],
 * };
 * ```
 */
export interface ProviderDefinition {
  /** Provider ID for the config system (e.g. "ai-gateway", "openrouter") */
  id: string;

  /** Error prefix for error codes (e.g. "AI_GATEWAY" → "AI_GATEWAY_ERROR") */
  errorPrefix: string;

  /** Default base URL when not specified in config or env vars */
  defaultBaseURL: string;

  /** Environment variable names to resolve for apiKey and baseURL */
  envKeys: ProviderEnvKeys;

  /** Model patterns for LLMRegistry matching */
  modelPatterns: (string | RegExp)[];

  /** Build custom HTTP headers from the instance config */
  buildHeaders?: (config: Record<string, unknown>) => Record<string, string>;

  /** Build provider-specific options to merge into request body */
  buildRequestOptions?: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;

  /**
   * Whether this provider requires an API key at construction time.
   *
   * Cloud providers (AI Gateway, OpenRouter, OpenAI, xAI) should set this
   * to true. Local/self-hosted providers that may not need auth can omit it.
   *
   * @default false
   */
  requireApiKey?: boolean;

  /**
   * Declarative reasoning capability for this provider.
   *
   * When omitted, the strict `"openai-effort"` behavior applies (model-name
   * gated `reasoning_effort`). Providers that proxy arbitrary vendor/model ids
   * and tolerate reasoning params on non-reasoning models (OpenRouter, AI
   * Gateway) should set `{ style: "openrouter" }` to honor `thinkingConfig`
   * (enable + steer + exclude) and round-trip signed reasoning across turns.
   *
   * @see {@link ReasoningCapability}
   */
  reasoning?: ReasoningCapability;
}
