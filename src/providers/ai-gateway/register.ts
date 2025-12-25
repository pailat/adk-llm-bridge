/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * AI Gateway registration with ADK's LLMRegistry.
 *
 * @module providers/ai-gateway/register
 */

import { LLMRegistry } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../../config";
import type { RegisterOptions } from "../../types";
import { AIGatewayLlm } from "./ai-gateway-llm";

/** Tracks whether AI Gateway has been registered */
let registered = false;

/**
 * Registers AIGatewayLlm with ADK's LLMRegistry.
 *
 * This enables using string-based model names directly in ADK agents,
 * which is required for `adk-devtools` compatibility.
 *
 * @param options - Optional configuration that applies to all instances
 *
 * @example
 * ```typescript
 * // Register with API key
 * registerAIGateway({
 *   apiKey: process.env.AI_GATEWAY_API_KEY
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
 * // Register with custom base URL
 * registerAIGateway({
 *   apiKey: process.env.AI_GATEWAY_API_KEY,
 *   baseURL: "https://custom-gateway.example.com/v1"
 * });
 * ```
 *
 * @see {@link AIGateway} for programmatic LLM creation
 * @see {@link AIGatewayLlm} for direct class usage
 */
export function registerAIGateway(options?: RegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] AI Gateway already registered");
    return;
  }

  if (options) {
    setProviderConfig("ai-gateway", options);
  }

  LLMRegistry.register(AIGatewayLlm);
  registered = true;
}

/**
 * Checks if AI Gateway is registered with ADK's LLMRegistry.
 *
 * @returns `true` if registered, `false` otherwise
 *
 * @example
 * ```typescript
 * if (!isAIGatewayRegistered()) {
 *   registerAIGateway({ apiKey: "..." });
 * }
 * ```
 */
export function isAIGatewayRegistered(): boolean {
  return registered;
}

/**
 * Resets the AI Gateway registration state.
 *
 * Used primarily for testing to ensure a clean state between tests.
 *
 * @internal
 */
export function _resetAIGatewayRegistration(): void {
  registered = false;
  resetProviderConfig("ai-gateway");
}
