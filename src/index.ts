/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * adk-llm-bridge - Connect Google ADK to 100+ LLM models.
 *
 * This library bridges Google ADK (Agent Development Kit) to multiple LLM providers
 * through OpenAI-compatible APIs, enabling access to models from Anthropic, OpenAI,
 * Google, Meta, and more while preserving ADK features like multi-agent orchestration,
 * tool calling, and streaming.
 *
 * ## Supported Providers
 *
 * - **AI Gateway** (Vercel): Unified gateway for 100+ models
 * - **OpenRouter**: Multi-provider routing with fallbacks and price optimization
 *
 * ## Quick Start
 *
 * ### Option 1: Factory Functions (Recommended)
 *
 * ```typescript
 * import { AIGateway, OpenRouter } from "adk-llm-bridge";
 * import { LlmAgent } from "@google/adk";
 *
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   llm: AIGateway("anthropic/claude-sonnet-4")
 * });
 * ```
 *
 * ### Option 2: Registry (for adk-devtools)
 *
 * ```typescript
 * import { registerAIGateway } from "adk-llm-bridge";
 * import { LlmAgent } from "@google/adk";
 *
 * registerAIGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
 *
 * const agent = new LlmAgent({
 *   name: "assistant",
 *   model: "anthropic/claude-sonnet-4"
 * });
 * ```
 *
 * ## Configuration
 *
 * Configuration is resolved in priority order:
 * 1. Instance configuration (passed to constructor/factory)
 * 2. Global configuration (via `setProviderConfig`)
 * 3. Environment variables
 * 4. Default values
 *
 * @module adk-llm-bridge
 *
 * @see {@link https://github.com/pailat/adk-llm-bridge|GitHub Repository}
 * @see {@link https://google.github.io/adk-docs/|Google ADK Documentation}
 */

// =============================================================================
// Re-exports from @google/adk (for type consistency)
// =============================================================================

// Re-export BaseLlm to ensure consumers use the same instance
// This prevents TypeScript errors from duplicate @google/adk installations
export { BaseLlm } from "@google/adk";

// =============================================================================
// Core (for building custom providers)
// =============================================================================

export { BaseProviderLlm } from "./core/base-provider-llm";
export type { OpenAIClientConfig } from "./core/openai-compatible-llm";
export { OpenAICompatibleLlm } from "./core/openai-compatible-llm";

// =============================================================================
// AI Gateway Provider
// =============================================================================

export {
  AIGateway,
  AIGatewayLlm,
  isAIGatewayRegistered,
  registerAIGateway,
} from "./providers/ai-gateway";

// =============================================================================
// OpenRouter Provider
// =============================================================================

export {
  isOpenRouterRegistered,
  OpenRouter,
  OpenRouterLlm,
  registerOpenRouter,
} from "./providers/openrouter";

// =============================================================================
// OpenAI Provider
// =============================================================================

export {
  isOpenAIRegistered,
  OpenAI,
  OpenAILlm,
  registerOpenAI,
} from "./providers/openai";

// =============================================================================
// xAI Provider
// =============================================================================

export { isXAIRegistered, registerXAI, XAI, XAILlm } from "./providers/xai";

// =============================================================================
// Anthropic Provider
// =============================================================================

export {
  Anthropic,
  AnthropicLlm,
  isAnthropicRegistered,
  registerAnthropic,
} from "./providers/anthropic";

// =============================================================================
// Custom LLM Provider (Any Compatible API)
// =============================================================================

export {
  Custom,
  CustomLlm,
  type CustomLlmProviderConfig,
  createCustomLlm,
} from "./providers/custom";

// =============================================================================
// Types
// =============================================================================

export type {
  // AI Gateway types
  AIGatewayConfig,
  // Anthropic types
  AnthropicProviderConfig,
  AnthropicRegisterOptions,
  // Base types
  BaseProviderConfig,
  // Custom LLM types
  CustomLlmConfig,
  // OpenAI types
  OpenAIProviderConfig,
  OpenAIRegisterOptions,
  // OpenRouter types
  OpenRouterConfig,
  OpenRouterProviderPreferences,
  OpenRouterRegisterOptions,
  RegisterOptions,
  StreamAccumulator,
  StreamChunkResult,
  // Streaming types
  ToolCallAccumulator,
  // xAI types
  XAIProviderConfig,
  XAIRegisterOptions,
} from "./types";

// =============================================================================
// Constants
// =============================================================================

export {
  DEFAULT_BASE_URL,
  MODEL_PATTERNS,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_PATTERNS,
  PROVIDER_IDS,
} from "./constants";

// =============================================================================
// Configuration
// =============================================================================

export {
  getConfig,
  getProviderConfig,
  resetAllConfigs,
  resetConfig,
  resetProviderConfig,
  // Legacy API (deprecated but still exported for backward compatibility)
  setConfig,
  // Multi-provider API
  setProviderConfig,
} from "./config";

// =============================================================================
// Converters (for building custom providers)
// =============================================================================

export { convertRequest } from "./converters/request";
export {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "./converters/response";
