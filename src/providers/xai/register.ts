/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * xAI LLMRegistry integration.
 *
 * This module provides functions to register the xAI provider with
 * ADK's LLMRegistry, enabling string-based model resolution.
 *
 * @module providers/xai/register
 */

import { LLMRegistry } from "@google/adk";
import { setProviderConfig, resetProviderConfig } from "../../config";
import type { XAIRegisterOptions } from "../../types";
import { XAILlm } from "./xai-llm";

/** Tracks whether the provider has been registered */
let registered = false;

/**
 * Registers the xAI provider with ADK's LLMRegistry.
 *
 * After registration, you can use model strings like "grok-4" directly
 * with ADK agents, and the registry will automatically create xAI
 * LLM instances.
 *
 * This function is idempotent - calling it multiple times has no effect
 * after the first call (a warning is logged on subsequent calls).
 *
 * @param options - Optional global configuration for all xAI instances
 *
 * @example
 * ```typescript
 * import { registerXAI } from "adk-llm-bridge";
 *
 * // Register with API key from environment
 * registerXAI();
 *
 * // Register with explicit configuration
 * registerXAI({
 *   apiKey: process.env.XAI_API_KEY
 * });
 *
 * // Now use model strings directly with ADK
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: "grok-4"  // Resolved by registry
 * });
 * ```
 *
 * @see {@link isXAIRegistered} to check registration status
 * @see {@link XAI} for direct instance creation without registry
 */
export function registerXAI(options?: XAIRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] xAI already registered");
    return;
  }

  if (options) {
    setProviderConfig("xai", options);
  }

  LLMRegistry.register(XAILlm);
  registered = true;
}

/**
 * Checks whether xAI has been registered with the LLMRegistry.
 *
 * @returns `true` if xAI is registered, `false` otherwise
 *
 * @example
 * ```typescript
 * if (!isXAIRegistered()) {
 *   registerXAI({ apiKey: process.env.XAI_API_KEY });
 * }
 * ```
 */
export function isXAIRegistered(): boolean {
  return registered;
}

/**
 * Resets the xAI registration state.
 *
 * This is primarily intended for testing purposes. It clears the
 * registration flag and removes any global configuration.
 *
 * @internal
 */
export function _resetXAIRegistration(): void {
  registered = false;
  resetProviderConfig("xai");
}
