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

import { getProviderConfig } from "../config.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../constants.js";
import type { BaseProviderConfig } from "../types.js";
import { clampPositive } from "../utils/validate.js";
import type { ProviderDefinition } from "./provider-definition.js";

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

interface ResolvedEnvVar {
  key: string;
  value: string;
}

function resolveEnvVarWithKey(keys: string[]): ResolvedEnvVar | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return { key, value };
  }
  return undefined;
}

function resolveBaseURL(
  definition: ProviderDefinition,
  instanceConfig: BaseProviderConfig,
  globalConfig: Record<string, unknown>,
): string {
  const envValue = resolveEnvVarWithKey(definition.envKeys.baseURL ?? []);
  let value: unknown;
  let source: string;

  if (instanceConfig.baseURL != null) {
    value = instanceConfig.baseURL;
    source = "explicit configuration";
  } else if (globalConfig.baseURL != null) {
    value = globalConfig.baseURL;
    source = "global provider configuration";
  } else if (envValue) {
    value = envValue.value;
    source = `the ${envValue.key} environment variable`;
  } else {
    value = definition.defaultBaseURL;
    source = "the provider default";
  }

  const envHint = definition.envKeys.baseURL?.join(" or ");
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `[${definition.id}] baseURL is required. Provide it via explicit configuration` +
        ` or global provider configuration${envHint ? `, or set ${envHint}` : ""}.`,
    );
  }

  try {
    new URL(value);
  } catch {
    throw new Error(
      `[${definition.id}] Invalid baseURL from ${source}. Provide a valid absolute URL ` +
        "(for example, http://localhost:11434/v1). The configured value was omitted for security.",
    );
  }

  return value;
}

/**
 * Resolves provider configuration from multiple sources.
 *
 * Priority order (highest to lowest) is explicit instance or registration
 * configuration, global provider configuration, environment variables, then
 * provider defaults. A defined value is authoritative: an invalid explicit or
 * global URL fails instead of falling through to a lower-precedence source.
 * URL errors identify the source but never include the configured value, which
 * may contain credentials or other secrets.
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

  const baseURL = resolveBaseURL(definition, instanceConfig, globalConfig);

  const headers =
    definition.buildHeaders?.({
      ...globalConfig,
      ...instanceConfig,
    }) ?? {};

  return {
    apiKey,
    baseURL,
    timeout: clampPositive(
      instanceConfig.timeout ??
        (globalConfig.timeout as number | undefined) ??
        DEFAULT_TIMEOUT,
      DEFAULT_TIMEOUT,
      1000,
    ),
    maxRetries: clampPositive(
      instanceConfig.maxRetries ??
        (globalConfig.maxRetries as number | undefined) ??
        DEFAULT_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      0,
    ),
    headers,
  };
}
