import type { LlmResponse } from "@google/adk";

export interface AIGatewayConfig {
  model: string;
  baseURL?: string;
  apiKey?: string;
  timeout?: number;
  maxRetries?: number;
}

export interface RegisterOptions {
  baseURL?: string;
  apiKey?: string;
}

export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamAccumulator {
  text: string;
  toolCalls: Map<number, ToolCallAccumulator>;
}

export interface StreamChunkResult {
  response?: LlmResponse;
  isComplete: boolean;
}
