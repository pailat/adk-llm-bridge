/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { EnvCredentialProvider } from "./auth/env.js";
import { GeminiCliDriver } from "./driver/gemini-cli.js";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import { GEMINI_CLI_PROVIDER } from "./provider/gemini-cli.js";

type GeminiCliAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class GeminiCliAgent extends ExternalAgent {
  constructor(config: GeminiCliAgentConfig) {
    super({
      ...config,
      provider: GEMINI_CLI_PROVIDER,
      credentialProvider:
        config.credentialProvider ?? new EnvCredentialProvider(),
      driver: config.driver ?? new GeminiCliDriver(),
    });
  }
}
