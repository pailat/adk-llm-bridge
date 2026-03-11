/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import type { ProviderDefinition } from "../../core/provider-definition";

export const AI_GATEWAY_DEFINITION: ProviderDefinition = {
  id: "ai-gateway",
  errorPrefix: "AI_GATEWAY",
  defaultBaseURL: "https://ai-gateway.vercel.sh/v1",
  envKeys: {
    apiKey: ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"],
    baseURL: ["AI_GATEWAY_URL", "OPENAI_BASE_URL"],
  },
  modelPatterns: [/.+\/.+/],
};
