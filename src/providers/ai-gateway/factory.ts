/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * AI Gateway factory function.
 *
 * @module providers/ai-gateway/factory
 */

import { AIGatewayLlm } from "./ai-gateway-llm";
import type { AIGatewayConfig } from "../../types";

/**
 * Configuration options for the AIGateway factory (model is specified separately).
 */
type AIGatewayOptions = Omit<AIGatewayConfig, "model">;

/**
 * Creates an AI Gateway LLM instance.
 *
 * This is the recommended way to create AI Gateway LLM instances.
 * It provides a clean, functional API alternative to direct class instantiation.
 *
 * @param model - The model identifier in provider/model format
 * @param options - Optional configuration overrides
 * @returns A configured AIGatewayLlm instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = AIGateway("anthropic/claude-sonnet-4");
 * ```
 *
 * @example
 * ```typescript
 * // With configuration
 * const llm = AIGateway("openai/gpt-4o", {
 *   apiKey: process.env.AI_GATEWAY_API_KEY,
 *   timeout: 30000
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Use with ADK agent
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   llm: AIGateway("anthropic/claude-sonnet-4")
 * });
 * ```
 *
 * @see {@link AIGatewayLlm} for direct class usage
 * @see {@link registerAIGateway} for ADK registry integration
 */
export function AIGateway(
  model: string,
  options?: AIGatewayOptions,
): AIGatewayLlm {
  return new AIGatewayLlm({ model, ...options });
}
