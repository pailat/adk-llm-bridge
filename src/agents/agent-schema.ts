/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { ExternalAgentCredentialProvider } from "./auth/credential-provider.js";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import type { ExternalAgentDriver } from "./external-agent-driver.js";
import type { ExternalAgentProviderDefinition } from "./provider/schema.js";
import type { AgentRuntimeCapabilities } from "./runtime/capabilities.js";

export type ExternalAgentRuntimeKind = "sdk" | "cli" | "jsonl" | (string & {});

export interface ExternalAgentDefinition {
  /** Provider metadata used in events, auth, and registry lookups. */
  provider: ExternalAgentProviderDefinition;
  /** Runtime integration style. Useful for docs, diagnostics, and future factories. */
  runtime?: ExternalAgentRuntimeKind;
  /** Capabilities exposed by the default runtime driver. */
  capabilities?: AgentRuntimeCapabilities;
  /** Creates the default driver for this runtime. */
  createDriver?: () => ExternalAgentDriver;
  /** Creates the default credential provider for this runtime. */
  createCredentialProvider?: () => ExternalAgentCredentialProvider;
}

export type ExternalAgentDefinitionConfig = Omit<ExternalAgentConfig, "provider">;

export function createExternalAgentConfig(
  definition: ExternalAgentDefinition,
  config: ExternalAgentDefinitionConfig,
): ExternalAgentConfig {
  const driver = config.driver ?? definition.createDriver?.();
  const credentialProvider =
    config.credentialProvider ?? definition.createCredentialProvider?.();

  return {
    ...config,
    provider: definition.provider,
    ...(driver ? { driver } : {}),
    ...(credentialProvider ? { credentialProvider } : {}),
  };
}

export function createExternalAgent(
  definition: ExternalAgentDefinition,
  config: ExternalAgentDefinitionConfig,
): ExternalAgent {
  return new ExternalAgent(createExternalAgentConfig(definition, config));
}
