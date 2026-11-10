import {
  createProviderClass,
  createProviderFactory,
} from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import type {
  OpenRouterProviderConfig,
  OpenRouterRegisterOptions,
} from "../../types.js";
import { OPENROUTER_DEFINITION } from "./definition.js";

export { OPENROUTER_DEFINITION } from "./definition.js";

/**
 * ADK model class for OpenRouter, registered with `LLMRegistry` by {@link registerOpenRouter}.
 *
 * @remarks
 * The API key is resolved from the instance config, then the global config,
 * then `OPENROUTER_API_KEY`.
 */
export const OpenRouterLlm = createProviderClass<OpenRouterProviderConfig>(
  OPENROUTER_DEFINITION,
);
/**
 * Creates an ADK model backed by OpenRouter.
 *
 * @param model - Model id accepted by the provider.
 * @param options - Per-instance options: any `OpenRouterProviderConfig` field except `model`.
 * @returns An ADK `BaseLlm` instance.
 */
export const OpenRouter = createProviderFactory<OpenRouterProviderConfig>(
  OPENROUTER_DEFINITION,
);

const reg = createRegisterFunction<OpenRouterRegisterOptions>(
  OPENROUTER_DEFINITION,
  OpenRouterLlm,
);
/**
 * Registers {@link OpenRouterLlm} with ADK's `LLMRegistry`.
 *
 * @remarks
 * Idempotent: a second call logs a warning and does nothing. Optional
 * `options` are stored as global config for this provider.
 * @throws InputValidationError (from `@google/adk`) when `timeout` or
 *   `maxRetries` is not an integer, or `timeout` is above
 *   2147483647 ms; nothing is stored or registered then.
 */
export const registerOpenRouter = reg.register;
/** Whether {@link registerOpenRouter} has run. */
export const isOpenRouterRegistered = reg.isRegistered;
/** @internal Resets registration state and global config; for tests. */
export const _resetOpenRouterRegistration = reg._reset;
