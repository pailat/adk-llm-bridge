/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export { BaseAgent } from "@google/adk";

export type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
export { NoopCredentialProvider } from "./auth/credential-provider.js";
export { EnvCredentialProvider, readAllowedEnv } from "./auth/env.js";
export type {
  CredentialRequest,
  ExternalAgentAuthKind,
  ExternalAgentCredential,
} from "./auth/schema.js";

export { CodexAgent } from "./codex-agent.js";
export {
  CodexCliDriver,
  mapPolicyToCodexArgs,
} from "./driver/codex-cli.js";
export type {
  CodexCliDriverConfig,
  CodexCliSpawn,
  CodexCliSpawnOptions,
  CodexCliSubprocess,
} from "./driver/codex-cli.js";
export {
  GeminiCliDriver,
  buildGeminiArgs,
  mapGeminiPermissionArgs,
} from "./driver/gemini-cli.js";
export type {
  GeminiCliDriverConfig,
  GeminiCliSpawn,
  GeminiCliSpawnOptions,
  GeminiCliSubprocess,
} from "./driver/gemini-cli.js";
export { SubprocessJsonlDriver } from "./driver/subprocess-jsonl.js";
export type { SubprocessJsonlDriverConfig } from "./driver/subprocess-jsonl.js";

export type { ExternalAgentEvent } from "./events.js";
export { isExternalAgentEvent } from "./events.js";
export type { ExternalAgentConfig } from "./external-agent.js";
export { ExternalAgent } from "./external-agent.js";
export {
  PlaceholderExternalAgentDriver,
} from "./external-agent-driver.js";
export type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "./external-agent-driver.js";
export { GeminiCliAgent } from "./gemini-cli-agent.js";

export {
  mapPermissionModeToPolicy,
  mapPermissionPolicyToFlags,
} from "./permissions/mapper.js";
export type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
  ProviderPermissionFlags,
} from "./permissions/schema.js";
export {
  createDefaultExternalAgentProviderRegistry,
  ExternalAgentProviderRegistry,
  externalAgentProviderRegistry,
} from "./provider/registry.js";
export { CODEX_ENV_ALLOWLIST, CODEX_PROVIDER } from "./provider/codex.js";
export {
  GEMINI_CLI_ENV_ALLOWLIST,
  GEMINI_CLI_PROVIDER,
} from "./provider/gemini-cli.js";
export { CLAUDE_PROVIDER } from "./provider/schema.js";
export type {
  ExternalAgentProviderDefinition,
  ExternalAgentProviderId,
} from "./provider/schema.js";

import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import { CLAUDE_PROVIDER } from "./provider/schema.js";

type ProviderBackedAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class ClaudeAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: CLAUDE_PROVIDER });
  }
}
