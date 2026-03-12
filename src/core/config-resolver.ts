/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Centralized configuration resolution for OpenAI-compatible providers.
 *
 * Eliminates the duplicated config resolution logic that was previously
 * copy-pasted in every provider constructor.
 *
 * @module core/config-resolver
 */

import { getProviderConfig } from "../config";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../constants";
import type { BaseProviderConfig } from "../types";
import { clampPositive, requireValidURL } from "../utils/validate";
import type { ProviderDefinition } from "./provider-definition";

/**
 * Fully resolved configuration ready to create an OpenAI client.
 */
export interface ResolvedConfig {
  baseURL: string;
  apiKey: string;
  timeout: number;
  maxRetries: number;
  headers: Record<string, string>;
}

/**
 * Resolves the first defined environment variable from a list of keys.
 *
 * @param keys - Environment variable names to check, in priority order
 * @returns The first found value, or undefined
 */
export function resolveEnvVar(keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolves provider configuration from multiple sources.
 *
 * Priority order (highest to lowest):
 * 1. Instance config (passed to constructor)
 * 2. Global config (via setProviderConfig)
 * 3. Environment variables
 * 4. Default values from the provider definition
 *
 * @param definition - The provider definition with defaults and env var names
 * @param instanceConfig - Instance-level configuration
 * @returns Fully resolved configuration
 */
export function resolveConfig(
  definition: ProviderDefinition,
  instanceConfig: BaseProviderConfig,
): ResolvedConfig {
  const globalConfig =
    (getProviderConfig(definition.id as "ai-gateway") as
      | Record<string, unknown>
      | undefined) ?? {};

  const apiKey =
    instanceConfig.apiKey ??
    (globalConfig.apiKey as string | undefined) ??
    resolveEnvVar(definition.envKeys.apiKey) ??
    "";

  if (definition.requireApiKey && !apiKey) {
    const envHint = definition.envKeys.apiKey.join(" or ");
    throw new Error(
      `[${definition.id}] API key is required. Provide it via config, ` +
        `setProviderConfig("${definition.id}", { apiKey }), or set the ${envHint} env var.`,
    );
  }

  const baseURL =
    instanceConfig.baseURL ??
    (globalConfig.baseURL as string | undefined) ??
    resolveEnvVar(definition.envKeys.baseURL ?? []) ??
    definition.defaultBaseURL;

  requireValidURL(baseURL, "baseURL", definition.id);

  const headers =
    definition.buildHeaders?.({
      ...globalConfig,
      ...instanceConfig,
    }) ?? {};

  return {
    apiKey,
    baseURL,
    timeout: clampPositive(
      instanceConfig.timeout ?? DEFAULT_TIMEOUT,
      DEFAULT_TIMEOUT,
      1000,
    ),
    maxRetries: clampPositive(
      instanceConfig.maxRetries ?? DEFAULT_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      0,
    ),
    headers,
  };
}
