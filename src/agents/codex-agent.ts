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
import { CodexSdkDriver } from "./driver/codex-sdk.js";
import { ExternalAgent } from "./external-agent.js";
import { CODEX_PROVIDER } from "./provider/codex.js";

export const CODEX_AGENT_DEFINITION: ExternalAgentDefinition = {
  provider: CODEX_PROVIDER,
  runtime: "sdk",
  capabilities: {
    streaming: true,
    sessions: true,
    permissions: true,
    tools: true,
    mcpServers: true,
  },
  createDriver: () => new CodexSdkDriver(),
};

export type CodexAgentConfig = ExternalAgentDefinitionConfig;

export class CodexAgent extends ExternalAgent {
  static readonly definition = CODEX_AGENT_DEFINITION;

  constructor(config: CodexAgentConfig) {
    super(createExternalAgentConfig(CODEX_AGENT_DEFINITION, config));
  }
}
