/**
 * Custom LLM provider for any compatible API.
 *
 * This module provides support for connecting to any API that implements
 * the chat completions interface, including Ollama, LM Studio, vLLM,
 * Azure OpenAI, and self-hosted models.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createCustomLlm, Custom } from "adk-llm-bridge";
 *
 * // Full configuration
 * const llm = createCustomLlm({
 *   name: "ollama",
 *   model: "llama3",
 *   baseURL: "http://localhost:11434/v1"
 * });
 *
 * // Shorthand syntax
 * const llm2 = Custom("llama3", {
 *   baseURL: "http://localhost:11434/v1"
 * });
 * ```
 */

export { CustomLlm, type CustomLlmProviderConfig } from "./custom-llm.js";
export { Custom, createCustomLlm } from "./factory.js";
export {
  type CustomProviderRegistrationConfig,
  type CustomRegisterOptions,
  registerCustomProvider,
} from "./registry.js";
