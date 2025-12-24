/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory function for creating Anthropic LLM instances.
 *
 * @module providers/anthropic/factory
 */

import type { AnthropicProviderConfig } from "../../types";
import { AnthropicLlm } from "./anthropic-llm";

/**
 * Options for the Anthropic factory function.
 *
 * Same as {@link AnthropicProviderConfig} but without the `model` field,
 * which is passed as the first argument.
 */
type AnthropicOptions = Omit<AnthropicProviderConfig, "model">;

/**
 * Creates an Anthropic (Claude) LLM instance.
 *
 * This is the recommended way to create Anthropic LLM instances for use with ADK.
 * The model is passed as the first argument for convenience.
 *
 * @param model - The Claude model to use (e.g., "claude-sonnet-4-5-20250929", "claude-opus-4-5")
 * @param options - Optional configuration options
 * @returns A configured Anthropic LLM instance
 *
 * @example
 * ```typescript
 * import { Anthropic } from "adk-llm-bridge";
 *
 * // Basic usage (uses ANTHROPIC_API_KEY env var)
 * const llm = Anthropic("claude-sonnet-4-5-20250929");
 *
 * // With explicit API key
 * const llm = Anthropic("claude-sonnet-4-5-20250929", {
 *   apiKey: "..."
 * });
 *
 * // With max tokens
 * const llm = Anthropic("claude-opus-4-5", {
 *   apiKey: "...",
 *   maxTokens: 8192
 * });
 *
 * // Use with ADK agent
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: llm
 * });
 * ```
 *
 * @see {@link AnthropicLlm} for the underlying class
 * @see {@link registerAnthropic} for LLMRegistry integration
 */
export function Anthropic(
  model: string,
  options?: AnthropicOptions,
): AnthropicLlm {
  return new AnthropicLlm({ model, ...options });
}
