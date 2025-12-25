/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI LLMRegistry integration.
 *
 * This module provides functions to register the OpenAI provider with
 * ADK's LLMRegistry, enabling string-based model resolution.
 *
 * @module providers/openai/register
 */

import { LLMRegistry } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../../config";
import type { OpenAIRegisterOptions } from "../../types";
import { OpenAILlm } from "./openai-llm";

/** Tracks whether the provider has been registered */
let registered = false;

/**
 * Registers the OpenAI provider with ADK's LLMRegistry.
 *
 * After registration, you can use model strings like "gpt-4.1" directly
 * with ADK agents, and the registry will automatically create OpenAI
 * LLM instances.
 *
 * This function is idempotent - calling it multiple times has no effect
 * after the first call (a warning is logged on subsequent calls).
 *
 * @param options - Optional global configuration for all OpenAI instances
 *
 * @example
 * ```typescript
 * import { registerOpenAI } from "adk-llm-bridge";
 *
 * // Register with API key from environment
 * registerOpenAI();
 *
 * // Register with explicit configuration
 * registerOpenAI({
 *   apiKey: process.env.OPENAI_API_KEY,
 *   organization: "org-xxx"
 * });
 *
 * // Now use model strings directly with ADK
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: "gpt-4.1"  // Resolved by registry
 * });
 * ```
 *
 * @see {@link isOpenAIRegistered} to check registration status
 * @see {@link OpenAI} for direct instance creation without registry
 */
export function registerOpenAI(options?: OpenAIRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] OpenAI already registered");
    return;
  }

  if (options) {
    setProviderConfig("openai", options);
  }

  LLMRegistry.register(OpenAILlm);
  registered = true;
}

/**
 * Checks whether OpenAI has been registered with the LLMRegistry.
 *
 * @returns `true` if OpenAI is registered, `false` otherwise
 *
 * @example
 * ```typescript
 * if (!isOpenAIRegistered()) {
 *   registerOpenAI({ apiKey: process.env.OPENAI_API_KEY });
 * }
 * ```
 */
export function isOpenAIRegistered(): boolean {
  return registered;
}

/**
 * Resets the OpenAI registration state.
 *
 * This is primarily intended for testing purposes. It clears the
 * registration flag and removes any global configuration.
 *
 * @internal
 */
export function _resetOpenAIRegistration(): void {
  registered = false;
  resetProviderConfig("openai");
}
