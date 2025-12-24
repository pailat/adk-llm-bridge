/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * LLM provider implementations.
 *
 * This module exports all supported LLM providers:
 * - **AI Gateway**: Vercel's unified gateway for 100+ models
 * - **OpenRouter**: Multi-provider routing with fallbacks and optimization
 * - **OpenAI**: Direct access to OpenAI's API (GPT-4, o1, etc.)
 * - **xAI**: Direct access to xAI's API (Grok models)
 * - **Anthropic**: Direct access to Anthropic's API (Claude models)
 * - **Custom**: Connect to any compatible API (Ollama, vLLM, Azure, etc.)
 *
 * @module providers
 *
 * @example
 * ```typescript
 * import {
 *   AIGateway,
 *   OpenRouter,
 *   OpenAI,
 *   XAI,
 *   Anthropic,
 *   createCustomLlm,
 *   Custom,
 *   registerAIGateway,
 *   registerOpenRouter,
 *   registerOpenAI,
 *   registerXAI,
 *   registerAnthropic
 * } from "adk-llm-bridge";
 * ```
 */

export * from "./ai-gateway";
export * from "./openrouter";
export * from "./openai";
export * from "./xai";
export * from "./anthropic";
export * from "./custom";
