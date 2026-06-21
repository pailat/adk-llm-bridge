/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import type { ProviderDefinition } from "../../core/provider-definition.js";

export const OPENAI_DEFINITION: ProviderDefinition = {
  id: "openai",
  errorPrefix: "OPENAI",
  defaultBaseURL: "https://api.openai.com/v1",
  envKeys: { apiKey: ["OPENAI_API_KEY"] },
  modelPatterns: [/gpt-.+/, /o\d+.*/, /chatgpt-.+/],
  requireApiKey: true,
  // Direct OpenAI 400s if reasoning_effort is sent to a non-reasoning model,
  // so keep the strict, model-name-gated effort path.
  reasoning: { style: "openai-effort" },
  buildHeaders: (config) => {
    const headers: Record<string, string> = {};
    const org =
      (config as Record<string, unknown>).organization as string | undefined ??
      process.env.OPENAI_ORGANIZATION;
    const proj =
      (config as Record<string, unknown>).project as string | undefined ??
      process.env.OPENAI_PROJECT;
    if (org) headers["OpenAI-Organization"] = org;
    if (proj) headers["OpenAI-Project"] = proj;
    return headers;
  },
};
