/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Core base classes for LLM provider implementations.
 *
 * This module exports the abstract base classes that all providers extend.
 * Use these classes when implementing custom provider support.
 *
 * - {@link BaseProviderLlm}: Abstract base for all providers
 * - {@link OpenAICompatibleLlm}: Base for OpenAI-compatible APIs
 *
 * @module core
 *
 * @example
 * ```typescript
 * import { OpenAICompatibleLlm } from "adk-llm-bridge";
 * import type { OpenAIClientConfig } from "adk-llm-bridge";
 *
 * class CustomLlm extends OpenAICompatibleLlm {
 *   constructor(config: CustomConfig) {
 *     super(config, {
 *       baseURL: "https://api.custom.com/v1",
 *       apiKey: config.apiKey,
 *       timeout: 60000,
 *       maxRetries: 2
 *     });
 *   }
 *
 *   protected getErrorPrefix(): string {
 *     return "CUSTOM";
 *   }
 * }
 * ```
 */

export { BaseProviderLlm } from "./base-provider-llm";
export { OpenAICompatibleLlm } from "./openai-compatible-llm";
export type { OpenAIClientConfig } from "./openai-compatible-llm";
