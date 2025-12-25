/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenAI LLM provider implementation.
 *
 * This module provides the OpenAI-specific LLM class that connects
 * directly to OpenAI's API.
 *
 * @module providers/openai/openai-llm
 */

import { getProviderConfig } from "../../config";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../../constants";
import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import type { OpenAIProviderConfig } from "../../types";
import {
  OPENAI_BASE_URL,
  OPENAI_ENV,
  OPENAI_MODEL_PATTERNS,
} from "./constants";

/**
 * OpenAI LLM provider.
 *
 * Provides direct access to OpenAI's API for models like GPT-4, o1, and GPT-4o.
 * Uses the OpenAI SDK under the hood with automatic configuration resolution.
 *
 * Configuration priority (highest to lowest):
 * 1. Instance configuration (passed to constructor)
 * 2. Global configuration (via `setProviderConfig("openai", {...})`)
 * 3. Environment variables (`OPENAI_API_KEY`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`)
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = new OpenAILlm({ model: "gpt-4.1" });
 *
 * // With organization
 * const llm = new OpenAILlm({
 *   model: "gpt-4.1",
 *   apiKey: "sk-...",
 *   organization: "org-xxx"
 * });
 * ```
 *
 * @see {@link OpenAI} for the recommended factory function
 * @see {@link registerOpenAI} for LLMRegistry integration
 */
export class OpenAILlm extends OpenAICompatibleLlm {
  /**
   * Model patterns supported by this provider.
   *
   * Used by ADK's LLMRegistry to match model strings to this provider.
   * Matches: gpt-*, o*, chatgpt-*
   *
   * @static
   */
  static readonly supportedModels = OPENAI_MODEL_PATTERNS;

  /**
   * Creates a new OpenAI LLM instance.
   *
   * @param config - Configuration options for the OpenAI provider
   *
   * @example
   * ```typescript
   * const llm = new OpenAILlm({
   *   model: "gpt-4.1",
   *   apiKey: process.env.OPENAI_API_KEY,
   *   organization: "org-xxx",
   *   project: "proj-xxx"
   * });
   * ```
   */
  constructor(config: OpenAIProviderConfig) {
    const globalConfig = getProviderConfig("openai") ?? {};

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[OPENAI_ENV.API_KEY] ??
      "";

    const organization =
      config.organization ??
      globalConfig.organization ??
      process.env[OPENAI_ENV.ORGANIZATION];

    const project =
      config.project ?? globalConfig.project ?? process.env[OPENAI_ENV.PROJECT];

    // Build headers for organization/project
    const defaultHeaders: Record<string, string> = {};
    if (organization) {
      defaultHeaders["OpenAI-Organization"] = organization;
    }
    if (project) {
      defaultHeaders["OpenAI-Project"] = project;
    }

    super(config, {
      baseURL: OPENAI_BASE_URL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      defaultHeaders:
        Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });
  }

  /**
   * Returns the error prefix for OpenAI-specific errors.
   *
   * @returns "OPENAI"
   * @protected
   */
  protected getErrorPrefix(): string {
    return "OPENAI";
  }
}
