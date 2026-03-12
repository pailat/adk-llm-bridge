/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */
import type { ProviderDefinition } from "../../core/provider-definition";

export const OPENROUTER_DEFINITION: ProviderDefinition = {
  id: "openrouter",
  errorPrefix: "OPENROUTER",
  defaultBaseURL: "https://openrouter.ai/api/v1",
  envKeys: { apiKey: ["OPENROUTER_API_KEY"] },
  modelPatterns: [/.+\/.+/],
  requireApiKey: true,
  buildHeaders: (config) => {
    const headers: Record<string, string> = {};
    const siteUrl =
      (config as Record<string, unknown>).siteUrl as string | undefined ??
      process.env.OPENROUTER_SITE_URL;
    const appName =
      (config as Record<string, unknown>).appName as string | undefined ??
      process.env.OPENROUTER_APP_NAME;
    if (siteUrl) headers["HTTP-Referer"] = siteUrl;
    if (appName) headers["X-Title"] = appName;
    return headers;
  },
  buildRequestOptions: (config) => {
    const provider = (config as Record<string, unknown>).provider;
    return provider ? { provider } : {};
  },
};
