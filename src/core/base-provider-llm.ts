import { BaseLlm } from "@google/adk";
import type { LlmRequest, LlmResponse, BaseLlmConnection } from "@google/adk";
import type { BaseProviderConfig } from "../types";

// Compatibility with @google/adk's BASE_MODEL_SYMBOL (added in adk-js main)
// The symbol is inherited from BaseLlm at runtime, but TypeScript can't verify it
// because the symbol is not exported. This declaration satisfies the type checker.
declare const BASE_MODEL_SYMBOL: unique symbol;

/**
 * Abstract base class for all LLM providers.
 * Extends ADK's BaseLlm and provides common error handling.
 */
export abstract class BaseProviderLlm extends BaseLlm {
  // Inherited from BaseLlm - declared for TypeScript compatibility
  declare readonly [BASE_MODEL_SYMBOL]: true;

  protected readonly config: BaseProviderConfig;

  constructor(config: BaseProviderConfig) {
    super({ model: config.model });
    this.config = config;
  }

  abstract generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void>;

  async connect(_: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.constructor.name} does not support bidirectional streaming`,
    );
  }

  /**
   * Creates a standardized error response.
   * @param error The error that occurred
   * @param prefix Provider-specific error prefix (e.g., "AI_GATEWAY", "OPENROUTER")
   */
  protected createErrorResponse(error: unknown, prefix: string): LlmResponse {
    const isApiError =
      error !== null &&
      typeof error === "object" &&
      "status" in error &&
      typeof (error as { status: unknown }).status === "number";

    return {
      errorCode: isApiError
        ? `API_ERROR_${(error as { status: number }).status}`
        : `${prefix}_ERROR`,
      errorMessage: error instanceof Error ? error.message : String(error),
      turnComplete: true,
    };
  }
}
