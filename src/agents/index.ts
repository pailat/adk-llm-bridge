/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export { BaseAgent } from "@google/adk";

export {
  createExternalAgent,
  createExternalAgentConfig,
} from "./agent-schema.js";
export type {
  ExternalAgentDefinition,
  ExternalAgentDefinitionConfig,
  ExternalAgentRuntimeKind,
} from "./agent-schema.js";
export {
  createDefaultExternalAgentDefinitionRegistry,
  ExternalAgentDefinitionRegistry,
  externalAgentDefinitionRegistry,
} from "./agent-registry.js";
export type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
export { NoopCredentialProvider } from "./auth/credential-provider.js";
export { EnvCredentialProvider, readAllowedEnv } from "./auth/env.js";
export type {
  CredentialRequest,
  ExternalAgentAuthKind,
  ExternalAgentCredential,
} from "./auth/schema.js";

export { CLAUDE_AGENT_DEFINITION, ClaudeAgent } from "./claude-agent.js";
export type { ClaudeAgentConfig } from "./claude-agent.js";
export { CODEX_AGENT_DEFINITION, CodexAgent } from "./codex-agent.js";
export type { CodexAgentConfig } from "./codex-agent.js";
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
  CodexSdkDriver,
  mapPolicyToCodexSdkThreadOptions,
} from "./driver/codex-sdk.js";
export type { CodexSdkDriverConfig } from "./driver/codex-sdk.js";
export {
  summarizeHistoryForColdStart,
  userContentToCodexInput,
} from "./driver/codex-input-mapper.js";
export type {
  CodexInputMapperOptions,
  CodexInputMapping,
  CodexInputPart,
} from "./driver/codex-input-mapper.js";
export {
  ClaudeAgentSdkDriver,
  mapPolicyToClaudeSdkPermission,
} from "./driver/claude-agent-sdk.js";
export type { ClaudeAgentSdkDriverConfig } from "./driver/claude-agent-sdk.js";
export { contentsToSdkMessages } from "./driver/claude-message-mapper.js";
export type {
  ClaudeContentBlockParam,
  ClaudeMessageParam,
  SDKUserMessage,
} from "./driver/claude-message-mapper.js";
export { ClaudeCliDriver, mapClaudePermissionArgs } from "./driver/claude-cli.js";
export type {
  ClaudeCliDriverConfig,
  ClaudeCliSpawn,
  ClaudeCliSpawnOptions,
  ClaudeCliSubprocess,
} from "./driver/claude-cli.js";
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

export type {
  ExternalAgentCompletedEvent,
  ExternalAgentErrorEvent,
  ExternalAgentEvent,
  ExternalAgentOutputEvent,
  ExternalAgentStartedEvent,
  ExternalAgentStateDeltaEvent,
  ExternalAgentToolCallEvent,
  ExternalAgentToolResultEvent,
} from "./events.js";
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
export { GEMINI_CLI_AGENT_DEFINITION, GeminiCliAgent } from "./gemini-cli-agent.js";
export type { GeminiCliAgentConfig } from "./gemini-cli-agent.js";

export {
  mapPermissionModeToPolicy,
  mapPermissionPolicyToFlags,
} from "./permissions/mapper.js";
export { deriveSubAgentPermissionPolicy } from "./permissions/inheritance.js";
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
export type { AgentRuntimeCapabilities } from "./runtime/capabilities.js";
export {
  collectContents,
  flattenContentsToPrompt,
} from "./runtime/content-collector.js";
export type { AgentRuntimeRequestMetadata } from "./runtime/runtime-request.js";
export type { AgentRuntimeSession } from "./runtime/runtime-session.js";
export { ToolGateway } from "./tools/tool-gateway.js";
export type {
  RunSubAgentInput,
  RunSubAgentResult,
  ToolGatewayConfig,
} from "./tools/tool-gateway.js";
