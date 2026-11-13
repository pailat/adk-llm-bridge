import {
  createProviderClass,
  createProviderFactory,
} from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import type {
  OpenAIProviderConfig,
  OpenAIRegisterOptions,
} from "../../types.js";
import { OPENAI_DEFINITION } from "./definition.js";

export { OPENAI_DEFINITION } from "./definition.js";

/**
 * ADK model class for OpenAI, registered with `LLMRegistry` by {@link registerOpenAI}.
 *
 * @remarks
 * The API key is resolved from the instance config, then the global config,
 * then `OPENAI_API_KEY`. The organization and project headers come from the
 * config, then `OPENAI_ORGANIZATION` / `OPENAI_PROJECT`, then the OpenAI SDK's
 * own `OPENAI_ORG_ID` / `OPENAI_PROJECT_ID`.
 */
export const OpenAILlm =
  createProviderClass<OpenAIProviderConfig>(OPENAI_DEFINITION);
/**
 * Creates an ADK model backed by OpenAI.
 *
 * @param model - Model id accepted by the provider.
 * @param options - Per-instance options: any `OpenAIProviderConfig` field except `model`.
 * @returns An ADK `BaseLlm` instance.
 */
export const OpenAI =
  createProviderFactory<OpenAIProviderConfig>(OPENAI_DEFINITION);

const reg = createRegisterFunction<OpenAIRegisterOptions>(
  OPENAI_DEFINITION,
  OpenAILlm,
);
/**
 * Registers {@link OpenAILlm} with ADK's `LLMRegistry`.
 *
 * @remarks
 * Idempotent: a second call logs a warning and does nothing. Optional
 * `options` are stored as global config for this provider.
 * @throws InputValidationError (from `@google/adk`) when `timeout` or
 *   `maxRetries` is not an integer, or `timeout` is above
 *   2147483647 ms; nothing is stored or registered then.
 */
export const registerOpenAI = reg.register;
/** Whether {@link registerOpenAI} has run. */
export const isOpenAIRegistered = reg.isRegistered;
/** @internal Resets registration state and global config; for tests. */
export const _resetOpenAIRegistration = reg._reset;
