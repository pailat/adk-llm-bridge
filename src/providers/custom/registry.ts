/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Opt-in ADK registry integration for named custom providers.
 *
 * Each registration creates a dedicated class for a finite set of exact model
 * routes. The class closes over the endpoint configuration because ADK's
 * LLMRegistry constructs registered classes with only a model string.
 *
 * @module providers/custom/registry
 */

import { LLMRegistry } from "@google/adk";
import {
  CustomLlm,
  type CustomLlmProviderConfig,
  resolveCustomConfig,
} from "./custom-llm.js";

/** Configuration captured by a named custom-provider registration. */
export type CustomProviderRegistrationConfig = Omit<
  CustomLlmProviderConfig,
  "model"
> & {
  /**
   * Complete remote model IDs exposed by this registration.
   *
   * ADK does not expose its registered patterns, so an open-ended prefix
   * cannot be checked safely for partial overlap. Requiring an explicit list
   * lets this API prove that every route is unclaimed before registering any
   * of them.
   *
   * @example ["llama3", "meta-llama/Llama-3-8b"]
   */
  models: readonly string[];
};

const PREFIX_PATTERN = /^[a-z][a-z0-9._-]*(?:\/[a-z][a-z0-9._-]*)*$/;

/**
 * Prefixes owned by ADK or by first-party bridge providers.
 *
 * Reserving these even before their providers are registered makes validation
 * independent of module import and registration order.
 */
const RESERVED_PREFIXES = new Set([
  "ai-gateway",
  "anthropic",
  "apigee",
  "custom",
  "gemini",
  "google",
  "openai",
  "openrouter",
  "projects",
  "vertex",
  "xai",
]);

const registeredPrefixes = new Set<string>();

function displayPrefix(prefix: unknown): string {
  return typeof prefix === "string" ? JSON.stringify(prefix) : String(prefix);
}

function validatePrefix(prefix: string): void {
  if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `[adk-llm-bridge] Invalid custom provider prefix ${displayPrefix(prefix)}. ` +
        "Use lowercase path segments beginning with a letter and containing only letters, numbers, dots, underscores, or hyphens.",
    );
  }

  const rootPrefix = prefix.split("/", 1)[0];
  if (RESERVED_PREFIXES.has(rootPrefix)) {
    throw new Error(
      `[adk-llm-bridge] Custom provider prefix ${JSON.stringify(prefix)} is reserved.`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function copyConfig<T>(config: T): T {
  try {
    return structuredClone(config);
  } catch (error) {
    throw new Error(
      "[adk-llm-bridge] Custom provider registration configuration must contain only cloneable values.",
      { cause: error },
    );
  }
}

function resolvesInAdk(model: string): boolean {
  try {
    LLMRegistry.resolve(model);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `Model ${model} not found.`
    ) {
      return false;
    }

    throw new Error(
      `[adk-llm-bridge] Could not prove that custom provider route ${JSON.stringify(model)} is unclaimed; ADK registry resolution failed unexpectedly.`,
      { cause: error },
    );
  }
}

/**
 * Registers one named OpenAI-compatible endpoint with ADK's LLMRegistry.
 *
 * Models are addressed as `prefix/remote-model-id`. Every remote model ID must
 * be declared in `config.models`; open-ended prefix ownership is intentionally
 * unsupported because ADK's public registry API cannot prove that an arbitrary
 * existing regular expression does not partially overlap a prefix.
 *
 * Registration is atomic: every exact route is checked before the class is
 * registered. If an existing ADK registration (including AI Gateway or
 * OpenRouter's broad pattern) already resolves any route, this function throws
 * and registers none. Register custom providers before broad providers. When a
 * broad provider is registered later, ADK's first-match ordering leaves these
 * earlier exact routes with the custom provider.
 *
 * @param prefix - Unique routing prefix, for example `ollama` or `local/vllm`
 * @param config - Endpoint configuration captured for all models under prefix
 * @throws If validation fails, a route is claimed, or route safety cannot be proven
 *
 * @example
 * ```typescript
 * registerCustomProvider("ollama", {
 *   baseURL: "http://localhost:11434/v1",
 *   models: ["llama3"],
 * });
 *
 * // ADK resolves this registration and sends `llama3` to Ollama.
 * const agent = new LlmAgent({ model: "ollama/llama3" });
 * ```
 */
export function registerCustomProvider(
  prefix: string,
  config: CustomProviderRegistrationConfig,
): void {
  validatePrefix(prefix);

  if (registeredPrefixes.has(prefix)) {
    throw new Error(
      `[adk-llm-bridge] Custom provider prefix ${JSON.stringify(prefix)} is already registered.`,
    );
  }

  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error(
      `[adk-llm-bridge] Custom provider ${JSON.stringify(prefix)} must declare at least one model.`,
    );
  }

  const { models, ...capturedConfig } = copyConfig(config);

  const remoteModels = [...models];
  for (const model of remoteModels) {
    if (typeof model !== "string" || model.trim().length === 0) {
      throw new Error(
        `[adk-llm-bridge] Custom provider ${JSON.stringify(prefix)} contains an invalid model ID. Model IDs must contain non-whitespace characters.`,
      );
    }
  }

  if (new Set(remoteModels).size !== remoteModels.length) {
    throw new Error(
      `[adk-llm-bridge] Custom provider ${JSON.stringify(prefix)} contains duplicate model IDs.`,
    );
  }

  // Resolve before touching ADK's registry, then capture the result. Named
  // registrations therefore keep a stable endpoint/key even if process.env is
  // changed later, while retaining the deep-copy guarantees from issue #84.
  const resolved = resolveCustomConfig({
    ...capturedConfig,
    model: remoteModels[0],
  });
  const resolvedCapturedConfig = copyConfig({
    ...capturedConfig,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    maxRetries: resolved.maxRetries,
    timeout: resolved.timeout,
  });

  const routes = new Map<string, string>(
    remoteModels.map((model) => [`${prefix}/${model}`, model] as const),
  );
  const conflictingRoute = [...routes.keys()].find(resolvesInAdk);
  if (conflictingRoute) {
    throw new Error(
      `[adk-llm-bridge] Custom provider route ${JSON.stringify(conflictingRoute)} is already claimed by an existing ADK LLM registration. Register custom providers before broad AI Gateway or OpenRouter registrations.`,
    );
  }

  class NamedCustomLlm extends CustomLlm {
    static readonly supportedModels = [...routes.keys()].map(
      (route) => new RegExp(escapeRegExp(route)),
    );

    constructor({ model }: { model: string }) {
      const remoteModel = routes.get(model);
      if (remoteModel === undefined) {
        throw new Error(
          `[adk-llm-bridge] Model ${JSON.stringify(model)} is not declared by custom provider ${JSON.stringify(prefix)}.`,
        );
      }

      super({
        ...copyConfig(resolvedCapturedConfig),
        name: resolvedCapturedConfig.name ?? prefix,
        model: remoteModel,
      });
    }
  }

  LLMRegistry.register(NamedCustomLlm);
  registeredPrefixes.add(prefix);
}
