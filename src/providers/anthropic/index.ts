/**
 * Anthropic (Claude) provider module.
 */

import { createRegisterFunction } from "../../core/create-register.js";
import type {
  AnthropicProviderConfig,
  AnthropicRegisterOptions,
} from "../../types.js";
import { AnthropicLlm } from "./anthropic-llm.js";

export { AnthropicLlm } from "./anthropic-llm.js";

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

const reg = createRegisterFunction<AnthropicRegisterOptions>(
  { id: "anthropic" },
  AnthropicLlm,
);

/**
 * Registers {@link AnthropicLlm} with ADK's `LLMRegistry`.
 *
 * @remarks
 * Idempotent: a second call logs a warning and does nothing.
 *
 * @param options - Optional global config stored for the `anthropic` provider.
 * @throws InputValidationError (from `@google/adk`) when `timeout`,
 *   `maxRetries` or `maxTokens` is not an integer, or `timeout` is above
 *   2147483647 ms; nothing is stored or registered then.
 */
export function registerAnthropic(options?: AnthropicRegisterOptions): void {
  reg.register(options);
}

/** Whether {@link registerAnthropic} has run. */
export function isAnthropicRegistered(): boolean {
  return reg.isRegistered();
}

/** @internal Resets registration state and global config; for tests. */
export function _resetAnthropicRegistration(): void {
  reg._reset();
}
