import type { ExternalAgentProviderDefinition } from "./schema.js";

/**
 * Environment variables the Codex runtime may read for auth and config.
 *
 * @remarks
 * Only these variables are forwarded from the host environment, so unrelated
 * secrets never reach the Codex process.
 */
export const CODEX_ENV_ALLOWLIST = [
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_HOME",
  "CODEX_EXECUTABLE",
  "CODEX_CLI_PATH",
  "CODEX_CA_CERTIFICATE",
  "SSL_CERT_FILE",
] as const;

/** Provider definition for OpenAI Codex. */
export const CODEX_PROVIDER: ExternalAgentProviderDefinition = {
  id: "codex",
  name: "Codex",
  command: "codex",
  envAllowlist: CODEX_ENV_ALLOWLIST,
};
