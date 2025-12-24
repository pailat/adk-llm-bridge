/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Anthropic (Claude) provider module.
 *
 * Provides direct access to Anthropic's Messages API for Claude models.
 *
 * @module providers/anthropic
 *
 * @example
 * ```typescript
 * import { Anthropic, registerAnthropic } from "adk-llm-bridge";
 *
 * // Option 1: Factory function
 * const llm = Anthropic("claude-sonnet-4-5-20250929");
 *
 * // Option 2: Registry integration
 * registerAnthropic();
 * const agent = new LlmAgent({ model: "claude-sonnet-4-5-20250929" });
 * ```
 */

export { AnthropicLlm } from "./anthropic-llm";
export { Anthropic } from "./factory";
export {
  registerAnthropic,
  isAnthropicRegistered,
  _resetAnthropicRegistration,
} from "./register";
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENV,
  ANTHROPIC_MODEL_PATTERNS,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from "./constants";

// Export converters for potential custom implementations
export { convertAnthropicRequest } from "./converters/request";
export type { ConvertedAnthropicRequest } from "./converters/request";
export {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./converters/response";
export type {
  AnthropicStreamAccumulator,
  AnthropicStreamResult,
} from "./converters/response";
