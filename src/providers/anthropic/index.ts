/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Anthropic (Claude) provider module.
 *
 * @module providers/anthropic
 */

import { LLMRegistry } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../../config.js";
import type {
  AnthropicProviderConfig,
  AnthropicRegisterOptions,
} from "../../types.js";
import { AnthropicLlm } from "./anthropic-llm.js";

// Re-exports
export { ANTHROPIC_MODEL_PATTERNS, AnthropicLlm } from "./anthropic-llm.js";
export type { ConvertedAnthropicRequest } from "./converters/request.js";
export { convertAnthropicRequest } from "./converters/request.js";
export type {
  AnthropicStreamAccumulator,
  AnthropicStreamResult,
} from "./converters/response.js";
export {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./converters/response.js";

/**
 * Creates an Anthropic (Claude) LLM instance.
 *
 * @param model - The Claude model to use
 * @param options - Optional configuration options
 * @returns A configured Anthropic LLM instance
 */
export function Anthropic(
  model: string,
  options?: Omit<AnthropicProviderConfig, "model">,
): AnthropicLlm {
  return new AnthropicLlm({ model, ...options });
}

// --- Registration (singleton pattern) ---

let registered = false;

export function registerAnthropic(options?: AnthropicRegisterOptions): void {
  if (registered) {
    console.warn("[adk-llm-bridge] anthropic already registered, skipping");
    return;
  }
  if (options) {
    setProviderConfig("anthropic", options);
  }
  LLMRegistry.register(AnthropicLlm);
  registered = true;
}

export function isAnthropicRegistered(): boolean {
  return registered;
}

export function _resetAnthropicRegistration(): void {
  registered = false;
  resetProviderConfig("anthropic");
}
