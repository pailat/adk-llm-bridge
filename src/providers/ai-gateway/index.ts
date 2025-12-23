/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Vercel AI Gateway provider for ADK.
 *
 * Provides access to 100+ LLM models through Vercel's AI Gateway service.
 *
 * @module providers/ai-gateway
 *
 * @example
 * ```typescript
 * import { AIGateway, registerAIGateway } from "adk-llm-bridge";
 *
 * // Option 1: Factory function
 * const llm = AIGateway("anthropic/claude-sonnet-4");
 *
 * // Option 2: Registry for string model names
 * registerAIGateway({ apiKey: "..." });
 * const agent = new LlmAgent({ model: "anthropic/claude-sonnet-4" });
 * ```
 */

export { AIGatewayLlm } from "./ai-gateway-llm";
export { AIGateway } from "./factory";
export {
  registerAIGateway,
  isAIGatewayRegistered,
  _resetAIGatewayRegistration,
} from "./register";
