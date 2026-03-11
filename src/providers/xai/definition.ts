/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import type { ProviderDefinition } from "../../core/provider-definition";

export const XAI_DEFINITION: ProviderDefinition = {
  id: "xai",
  errorPrefix: "XAI",
  defaultBaseURL: "https://api.x.ai/v1",
  envKeys: { apiKey: ["XAI_API_KEY"] },
  modelPatterns: [/grok-.+/],
};
