/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { GEMINI_CLI_PROVIDER } from "./gemini-cli";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  type ExternalAgentProviderDefinition,
} from "./schema";

export class ExternalAgentProviderRegistry {
  readonly #providers = new Map<string, ExternalAgentProviderDefinition>();

  constructor(providers: readonly ExternalAgentProviderDefinition[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: ExternalAgentProviderDefinition): void {
    if (!provider.id) {
      throw new Error("External agent provider id is required");
    }
    this.#providers.set(provider.id, provider);
  }

  get(id: string): ExternalAgentProviderDefinition | undefined {
    return this.#providers.get(id);
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): ExternalAgentProviderDefinition[] {
    return [...this.#providers.values()];
  }
}

export function createDefaultExternalAgentProviderRegistry(): ExternalAgentProviderRegistry {
  return new ExternalAgentProviderRegistry([
    CODEX_PROVIDER,
    CLAUDE_PROVIDER,
    GEMINI_CLI_PROVIDER,
  ]);
}

export const externalAgentProviderRegistry =
  createDefaultExternalAgentProviderRegistry();
