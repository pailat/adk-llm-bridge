/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export { BaseAgent } from "@google/adk";

export { EnvCredentialProvider, readAllowedEnv } from "./auth/env";
export { NoopCredentialProvider } from "./auth/credential-provider";
export type { ExternalAgentCredentialProvider } from "./auth/credential-provider";
export type {
  CredentialRequest,
  ExternalAgentAuthKind,
  ExternalAgentCredential,
} from "./auth/schema";
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
export { ExternalAgent } from "./external-agent";
export type { ExternalAgentConfig } from "./external-agent";
export { GeminiCliAgent } from "./gemini-cli-agent";
export { PlaceholderExternalAgentDriver } from "./external-agent-driver";
export type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "./external-agent-driver";
export { isExternalAgentEvent } from "./events";
export type { ExternalAgentEvent } from "./events";
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
  externalAgentProviderRegistry,
  ExternalAgentProviderRegistry,
} from "./provider/registry";
export {
  GEMINI_CLI_ENV_ALLOWLIST,
  GEMINI_CLI_PROVIDER,
} from "./provider/gemini-cli";
export { CLAUDE_PROVIDER, CODEX_PROVIDER } from "./provider/schema";
export type {
  ExternalAgentProviderDefinition,
  ExternalAgentProviderId,
} from "./provider/schema";

import { ExternalAgent, type ExternalAgentConfig } from "./external-agent";
import { CLAUDE_PROVIDER, CODEX_PROVIDER } from "./provider/schema";

type ProviderBackedAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class CodexAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: CODEX_PROVIDER });
  }
}

export class ClaudeAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: CLAUDE_PROVIDER });
  }
}
