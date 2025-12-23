import OpenAI from "openai";
import type { LlmRequest, LlmResponse } from "@google/adk";
import { BaseProviderLlm } from "./base-provider-llm";
import { convertRequest } from "../converters/request";
import {
  convertResponse,
  convertStreamChunk,
  createStreamAccumulator,
} from "../converters/response";
import type { BaseProviderConfig } from "../types";

export interface OpenAIClientConfig {
  baseURL: string;
  apiKey: string;
  timeout: number;
  maxRetries: number;
  defaultHeaders?: Record<string, string>;
}

/**
 * Base class for LLM providers that use OpenAI-compatible APIs.
 * Handles the common logic for making requests and processing responses.
 */
export abstract class OpenAICompatibleLlm extends BaseProviderLlm {
  protected readonly client: OpenAI;

  constructor(config: BaseProviderConfig, clientConfig: OpenAIClientConfig) {
    super(config);
    this.client = new OpenAI({
      baseURL: clientConfig.baseURL,
      apiKey: clientConfig.apiKey,
      timeout: clientConfig.timeout,
      maxRetries: clientConfig.maxRetries,
      defaultHeaders: clientConfig.defaultHeaders,
    });
  }

  /**
   * Provider-specific error prefix for error responses.
   * Override in subclasses (e.g., "AI_GATEWAY", "OPENROUTER").
   */
  protected abstract getErrorPrefix(): string;

  /**
   * Override to add provider-specific request options.
   * These options are merged into the chat completion request.
   */
  protected getProviderRequestOptions(): Record<string, unknown> {
    return {};
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
      yield this.createErrorResponse(error, this.getErrorPrefix());
    }
  }

  private async singleResponse(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools?: OpenAI.ChatCompletionTool[],
  ): Promise<LlmResponse> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...this.getProviderRequestOptions(),
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
      ...this.getProviderRequestOptions(),
    });

    const acc = createStreamAccumulator();

    for await (const chunk of stream) {
      const { response, isComplete } = convertStreamChunk(chunk, acc);
      if (response) yield response;
      if (isComplete) break;
    }
  }
}
