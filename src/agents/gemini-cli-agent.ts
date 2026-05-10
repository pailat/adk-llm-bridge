/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { EnvCredentialProvider } from "./auth/env";
import { GeminiCliDriver } from "./driver/gemini-cli";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent";
import { GEMINI_CLI_PROVIDER } from "./provider/gemini-cli";

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
