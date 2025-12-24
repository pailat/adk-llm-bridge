/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory function for creating OpenAI LLM instances.
 *
 * @module providers/openai/factory
 */

import type { OpenAIProviderConfig } from "../../types";
import { OpenAILlm } from "./openai-llm";

/**
 * Options for the OpenAI factory function.
 *
 * Same as {@link OpenAIProviderConfig} but without the `model` field,
 * which is passed as the first argument.
 */
type OpenAIOptions = Omit<OpenAIProviderConfig, "model">;

/**
 * Creates an OpenAI LLM instance.
 *
 * This is the recommended way to create OpenAI LLM instances for use with ADK.
 * The model is passed as the first argument for convenience.
 *
 * @param model - The OpenAI model to use (e.g., "gpt-4.1", "o3", "gpt-4o")
 * @param options - Optional configuration options
 * @returns A configured OpenAI LLM instance
 *
 * @example
 * ```typescript
 * import { OpenAI } from "adk-llm-bridge";
 *
 * // Basic usage (uses OPENAI_API_KEY env var)
 * const llm = OpenAI("gpt-4.1");
 *
 * // With explicit API key
 * const llm = OpenAI("gpt-4.1", {
 *   apiKey: "sk-..."
 * });
 *
 * // With organization and project
 * const llm = OpenAI("gpt-4.1", {
 *   apiKey: "sk-...",
 *   organization: "org-xxx",
 *   project: "proj-xxx"
 * });
 *
 * // Use with ADK agent
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: llm
 * });
 * ```
 *
 * @see {@link OpenAILlm} for the underlying class
 * @see {@link registerOpenAI} for LLMRegistry integration
 */
export function OpenAI(model: string, options?: OpenAIOptions): OpenAILlm {
  return new OpenAILlm({ model, ...options });
}
