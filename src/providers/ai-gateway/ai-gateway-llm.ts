import { OpenAICompatibleLlm } from "../../core/openai-compatible-llm";
import { getProviderConfig } from "../../config";
import {
  MODEL_PATTERNS,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  ENV,
} from "../../constants";
import type { AIGatewayConfig } from "../../types";

/**
 * LLM implementation for Vercel AI Gateway.
 * Supports 100+ models through a unified OpenAI-compatible API.
 */
export class AIGatewayLlm extends OpenAICompatibleLlm {
  static readonly supportedModels = MODEL_PATTERNS;

  constructor(config: AIGatewayConfig) {
    const globalConfig = getProviderConfig("ai-gateway") ?? {};

    const baseURL =
      config.baseURL ??
      globalConfig.baseURL ??
      process.env[ENV.AI_GATEWAY_URL] ??
      process.env[ENV.OPENAI_BASE_URL] ??
      DEFAULT_BASE_URL;

    const apiKey =
      config.apiKey ??
      globalConfig.apiKey ??
      process.env[ENV.AI_GATEWAY_API_KEY] ??
      process.env[ENV.OPENAI_API_KEY] ??
      "";

    super(config, {
      baseURL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  protected getErrorPrefix(): string {
    return "AI_GATEWAY";
  }
}
