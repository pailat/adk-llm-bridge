/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { CodexCliDriver } from "./driver/codex-cli";
import { ExternalAgent, type ExternalAgentConfig } from "./external-agent";
import { CODEX_PROVIDER } from "./provider/codex";

type CodexAgentConfig = Omit<ExternalAgentConfig, "provider">;

export class CodexAgent extends ExternalAgent {
  constructor(config: CodexAgentConfig) {
    super({
      ...config,
      provider: CODEX_PROVIDER,
      driver: config.driver ?? new CodexCliDriver(),
    });
  }
}
