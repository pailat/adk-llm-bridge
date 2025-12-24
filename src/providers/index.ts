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
 * - **Custom**: Connect to any compatible API (Ollama, vLLM, Azure, etc.)
 *
 * @module providers
 *
 * @example
 * ```typescript
 * import {
 *   AIGateway,
 *   OpenRouter,
 *   createCustomLlm,
 *   Custom,
 *   registerAIGateway,
 *   registerOpenRouter
 * } from "adk-llm-bridge";
 * ```
 */

export * from "./ai-gateway";
export * from "./openrouter";
export * from "./custom";
