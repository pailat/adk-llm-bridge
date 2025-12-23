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
 *
 * @module providers
 *
 * @example
 * ```typescript
 * import {
 *   AIGateway,
 *   OpenRouter,
 *   registerAIGateway,
 *   registerOpenRouter
 * } from "adk-llm-bridge";
 * ```
 */

export * from "./ai-gateway";
export * from "./openrouter";
