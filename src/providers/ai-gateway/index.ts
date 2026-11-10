import {
  createProviderClass,
  createProviderFactory,
} from "../../core/create-provider.js";
import { createRegisterFunction } from "../../core/create-register.js";
import type {
  AIGatewayProviderConfig,
  AIGatewayRegisterOptions,
} from "../../types.js";
import { AI_GATEWAY_DEFINITION } from "./definition.js";

export { AI_GATEWAY_DEFINITION } from "./definition.js";

/**
 * ADK model class for Vercel AI Gateway, registered with `LLMRegistry` by {@link registerAIGateway}.
 *
 * @remarks
 * The API key is resolved from the instance config, then the global config,
 * then `AI_GATEWAY_API_KEY`. `OPENAI_API_KEY` is never read. The base URL
 * comes from the instance config, then the global config, then
 * `AI_GATEWAY_URL`, then the default gateway URL; `OPENAI_BASE_URL` is never
 * read. No `OpenAI-Organization` or `OpenAI-Project` header is sent.
 */
export const AIGatewayLlm = createProviderClass<AIGatewayProviderConfig>(
  AI_GATEWAY_DEFINITION,
);
/**
 * Creates an ADK model backed by Vercel AI Gateway.
 *
 * @param model - Model id accepted by the provider.
 * @param options - Per-instance options: any `AIGatewayProviderConfig` field except `model`.
 * @returns An ADK `BaseLlm` instance.
 */
export const AIGateway = createProviderFactory<AIGatewayProviderConfig>(
  AI_GATEWAY_DEFINITION,
);

const reg = createRegisterFunction<AIGatewayRegisterOptions>(
  AI_GATEWAY_DEFINITION,
  AIGatewayLlm,
);
/**
 * Registers {@link AIGatewayLlm} with ADK's `LLMRegistry`.
 *
 * @remarks
 * Idempotent: a second call logs a warning and does nothing. Optional
 * `options` are stored as global config for this provider.
 * @throws InputValidationError (from `@google/adk`) when `timeout` or
 *   `maxRetries` is not an integer, or `timeout` is above
 *   2147483647 ms; nothing is stored or registered then.
 */
export const registerAIGateway = reg.register;
/** Whether {@link registerAIGateway} has run. */
export const isAIGatewayRegistered = reg.isRegistered;
/** @internal Resets registration state and global config; for tests. */
export const _resetAIGatewayRegistration = reg._reset;
