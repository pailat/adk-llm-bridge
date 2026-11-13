import type { ProviderDefinition } from "../../core/provider-definition.js";

/** Declarative definition of the Vercel AI Gateway provider (endpoint, env keys, model patterns). */
export const AI_GATEWAY_DEFINITION: ProviderDefinition = {
  id: "ai-gateway",
  errorPrefix: "AI_GATEWAY",
  defaultBaseURL: "https://ai-gateway.vercel.sh/v1",
  // Only the gateway's own variables: an OpenAI key or base URL must never
  // reach ai-gateway.vercel.sh.
  envKeys: {
    apiKey: ["AI_GATEWAY_API_KEY"],
    baseURL: ["AI_GATEWAY_URL"],
  },
  modelPatterns: [/.+\/.+/],
  requireApiKey: true,
  // AI Gateway proxies arbitrary vendor/model ids (same permissive reasoning
  // semantics as OpenRouter): always send the native reasoning object.
  reasoning: { style: "openrouter" },
  // The gateway places the Anthropic cache breakpoints itself when asked.
  promptCaching: { style: "gateway-auto", defaultModel: /^anthropic\//i },
};
