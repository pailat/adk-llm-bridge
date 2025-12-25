/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * xAI (Grok) provider module.
 *
 * Provides direct access to xAI's API for Grok models.
 *
 * @module providers/xai
 *
 * @example
 * ```typescript
 * import { XAI, registerXAI } from "adk-llm-bridge";
 *
 * // Option 1: Factory function
 * const llm = XAI("grok-4");
 *
 * // Option 2: Registry integration
 * registerXAI();
 * const agent = new LlmAgent({ model: "grok-4" });
 * ```
 */

export { XAI_BASE_URL, XAI_ENV, XAI_MODEL_PATTERNS } from "./constants";
export { XAI } from "./factory";
export {
  _resetXAIRegistration,
  isXAIRegistered,
  registerXAI,
} from "./register";
export { XAILlm } from "./xai-llm";
