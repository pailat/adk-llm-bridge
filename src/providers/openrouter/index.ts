/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenRouter provider for ADK.
 *
 * Provides access to 100+ LLM models with advanced routing,
 * fallback, and price optimization features.
 *
 * @module providers/openrouter
 *
 * @example
 * ```typescript
 * import { OpenRouter, registerOpenRouter } from "adk-llm-bridge";
 *
 * // Option 1: Factory function
 * const llm = OpenRouter("anthropic/claude-sonnet-4", {
 *   provider: { sort: "price" }
 * });
 *
 * // Option 2: Registry for string model names
 * registerOpenRouter({ apiKey: "...", siteUrl: "https://myapp.com" });
 * const agent = new LlmAgent({ model: "anthropic/claude-sonnet-4" });
 * ```
 */

export { OpenRouter } from "./factory";
export { OpenRouterLlm } from "./openrouter-llm";
export {
  _resetOpenRouterRegistration,
  isOpenRouterRegistered,
  registerOpenRouter,
} from "./register";
