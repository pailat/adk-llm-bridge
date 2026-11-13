/**
 * Centralized configuration resolution for OpenAI-compatible providers.
 *
 * Provider constructors share this resolution (instance config, global config,
 * environment) instead of repeating it.
 */

import { InputValidationError } from "@google/adk";
import { getProviderConfig } from "../config.js";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT } from "../constants.js";
import type { BaseProviderConfig } from "../types.js";
import { MAX_TIMEOUT_MS, resolveIntegerOption } from "../utils/validate.js";
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
 * Resolves the first set environment variable from a list of keys.
 *
 * @remarks
 * Values are trimmed, and a blank value counts as unset, as the provider SDKs
 * read their own variables.
 *
 * @param keys - Environment variable names to check, in priority order
 * @returns The first non-blank value, trimmed, or undefined
 */
export function resolveEnvVar(keys: string[]): string | undefined {
  return resolveEnvVarWithKey(keys)?.value;
}

interface ResolvedEnvVar {
  key: string;
  value: string;
}

function resolveEnvVarWithKey(keys: string[]): ResolvedEnvVar | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return { key, value };
  }
  return undefined;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function withoutUndefined(config: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  );
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
    throw new InputValidationError(
      `[${definition.id}] baseURL is required. Provide it via explicit configuration` +
        ` or global provider configuration${envHint ? `, or set ${envHint}` : ""}.`,
    );
  }

  // The SDKs join the base URL and the path as text, so surrounding spaces
  // would end up inside every request URL.
  const url = value.trim();
  try {
    new URL(url);
  } catch {
    throw new InputValidationError(
      `[${definition.id}] Invalid baseURL from ${source}. Provide a valid absolute URL ` +
        "(for example, http://localhost:11434/v1). The configured value was omitted for security.",
    );
  }

  return url;
}

/**
 * Resolves provider configuration from multiple sources.
 *
 * Priority order (highest to lowest) is explicit instance or registration
 * configuration, global provider configuration, environment variables, then
 * provider defaults. A defined value is authoritative: an invalid explicit or
 * global URL fails instead of falling through to a lower-precedence source.
 * URL errors identify the source but never include the configured value, which
 * may contain credentials or other secrets. The base URL is returned trimmed,
 * and environment values are trimmed, a blank one counting as unset. When the
 * definition sets `requireApiKey`, a blank `apiKey` counts as unset at the
 * instance and global levels too (otherwise an explicit `""` sends no
 * credential). An instance key set to `undefined` does not override the
 * global value passed to the definition's `buildHeaders`. With
 * `envApiKeyOnlyWithEnvBaseURL`, the env API key is used only when the base
 * URL also comes from the environment.
 *
 * @param definition - The provider definition with defaults and env var names
 * @param instanceConfig - Instance-level configuration
 * @returns Fully resolved configuration
 * @throws {@link InputValidationError} If a required API key is missing, the base
 *   URL is missing or invalid, or `timeout` or `maxRetries` is set and is not an
 *   integer, or `timeout` is above 2147483647 ms (ADK's `InputValidationError`,
 *   an `Error` subclass). An integer below the minimum (1000 ms, 0 retries) is
 *   clamped, not rejected; `null` counts as unset.
 */
export function resolveConfig(
  definition: ProviderDefinition,
  instanceConfig: BaseProviderConfig,
): ResolvedConfig {
  const globalConfig =
    (getProviderConfig(definition.id as "ai-gateway") as
      | Record<string, unknown>
      | undefined) ?? {};

  // Where a key is required, a blank one can never work, so it counts as
  // unset (as in the environment) and cannot hide a valid lower-precedence
  // key. Elsewhere an explicit `""` means "send no credential".
  const explicitKey = definition.requireApiKey
    ? nonBlank
    : (value: unknown) => value as string | undefined;
  // A base URL set in configuration (instance or global, `null` counting as
  // unset as in `resolveBaseURL`) means the URL does not come from the
  // environment, so such a definition takes no env key for it.
  const configuredBaseURL =
    instanceConfig.baseURL != null || globalConfig.baseURL != null;
  const envKey =
    definition.envApiKeyOnlyWithEnvBaseURL && configuredBaseURL
      ? undefined
      : resolveEnvVar(definition.envKeys.apiKey);
  const apiKey =
    explicitKey(instanceConfig.apiKey) ??
    explicitKey(globalConfig.apiKey) ??
    envKey ??
    "";

  if (definition.requireApiKey && !apiKey) {
    const envHint = definition.envKeys.apiKey.join(" or ");
    throw new InputValidationError(
      `[${definition.id}] API key is required. Provide it via config, ` +
        `setProviderConfig("${definition.id}", { apiKey }), or set the ${envHint} env var.`,
    );
  }

  const baseURL = resolveBaseURL(definition, instanceConfig, globalConfig);

  // An instance key set to `undefined` is unset, so it keeps the global value.
  const headers =
    definition.buildHeaders?.({
      ...globalConfig,
      ...withoutUndefined(instanceConfig),
    }) ?? {};

  return {
    apiKey,
    baseURL,
    timeout: resolveIntegerOption({
      owner: definition.id,
      name: "timeout",
      value: instanceConfig.timeout ?? globalConfig.timeout,
      fallback: DEFAULT_TIMEOUT,
      min: 1000,
      max: MAX_TIMEOUT_MS,
    }),
    maxRetries: resolveIntegerOption({
      owner: definition.id,
      name: "maxRetries",
      value: instanceConfig.maxRetries ?? globalConfig.maxRetries,
      fallback: DEFAULT_MAX_RETRIES,
      min: 0,
    }),
    headers,
  };
}
