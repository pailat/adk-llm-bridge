import { AIGatewayLlm } from "./ai-gateway-llm";
import type { AIGatewayConfig } from "../../types";

type AIGatewayOptions = Omit<AIGatewayConfig, "model">;

/**
 * Factory function to create an AI Gateway LLM instance.
 *
 * @example
 * ```typescript
 * const llm = AIGateway("anthropic/claude-sonnet-4", {
 *   apiKey: process.env.AI_GATEWAY_API_KEY,
 * });
 * ```
 */
export function AIGateway(
  model: string,
  options?: AIGatewayOptions,
): AIGatewayLlm {
  return new AIGatewayLlm({ model, ...options });
}
