import type { ExternalAgentProviderDefinition } from "./schema.js";

/**
 * Provider definition for Claude Code.
 *
 * @remarks
 * `envAllowlist` covers the Anthropic API credentials, the Claude Code OAuth
 * token, executable overrides and the config directory, and the Bedrock,
 * Vertex and Foundry switches.
 * Nothing else is forwarded from the host environment.
 */
export const CLAUDE_PROVIDER: ExternalAgentProviderDefinition = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  envAllowlist: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_EXECUTABLE",
    "CLAUDE_CODE_PATH",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
};
