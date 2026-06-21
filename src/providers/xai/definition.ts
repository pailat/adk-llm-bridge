/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import type { ProviderDefinition } from "../../core/provider-definition.js";

export const XAI_DEFINITION: ProviderDefinition = {
  id: "xai",
  errorPrefix: "XAI",
  defaultBaseURL: "https://api.x.ai/v1",
  envKeys: { apiKey: ["XAI_API_KEY"] },
  modelPatterns: [/grok-.+/],
  requireApiKey: true,
  // Direct xAI 400s if reasoning_effort is sent to a non-reasoning Grok model,
  // so keep the strict, model-name-gated effort path.
  reasoning: { style: "openai-effort" },
};
