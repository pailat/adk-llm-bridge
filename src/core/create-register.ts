/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

/**
 * Factory for creating provider registration functions.
 *
 * Eliminates the duplicated singleton registration pattern that was
 * previously copy-pasted in every provider's register.ts file.
 *
 * @module core/create-register
 */

import type { BaseLlm } from "@google/adk";
import { LLMRegistry } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../config";
import type { ProviderDefinition } from "./provider-definition";

/** Type that LLMRegistry.register() expects. */
type RegisterableLlm = (new (params: { model: string }) => BaseLlm) & {
  readonly supportedModels: (string | RegExp)[];
};

/**
 * Creates registration functions for a provider.
 *
 * Returns an object with `register`, `isRegistered`, and `_reset` functions
 * that implement the idempotent singleton registration pattern.
 *
 * @param definition - The provider definition
 * @param ProviderClass - The LLM class to register (must have static supportedModels)
 * @returns Registration function set
 */
export function createRegisterFunction(
  definition: ProviderDefinition,
  ProviderClass: RegisterableLlm,
) {
  let registered = false;

  return {
    register(options?: Record<string, unknown>): void {
      if (registered) {
        console.warn(
          `[adk-llm-bridge] ${definition.id} already registered, skipping`,
        );
        return;
      }
      if (options) {
        setProviderConfig(
          definition.id as "ai-gateway",
          options as Parameters<typeof setProviderConfig>[1],
        );
      }
      LLMRegistry.register(ProviderClass);
      registered = true;
    },

    isRegistered(): boolean {
      return registered;
    },

    _reset(): void {
      registered = false;
      resetProviderConfig(definition.id as "ai-gateway");
    },
  };
}
