/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI provider module.
 *
 * Provides direct access to OpenAI's API for GPT-4, o1, and other models.
 *
 * @module providers/openai
 *
 * @example
 * ```typescript
 * import { OpenAI, registerOpenAI } from "adk-llm-bridge";
 *
 * // Option 1: Factory function
 * const llm = OpenAI("gpt-4.1");
 *
 * // Option 2: Registry integration
 * registerOpenAI();
 * const agent = new LlmAgent({ model: "gpt-4.1" });
 * ```
 */

export { OpenAILlm } from "./openai-llm";
export { OpenAI } from "./factory";
export {
  registerOpenAI,
  isOpenAIRegistered,
  _resetOpenAIRegistration,
} from "./register";
export { OPENAI_BASE_URL, OPENAI_ENV, OPENAI_MODEL_PATTERNS } from "./constants";
