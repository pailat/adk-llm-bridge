import { AIGatewayLlm } from "./ai-gateway-llm";
import type { AIGatewayConfig } from "./types";

type AIGatewayOptions = Omit<AIGatewayConfig, "model">;

export function AIGateway(
  model: string,
  options?: AIGatewayOptions,
): AIGatewayLlm {
  return new AIGatewayLlm({ model, ...options });
}
