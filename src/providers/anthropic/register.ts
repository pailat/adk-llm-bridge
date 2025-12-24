/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Anthropic LLMRegistry integration.
 *
 * This module provides functions to register the Anthropic provider with
 * ADK's LLMRegistry, enabling string-based model resolution.
 *
 * @module providers/anthropic/register
 */

import { LLMRegistry } from "@google/adk";
import { setProviderConfig, resetProviderConfig } from "../../config";
import type { AnthropicRegisterOptions } from "../../types";
import { AnthropicLlm } from "./anthropic-llm";

/** Tracks whether the provider has been registered */
let registered = false;

/**
 * Registers the Anthropic provider with ADK's LLMRegistry.
 *
 * After registration, you can use model strings like "claude-sonnet-4-5-20250929"
 * directly with ADK agents, and the registry will automatically create Anthropic
 * LLM instances.
 *
 * This function is idempotent - calling it multiple times has no effect
 * after the first call (a warning is logged on subsequent calls).
 *
 * @param options - Optional global configuration for all Anthropic instances
 *
 * @example
 * ```typescript
 * import { registerAnthropic } from "adk-llm-bridge";
 *
 * // Register with API key from environment
 * registerAnthropic();
 *
 * // Register with explicit configuration
 * registerAnthropic({
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   maxTokens: 8192
 * });
 *
 * // Now use model strings directly with ADK
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: "claude-sonnet-4-5-20250929"  // Resolved by registry
 * });
 * ```
 *
 * @see {@link isAnthropicRegistered} to check registration status
 * @see {@link Anthropic} for direct instance creation without registry
 */
export function registerAnthropic(options?: AnthropicRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] Anthropic already registered");
    return;
  }

  if (options) {
    setProviderConfig("anthropic", options);
  }

  LLMRegistry.register(AnthropicLlm);
  registered = true;
}

/**
 * Checks whether Anthropic has been registered with the LLMRegistry.
 *
 * @returns `true` if Anthropic is registered, `false` otherwise
 *
 * @example
 * ```typescript
 * if (!isAnthropicRegistered()) {
 *   registerAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 * }
 * ```
 */
export function isAnthropicRegistered(): boolean {
  return registered;
}

/**
 * Resets the Anthropic registration state.
 *
 * This is primarily intended for testing purposes. It clears the
 * registration flag and removes any global configuration.
 *
 * @internal
 */
export function _resetAnthropicRegistration(): void {
  registered = false;
  resetProviderConfig("anthropic");
}
