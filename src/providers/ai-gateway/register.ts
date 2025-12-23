import { LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "./ai-gateway-llm";
import { setProviderConfig, resetProviderConfig } from "../../config";
import type { RegisterOptions } from "../../types";

let registered = false;

/**
 * Registers AIGatewayLlm with ADK's LLMRegistry.
 * Required for using string-based model names with ADK agents.
 *
 * @example
 * ```typescript
 * registerAIGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
 *
 * const agent = new LlmAgent({
 *   model: "anthropic/claude-sonnet-4", // Works because AIGatewayLlm is registered
 * });
 * ```
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

export function isAIGatewayRegistered(): boolean {
  return registered;
}

/** @internal */
export function _resetAIGatewayRegistration(): void {
  registered = false;
  resetProviderConfig("ai-gateway");
}
