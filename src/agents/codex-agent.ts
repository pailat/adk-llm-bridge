/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { CodexSdkDriver } from "./driver/codex-sdk.js";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent.js";
import { CODEX_PROVIDER } from "./provider/codex.js";

type CodexAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class CodexAgent extends ExternalAgent {
  constructor(config: CodexAgentConfig) {
    super({
      ...config,
      provider: CODEX_PROVIDER,
      driver: config.driver ?? new CodexSdkDriver(),
    });
  }
}
