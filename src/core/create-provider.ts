/**
 * Factory utilities for creating provider classes and functions
 * from declarative provider definitions.
 */

import type { BaseProviderConfig } from "../types.js";
import { OpenAICompatibleLlm } from "./openai-compatible-llm.js";
import type { ProviderDefinition } from "./provider-definition.js";

/**
 * A provider class: constructible from `C`, with the static `supportedModels`
 * that `LLMRegistry.register()` reads.
 *
 * @typeParam C - The provider's config type.
 */
export type ProviderLlmClass<
  C extends BaseProviderConfig = BaseProviderConfig,
> = (new (
  config: C,
) => OpenAICompatibleLlm) & {
  readonly supportedModels: (string | RegExp)[];
};

/**
 * A provider factory: `(model, options?) => OpenAICompatibleLlm`.
 *
 * @typeParam C - The provider's config type; `options` is any of its fields
 * except `model`.
 */
export type ProviderLlmFactory<
  C extends BaseProviderConfig = BaseProviderConfig,
> = (model: string, options?: Partial<Omit<C, "model">>) => OpenAICompatibleLlm;

/**
 * Creates a typed LLM class with static `supportedModels` for LLMRegistry.
 *
 * The returned class can be registered with ADK's LLMRegistry and
 * instantiated by model name matching.
 *
 * @typeParam C - The provider's config type (for example `OpenRouterConfig`),
 * so its own options type-check.
 * @param definition - The provider definition
 * @returns A concrete class extending OpenAICompatibleLlm
 */
export function createProviderClass<
  C extends BaseProviderConfig = BaseProviderConfig,
>(definition: ProviderDefinition): ProviderLlmClass<C> {
  return class extends OpenAICompatibleLlm {
    static readonly supportedModels = definition.modelPatterns;

    constructor(config: C) {
      super(definition, config);
    }
  };
}

/**
 * Creates a factory function for convenient provider instantiation.
 *
 * @typeParam C - The provider's config type, so its own options type-check.
 * @param definition - The provider definition
 * @returns A factory function: `(model, options?) => OpenAICompatibleLlm`
 */
export function createProviderFactory<
  C extends BaseProviderConfig = BaseProviderConfig,
>(definition: ProviderDefinition): ProviderLlmFactory<C> {
  return (model, options) =>
    new OpenAICompatibleLlm(definition, { model, ...options } as C);
}
