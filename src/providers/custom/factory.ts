/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory functions for custom LLM providers.
 *
 * @module providers/custom/factory
 */

import { CustomLlm, type CustomLlmProviderConfig } from "./custom-llm";
import type { CustomLlmConfig } from "../../types";

/**
 * Creates a custom LLM instance.
 *
 * This is the recommended way to connect to any API that implements
 * the chat completions interface. It provides a clean, functional API.
 *
 * @param config - Configuration options including model, baseURL, and optional settings
 * @returns A configured CustomLlm instance
 *
 * @example
 * ```typescript
 * // Ollama
 * const llm = createCustomLlm({
 *   name: "ollama",
 *   model: "llama3",
 *   baseURL: "http://localhost:11434/v1"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Azure OpenAI
 * const llm = createCustomLlm({
 *   name: "azure",
 *   model: "gpt-4",
 *   baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
 *   apiKey: process.env.AZURE_API_KEY,
 *   headers: { "api-key": process.env.AZURE_API_KEY },
 *   queryParams: { "api-version": "2024-02-01" }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // vLLM / LM Studio
 * const llm = createCustomLlm({
 *   baseURL: "http://localhost:8000/v1",
 *   model: "meta-llama/Llama-3-8b"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With provider-specific options
 * const llm = createCustomLlm({
 *   name: "custom",
 *   model: "my-model",
 *   baseURL: "https://api.example.com/v1",
 *   apiKey: "sk-...",
 *   providerOptions: {
 *     temperature: 0.7,
 *     custom_param: "value"
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Use with ADK agent
 * import { LlmAgent } from "@google/adk";
 *
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: createCustomLlm({
 *     name: "ollama",
 *     model: "llama3",
 *     baseURL: "http://localhost:11434/v1"
 *   }),
 *   instruction: "You are a helpful assistant."
 * });
 * ```
 *
 * @see {@link CustomLlm} for direct class usage
 * @see {@link Custom} for a shorthand alias
 */
export function createCustomLlm(config: CustomLlmProviderConfig): CustomLlm {
  return new CustomLlm(config);
}

/**
 * Configuration options for the Custom factory (model is specified separately).
 */
type CustomOptions = Omit<CustomLlmConfig, "model"> & {
  /**
   * Base URL for the API endpoint (required).
   */
  baseURL: string;
};

/**
 * Creates a custom LLM instance with a shorthand syntax.
 *
 * This is an alias for `createCustomLlm` that takes the model
 * as the first argument, similar to the `AIGateway` and `OpenRouter`
 * factory functions.
 *
 * @param model - The model identifier
 * @param options - Configuration options including baseURL and optional settings
 * @returns A configured CustomLlm instance
 *
 * @example
 * ```typescript
 * // Simple usage
 * const llm = Custom("llama3", {
 *   baseURL: "http://localhost:11434/v1"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With full options
 * const llm = Custom("gpt-4", {
 *   name: "azure",
 *   baseURL: "https://my-resource.openai.azure.com/openai/deployments/gpt-4",
 *   apiKey: process.env.AZURE_API_KEY,
 *   headers: { "api-key": process.env.AZURE_API_KEY },
 *   queryParams: { "api-version": "2024-02-01" }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Use with ADK agent
 * import { LlmAgent } from "@google/adk";
 *
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: Custom("llama3", { baseURL: "http://localhost:11434/v1" }),
 *   instruction: "You are a helpful assistant."
 * });
 * ```
 *
 * @see {@link createCustomLlm} for the full configuration syntax
 */
export function Custom(model: string, options: CustomOptions): CustomLlm {
  return createCustomLlm({ model, ...options });
}
