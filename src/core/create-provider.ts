/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory utilities for creating provider classes and functions
 * from declarative provider definitions.
 *
 * @module core/create-provider
 */

import type { BaseLlm } from "@google/adk";
import type { BaseProviderConfig } from "../types";
import { OpenAICompatibleLlm } from "./openai-compatible-llm";
import type { ProviderDefinition } from "./provider-definition";

/** Type compatible with LLMRegistry.register(). */
type RegisterableLlm = (new (params: { model: string }) => BaseLlm) & {
  readonly supportedModels: (string | RegExp)[];
};

/**
 * Creates a typed LLM class with static `supportedModels` for LLMRegistry.
 *
 * The returned class can be registered with ADK's LLMRegistry and
 * instantiated by model name matching.
 *
 * @param definition - The provider definition
 * @returns A concrete class extending OpenAICompatibleLlm
 */
export function createProviderClass(
  definition: ProviderDefinition,
): RegisterableLlm {
  return class extends OpenAICompatibleLlm {
    static readonly supportedModels = definition.modelPatterns;

    constructor(config: BaseProviderConfig) {
      super(definition, config);
    }
  };
}

/**
 * Creates a factory function for convenient provider instantiation.
 *
 * @param definition - The provider definition
 * @returns A factory function: `(model, options?) => OpenAICompatibleLlm`
 */
export function createProviderFactory(definition: ProviderDefinition) {
  return (
    model: string,
    options?: Partial<Omit<BaseProviderConfig, "model">>,
  ): OpenAICompatibleLlm =>
    new OpenAICompatibleLlm(definition, { model, ...options });
}
