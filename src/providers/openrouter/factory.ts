/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenRouter factory function.
 *
 * @module providers/openrouter/factory
 */

import { OpenRouterLlm } from "./openrouter-llm";
import type { OpenRouterConfig } from "../../types";

/**
 * Configuration options for the OpenRouter factory (model is specified separately).
 */
type OpenRouterOptions = Omit<OpenRouterConfig, "model">;

/**
 * Creates an OpenRouter LLM instance.
 *
 * This is the recommended way to create OpenRouter LLM instances.
 * It provides a clean, functional API alternative to direct class instantiation.
 *
 * @param model - The model identifier in provider/model format
 * @param options - Optional configuration including site attribution and provider preferences
 * @returns A configured OpenRouterLlm instance
 *
 * @example
 * ```typescript
 * // Basic usage with free model
 * const llm = OpenRouter("google/gemma-3-1b-it:free");
 * ```
 *
 * @example
 * ```typescript
 * // With site attribution for rankings
 * const llm = OpenRouter("anthropic/claude-sonnet-4", {
 *   siteUrl: "https://myapp.com",
 *   appName: "My App"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With provider routing preferences
 * const llm = OpenRouter("anthropic/claude-sonnet-4", {
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   provider: {
 *     sort: "latency",
 *     allow_fallbacks: true,
 *     only: ["Anthropic"]
 *   }
 * });
 * ```
 *
 * @see {@link OpenRouterLlm} for direct class usage
 * @see {@link registerOpenRouter} for ADK registry integration
 * @see {@link OpenRouterConfig} for all configuration options
 */
export function OpenRouter(
  model: string,
  options?: OpenRouterOptions,
): OpenRouterLlm {
  return new OpenRouterLlm({ model, ...options });
}
