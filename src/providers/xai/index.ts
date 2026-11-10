import {
  createProviderClass,
  createProviderFactory,
} from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import type { XAIProviderConfig, XAIRegisterOptions } from "../../types.js";
import { XAI_DEFINITION } from "./definition.js";

export { XAI_DEFINITION } from "./definition.js";

/**
 * ADK model class for xAI, registered with `LLMRegistry` by {@link registerXAI}.
 *
 * @remarks
 * The API key is resolved from the instance config, then the global config,
 * then `XAI_API_KEY`.
 */
export const XAILlm = createProviderClass<XAIProviderConfig>(XAI_DEFINITION);
/**
 * Creates an ADK model backed by xAI.
 *
 * @param model - Model id accepted by the provider.
 * @param options - Per-instance options: any `XAIProviderConfig` field except `model`.
 * @returns An ADK `BaseLlm` instance.
 */
export const XAI = createProviderFactory<XAIProviderConfig>(XAI_DEFINITION);

const reg = createRegisterFunction<XAIRegisterOptions>(XAI_DEFINITION, XAILlm);
/**
 * Registers {@link XAILlm} with ADK's `LLMRegistry`.
 *
 * @remarks
 * Idempotent: a second call logs a warning and does nothing. Optional
 * `options` are stored as global config for this provider.
 * @throws InputValidationError (from `@google/adk`) when `timeout` or
 *   `maxRetries` is not an integer, or `timeout` is above
 *   2147483647 ms; nothing is stored or registered then.
 */
export const registerXAI = reg.register;
/** Whether {@link registerXAI} has run. */
export const isXAIRegistered = reg.isRegistered;
/** @internal Resets registration state and global config; for tests. */
export const _resetXAIRegistration = reg._reset;
