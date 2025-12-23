import { LLMRegistry } from "@google/adk";
import { OpenRouterLlm } from "./openrouter-llm";
import { setProviderConfig, resetProviderConfig } from "../../config";
import type { OpenRouterRegisterOptions } from "../../types";

let registered = false;

/**
 * Registers OpenRouterLlm with ADK's LLMRegistry.
 * Required for using string-based model names with ADK agents.
 *
 * @example
 * ```typescript
 * registerOpenRouter({
 *   apiKey: process.env.OPENROUTER_API_KEY,
 *   siteUrl: "https://myapp.com",
 *   appName: "My App",
 * });
 *
 * const agent = new LlmAgent({
 *   model: "anthropic/claude-sonnet-4", // Works because OpenRouterLlm is registered
 * });
 * ```
 */
export function registerOpenRouter(options?: OpenRouterRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] OpenRouter already registered");
    return;
  }

  if (options) {
    setProviderConfig("openrouter", options);
  }

  LLMRegistry.register(OpenRouterLlm);
  registered = true;
}

export function isOpenRouterRegistered(): boolean {
  return registered;
}

/** @internal */
export function _resetOpenRouterRegistration(): void {
  registered = false;
  resetProviderConfig("openrouter");
}
