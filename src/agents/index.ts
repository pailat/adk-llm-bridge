/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export { BaseAgent } from "@google/adk";

export type { ExternalAgentCredentialProvider } from "./auth/credential-provider";
export { NoopCredentialProvider } from "./auth/credential-provider";
export { EnvCredentialProvider, readAllowedEnv } from "./auth/env";
export type {
  CredentialRequest,
  ExternalAgentAuthKind,
  ExternalAgentCredential,
} from "./auth/schema";

export { CodexAgent } from "./codex-agent";
export {
  CodexCliDriver,
  mapPolicyToCodexArgs,
} from "./driver/codex-cli";
export type {
  CodexCliDriverConfig,
  CodexCliSpawn,
  CodexCliSpawnOptions,
  CodexCliSubprocess,
} from "./driver/codex-cli";
export {
  GeminiCliDriver,
  buildGeminiArgs,
  mapGeminiPermissionArgs,
} from "./driver/gemini-cli";
export type {
  GeminiCliDriverConfig,
  GeminiCliSpawn,
  GeminiCliSpawnOptions,
  GeminiCliSubprocess,
} from "./driver/gemini-cli";
export { SubprocessJsonlDriver } from "./driver/subprocess-jsonl";
export type { SubprocessJsonlDriverConfig } from "./driver/subprocess-jsonl";

export type { ExternalAgentEvent } from "./events";
export { isExternalAgentEvent } from "./events";
export type { ExternalAgentConfig } from "./external-agent";
export { ExternalAgent } from "./external-agent";
export {
  PlaceholderExternalAgentDriver,
} from "./external-agent-driver";
export type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "./external-agent-driver";
export { GeminiCliAgent } from "./gemini-cli-agent";

export {
  mapPermissionModeToPolicy,
  mapPermissionPolicyToFlags,
} from "./permissions/mapper";
export type {
  ExternalAgentPermissionMode,
  ExternalAgentPermissionPolicy,
  ProviderPermissionFlags,
} from "./permissions/schema";
export {
  createDefaultExternalAgentProviderRegistry,
  ExternalAgentProviderRegistry,
  externalAgentProviderRegistry,
} from "./provider/registry";
export { CODEX_ENV_ALLOWLIST, CODEX_PROVIDER } from "./provider/codex";
export {
  GEMINI_CLI_ENV_ALLOWLIST,
  GEMINI_CLI_PROVIDER,
} from "./provider/gemini-cli";
export { CLAUDE_PROVIDER } from "./provider/schema";
export type {
  ExternalAgentProviderDefinition,
  ExternalAgentProviderId,
} from "./provider/schema";

import { ExternalAgent, type ExternalAgentConfig } from "./external-agent";
import { CLAUDE_PROVIDER } from "./provider/schema";

type ProviderBackedAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class ClaudeAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: CLAUDE_PROVIDER });
  }
}
