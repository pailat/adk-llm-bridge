/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  createExternalAgent,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { CLAUDE_AGENT_DEFINITION } from "./claude-agent.js";
import { CODEX_AGENT_DEFINITION } from "./codex-agent.js";
import type { ExternalAgent } from "./external-agent.js";
import { GEMINI_CLI_AGENT_DEFINITION } from "./gemini-cli-agent.js";

export class ExternalAgentDefinitionRegistry {
  readonly #definitions = new Map<string, ExternalAgentDefinition>();

  constructor(definitions: readonly ExternalAgentDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ExternalAgentDefinition): void {
    const providerId = definition.provider.id;
    if (!providerId) {
      throw new Error("External agent provider id is required");
    }
    this.#definitions.set(providerId, definition);
  }

  get(id: string): ExternalAgentDefinition | undefined {
    return this.#definitions.get(id);
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  list(): ExternalAgentDefinition[] {
    return [...this.#definitions.values()];
  }

  create(id: string, config: ExternalAgentDefinitionConfig): ExternalAgent {
    const definition = this.get(id);
    if (!definition) {
      throw new Error(`Unknown external agent provider: ${id}`);
    }
    return createExternalAgent(definition, config);
  }
}

export function createDefaultExternalAgentDefinitionRegistry(): ExternalAgentDefinitionRegistry {
  return new ExternalAgentDefinitionRegistry([
    CODEX_AGENT_DEFINITION,
    CLAUDE_AGENT_DEFINITION,
    GEMINI_CLI_AGENT_DEFINITION,
  ]);
}

export const externalAgentDefinitionRegistry =
  createDefaultExternalAgentDefinitionRegistry();
