/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type ExternalAgentProviderId =
  | "codex"
  | "claude"
  | "gemini-cli"
  | (string & {});

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

export const CODEX_PROVIDER: ExternalAgentProviderDefinition = {
  id: "codex",
  name: "Codex",
  command: "codex",
  envAllowlist: ["OPENAI_API_KEY", "CODEX_API_KEY"],
};

export const CLAUDE_PROVIDER: ExternalAgentProviderDefinition = {
  id: "claude",
  name: "Claude Code",
  command: "claude",
  envAllowlist: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"],
};
