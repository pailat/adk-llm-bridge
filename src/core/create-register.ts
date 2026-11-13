/**
 * Factory for creating provider registration functions.
 *
 * Each provider shares one singleton registration instead of repeating it in
 * its own `register.ts`.
 */

import type { BaseLlm } from "@google/adk";
import { LLMRegistry } from "@google/adk";
import { resetProviderConfig, setProviderConfig } from "../config.js";
import { LogCode, warn } from "../utils/log.js";
import { checkIntegerOptions } from "../utils/validate.js";
import type { ProviderDefinition } from "./provider-definition.js";

/** Type that LLMRegistry.register() expects. */
type RegisterableLlm = (new (params: {
  model: string;
}) => BaseLlm) & {
  readonly supportedModels: (string | RegExp)[];
};

/**
 * Creates registration functions for a provider.
 *
 * Returns an object with `register`, `isRegistered`, and `_reset` functions
 * that implement the idempotent singleton registration pattern.
 *
 * @typeParam O - The options `register` takes; they are stored as the
 * provider's global config.
 * @param definition - The provider definition, or just its `id`
 * @param ProviderClass - The LLM class to register (must have static supportedModels)
 * @returns Registration function set. `register` throws ADK's
 *   `InputValidationError` when `timeout`, `maxRetries` or `maxTokens` is set
 *   and is not an integer, or `timeout` is above 2147483647 ms, before it
 *   stores or registers anything.
 */
export function createRegisterFunction<
  O extends object = Record<string, unknown>,
>(definition: Pick<ProviderDefinition, "id">, ProviderClass: RegisterableLlm) {
  let registered = false;

  return {
    register(options?: O): void {
      if (registered) {
        warn(
          LogCode.ALREADY_REGISTERED,
          `${definition.id} already registered, skipping`,
        );
        return;
      }
      if (options) {
        checkIntegerOptions(definition.id, options);
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
