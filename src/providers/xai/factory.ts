/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory function for creating xAI LLM instances.
 *
 * @module providers/xai/factory
 */

import type { XAIProviderConfig } from "../../types";
import { XAILlm } from "./xai-llm";

/**
 * Options for the xAI factory function.
 *
 * Same as {@link XAIProviderConfig} but without the `model` field,
 * which is passed as the first argument.
 */
type XAIOptions = Omit<XAIProviderConfig, "model">;

/**
 * Creates an xAI (Grok) LLM instance.
 *
 * This is the recommended way to create xAI LLM instances for use with ADK.
 * The model is passed as the first argument for convenience.
 *
 * @param model - The xAI model to use (e.g., "grok-4", "grok-3-beta")
 * @param options - Optional configuration options
 * @returns A configured xAI LLM instance
 *
 * @example
 * ```typescript
 * import { XAI } from "adk-llm-bridge";
 *
 * // Basic usage (uses XAI_API_KEY env var)
 * const llm = XAI("grok-4");
 *
 * // With explicit API key
 * const llm = XAI("grok-4", {
 *   apiKey: "xai-..."
 * });
 *
 * // Use with ADK agent
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: llm
 * });
 * ```
 *
 * @see {@link XAILlm} for the underlying class
 * @see {@link registerXAI} for LLMRegistry integration
 */
export function XAI(model: string, options?: XAIOptions): XAILlm {
  return new XAILlm({ model, ...options });
}
