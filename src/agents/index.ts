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
export type {
  CodexCliDriverConfig,
  CodexCliSpawn,
  CodexCliSpawnOptions,
  CodexCliSubprocess,
} from "./driver/codex-cli";
export { CodexCliDriver, mapPolicyToCodexArgs } from "./driver/codex-cli";
export type { SubprocessJsonlDriverConfig } from "./driver/subprocess-jsonl";
export { SubprocessJsonlDriver } from "./driver/subprocess-jsonl";
export type { ExternalAgentEvent } from "./events";
export { isExternalAgentEvent } from "./events";
export type { ExternalAgentConfig } from "./external-agent";
export { ExternalAgent } from "./external-agent";
export type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "./external-agent-driver";
export { PlaceholderExternalAgentDriver } from "./external-agent-driver";
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
export type {
  ExternalAgentProviderDefinition,
  ExternalAgentProviderId,
} from "./provider/schema";
export {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  GEMINI_CLI_PROVIDER,
} from "./provider/schema";

import { ExternalAgent, type ExternalAgentConfig } from "./external-agent";
import { CLAUDE_PROVIDER, GEMINI_CLI_PROVIDER } from "./provider/schema";

type ProviderBackedAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class ClaudeAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: CLAUDE_PROVIDER });
  }
}

export class GeminiCliAgent extends ExternalAgent {
  constructor(config: ProviderBackedAgentConfig) {
    super({ ...config, provider: GEMINI_CLI_PROVIDER });
  }
}
