/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { EnvCredentialProvider } from "./auth/env.js";
import { ClaudeAgentSdkDriver } from "./driver/claude-agent-sdk.js";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import { CLAUDE_PROVIDER } from "./provider/schema.js";

type ClaudeAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class ClaudeAgent extends ExternalAgent {
  constructor(config: ClaudeAgentConfig) {
    super({
      ...config,
      provider: CLAUDE_PROVIDER,
      credentialProvider:
        config.credentialProvider ?? new EnvCredentialProvider(),
      driver: config.driver ?? new ClaudeAgentSdkDriver(),
    });
  }
}
