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
export {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_ENV,
  ANTHROPIC_MODEL_PATTERNS,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
} from "./constants";
export type { ConvertedAnthropicRequest } from "./converters/request";
// Export converters for potential custom implementations
export { convertAnthropicRequest } from "./converters/request";
export type {
  AnthropicStreamAccumulator,
  AnthropicStreamResult,
} from "./converters/response";
export {
  convertAnthropicResponse,
  convertAnthropicStreamEvent,
  createAnthropicStreamAccumulator,
} from "./converters/response";
export { Anthropic } from "./factory";
export {
  _resetAnthropicRegistration,
  isAnthropicRegistered,
  registerAnthropic,
} from "./register";
