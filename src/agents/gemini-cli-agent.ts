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
import { GeminiCliDriver } from "./driver/gemini-cli.js";
import { ExternalAgent } from "./external-agent.js";
import { GEMINI_CLI_PROVIDER } from "./provider/gemini-cli.js";

export const GEMINI_CLI_AGENT_DEFINITION: ExternalAgentDefinition = {
  provider: GEMINI_CLI_PROVIDER,
  runtime: "cli",
  capabilities: {
    streaming: true,
    permissions: true,
    tools: true,
  },
  createCredentialProvider: () => new EnvCredentialProvider(),
  createDriver: () => new GeminiCliDriver(),
};

export type GeminiCliAgentConfig = ExternalAgentDefinitionConfig;

export class GeminiCliAgent extends ExternalAgent {
  static readonly definition = GEMINI_CLI_AGENT_DEFINITION;

  constructor(config: GeminiCliAgentConfig) {
    super(createExternalAgentConfig(GEMINI_CLI_AGENT_DEFINITION, config));
  }
}
