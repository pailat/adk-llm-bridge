import { BaseLlm } from "@google/adk";
import type { LlmRequest, LlmResponse, BaseLlmConnection } from "@google/adk";
import OpenAI from "openai";
import { convertRequest } from "./converters/request";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "./converters/response";
import { getConfig } from "./config";
import {
  MODEL_PATTERNS,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  ENV,
} from "./constants";
import type { AIGatewayConfig } from "./types";

// Compatibility with @google/adk's BASE_MODEL_SYMBOL (added in adk-js main)
// The symbol is inherited from BaseLlm at runtime, but TypeScript can't verify it
// because the symbol is not exported. This declaration satisfies the type checker.
declare const BASE_MODEL_SYMBOL: unique symbol;

export class AIGatewayLlm extends BaseLlm {
  // Inherited from BaseLlm - declared for TypeScript compatibility
  declare readonly [BASE_MODEL_SYMBOL]: true;

  private readonly client: OpenAI;
  static readonly supportedModels = MODEL_PATTERNS;

  constructor(config: AIGatewayConfig) {
    super({ model: config.model });

    const globalConfig = getConfig();

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

    this.client = new OpenAI({
      baseURL,
      apiKey,
      timeout: config.timeout ?? DEFAULT_TIMEOUT,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    try {
      const { messages, tools } = convertRequest(llmRequest);

      if (stream) {
        yield* this.streamResponse(messages, tools);
      } else {
        yield await this.singleResponse(messages, tools);
      }
    } catch (error) {
      yield this.errorResponse(error);
    }
  }

  async connect(_: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error("AIGatewayLlm does not support bidirectional streaming");
  }

  private async singleResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(tools?.length ? { tools } : {}),
    });
    return convertResponse(response);
  }

  private async *streamResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): AsyncGenerator<LlmResponse, void> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      stream: true,
      ...(tools?.length ? { tools } : {}),
    });

    const acc = createStreamAccumulator();

    for await (const chunk of stream) {
      const { response, isComplete } = convertStreamChunk(chunk, acc);
      if (response) yield response;
      if (isComplete) break;
    }
  }

  private errorResponse(error: unknown): LlmResponse {
    const isApiError = error instanceof OpenAI.APIError;
    return {
      errorCode: isApiError ? `API_ERROR_${error.status}` : "AI_GATEWAY_ERROR",
      errorMessage: error instanceof Error ? error.message : String(error),
      turnComplete: true,
    };
  }
}
