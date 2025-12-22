import { LLMRegistry } from "@google/adk";
import { AIGatewayLlm } from "./ai-gateway-llm";
import { setConfig, resetConfig } from "./config";
import type { RegisterOptions } from "./types";

let registered = false;

export function registerAIGateway(options?: RegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] Already registered");
    return;
  }

  if (options) {
    setConfig(options);
  }

  LLMRegistry.register(AIGatewayLlm);
  registered = true;
}

export function isAIGatewayRegistered(): boolean {
  return registered;
}

/** @internal */
export function _resetRegistration(): void {
  registered = false;
  resetConfig();
}
