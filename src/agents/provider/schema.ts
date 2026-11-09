/** Stable id of an external runtime provider. Known ids autocomplete; any other string is accepted. */
export type ExternalAgentProviderId =
  | "codex"
  | "claude"
  | "gemini-cli"
  | (string & {});

/** Static description of an external runtime provider. */
export interface ExternalAgentProviderDefinition {
  /** Stable provider id used in events, registries, and configuration. */
  id: ExternalAgentProviderId;
  /** Human-readable provider name. */
  name: string;
  /** Optional executable name. The foundation does not execute it at import time. */
  command?: string;
  /** Environment variables this provider is allowed to read for auth/config. */
  envAllowlist?: readonly string[];
}

// The built-in definitions live in their own modules; re-exported here so
// existing imports of this module keep working.
export { CLAUDE_PROVIDER } from "./claude.js";
export { CODEX_PROVIDER } from "./codex.js";
