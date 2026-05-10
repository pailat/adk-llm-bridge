/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { ExternalAgentProviderDefinition } from "./schema";

export const GEMINI_CLI_ENV_ALLOWLIST = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

export const GEMINI_CLI_PROVIDER: ExternalAgentProviderDefinition = {
  id: "gemini-cli",
  name: "Gemini CLI",
  command: "gemini",
  envAllowlist: GEMINI_CLI_ENV_ALLOWLIST,
};
