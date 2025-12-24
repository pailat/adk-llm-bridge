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
// Core (for building custom providers)
// =============================================================================

export { BaseProviderLlm } from "./core/base-provider-llm";
export { OpenAICompatibleLlm } from "./core/openai-compatible-llm";
export type { OpenAIClientConfig } from "./core/openai-compatible-llm";

// =============================================================================
// AI Gateway Provider
// =============================================================================

export { AIGatewayLlm } from "./providers/ai-gateway";
export { AIGateway } from "./providers/ai-gateway";
export {
  registerAIGateway,
  isAIGatewayRegistered,
} from "./providers/ai-gateway";

// =============================================================================
// OpenRouter Provider
// =============================================================================

export { OpenRouterLlm } from "./providers/openrouter";
export { OpenRouter } from "./providers/openrouter";
export {
  registerOpenRouter,
  isOpenRouterRegistered,
} from "./providers/openrouter";

// =============================================================================
// OpenAI Provider
// =============================================================================

export { OpenAILlm } from "./providers/openai";
export { OpenAI } from "./providers/openai";
export { registerOpenAI, isOpenAIRegistered } from "./providers/openai";

// =============================================================================
// xAI Provider
// =============================================================================

export { XAILlm } from "./providers/xai";
export { XAI } from "./providers/xai";
export { registerXAI, isXAIRegistered } from "./providers/xai";

// =============================================================================
// Anthropic Provider
// =============================================================================

export { AnthropicLlm } from "./providers/anthropic";
export { Anthropic } from "./providers/anthropic";
export {
  registerAnthropic,
  isAnthropicRegistered,
} from "./providers/anthropic";

// =============================================================================
// Custom LLM Provider (Any Compatible API)
// =============================================================================

export { CustomLlm, type CustomLlmProviderConfig } from "./providers/custom";
export { createCustomLlm, Custom } from "./providers/custom";

// =============================================================================
// Types
// =============================================================================

export type {
  // Base types
  BaseProviderConfig,
  // AI Gateway types
  AIGatewayConfig,
  RegisterOptions,
  // OpenRouter types
  OpenRouterConfig,
  OpenRouterProviderPreferences,
  OpenRouterRegisterOptions,
  // OpenAI types
  OpenAIProviderConfig,
  OpenAIRegisterOptions,
  // xAI types
  XAIProviderConfig,
  XAIRegisterOptions,
  // Anthropic types
  AnthropicProviderConfig,
  AnthropicRegisterOptions,
  // Custom LLM types
  CustomLlmConfig,
  // Streaming types
  ToolCallAccumulator,
  StreamAccumulator,
  StreamChunkResult,
} from "./types";

// =============================================================================
// Constants
// =============================================================================

export {
  MODEL_PATTERNS,
  DEFAULT_BASE_URL,
  OPENROUTER_BASE_URL,
  OPENROUTER_MODEL_PATTERNS,
  PROVIDER_IDS,
} from "./constants";

// =============================================================================
// Configuration
// =============================================================================

export {
  // Multi-provider API
  setProviderConfig,
  getProviderConfig,
  resetProviderConfig,
  resetAllConfigs,
  // Legacy API (deprecated but still exported for backward compatibility)
  setConfig,
  getConfig,
  resetConfig,
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
