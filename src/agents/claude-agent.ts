/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { EnvCredentialProvider } from "./auth/env.js";
import { ClaudeAgentSdkDriver } from "./driver/claude-agent-sdk.js";
import { ExternalAgent } from "./external-agent.js";
import { CLAUDE_PROVIDER } from "./provider/schema.js";

export const CLAUDE_AGENT_DEFINITION: ExternalAgentDefinition = {
  provider: CLAUDE_PROVIDER,
  runtime: "sdk",
  capabilities: {
    streaming: true,
    permissions: true,
    tools: true,
    subagents: true,
    mcpServers: true,
  },
  createCredentialProvider: () => new EnvCredentialProvider(),
  createDriver: () => new ClaudeAgentSdkDriver(),
};

export type ClaudeAgentConfig = ExternalAgentDefinitionConfig;

export class ClaudeAgent extends ExternalAgent {
  static readonly definition = CLAUDE_AGENT_DEFINITION;

  constructor(config: ClaudeAgentConfig) {
    super(createExternalAgentConfig(CLAUDE_AGENT_DEFINITION, config));
  }
}
