import { OpenRouterLlm } from "./openrouter-llm";
import type { OpenRouterConfig } from "../../types";

type OpenRouterOptions = Omit<OpenRouterConfig, "model">;

/**
 * Factory function to create an OpenRouter LLM instance.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const llm = OpenRouter("anthropic/claude-sonnet-4");
 *
 * // With options
 * const llm = OpenRouter("anthropic/claude-sonnet-4", {
 *   siteUrl: "https://myapp.com",
 *   appName: "My App",
 *   provider: {
 *     sort: "latency",
 *     allow_fallbacks: true,
 *   },
 * });
 * ```
 */
export function OpenRouter(
  model: string,
  options?: OpenRouterOptions,
): OpenRouterLlm {
  return new OpenRouterLlm({ model, ...options });
}
