/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenRouter registration with ADK's LLMRegistry.
 *
 * @module providers/openrouter/register
 */

import { LLMRegistry } from "@google/adk";
import { OpenRouterLlm } from "./openrouter-llm";
import { setProviderConfig, resetProviderConfig } from "../../config";
import type { OpenRouterRegisterOptions } from "../../types";

/** Tracks whether OpenRouter has been registered */
let registered = false;

/**
 * Registers OpenRouterLlm with ADK's LLMRegistry.
 *
 * This enables using string-based model names directly in ADK agents,
 * which is required for `adk-devtools` compatibility.
 *
 * @param options - Optional configuration that applies to all instances
 *
 * @example
 * ```typescript
 * // Register with API key and site attribution
 * registerOpenRouter({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   siteUrl: "https://myapp.com",
 *   appName: "My App"
 * });
 *
 * // Now you can use string model names in agents
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: "anthropic/claude-sonnet-4"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Register with minimal config (uses environment variables)
 * registerOpenRouter();
 * ```
 *
 * @see {@link OpenRouter} for programmatic LLM creation
 * @see {@link OpenRouterLlm} for direct class usage
 */
export function registerOpenRouter(options?: OpenRouterRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] OpenRouter already registered");
    return;
  }

  if (options) {
    setProviderConfig("openrouter", options);
  }

  LLMRegistry.register(OpenRouterLlm);
  registered = true;
}

/**
 * Checks if OpenRouter is registered with ADK's LLMRegistry.
 *
 * @returns `true` if registered, `false` otherwise
 *
 * @example
 * ```typescript
 * if (!isOpenRouterRegistered()) {
 *   registerOpenRouter({ apiKey: "..." });
 * }
 * ```
 */
export function isOpenRouterRegistered(): boolean {
  return registered;
}

/**
 * Resets the OpenRouter registration state.
 *
 * Used primarily for testing to ensure a clean state between tests.
 *
 * @internal
 */
export function _resetOpenRouterRegistration(): void {
  registered = false;
  resetProviderConfig("openrouter");
}
