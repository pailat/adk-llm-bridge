import type { ExternalAgentProviderDefinition } from "./schema.js";

/**
 * Environment variables the Gemini CLI may read for auth and config.
 *
 * @remarks
 * Only these variables are forwarded from the host environment, so unrelated
 * secrets never reach the Gemini CLI process.
 */
export const GEMINI_CLI_ENV_ALLOWLIST = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT_ID",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
] as const;

/** Provider definition for the Gemini CLI. */
export const GEMINI_CLI_PROVIDER: ExternalAgentProviderDefinition = {
  id: "gemini-cli",
  name: "Gemini CLI",
  command: "gemini",
  envAllowlist: GEMINI_CLI_ENV_ALLOWLIST,
};
