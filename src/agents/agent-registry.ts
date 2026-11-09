import { InputValidationError } from "@google/adk";
import {
  createExternalAgent,
  type createExternalAgentConfig,
  type ExternalAgentDefinition,
  type ExternalAgentDefinitionConfig,
} from "./agent-schema.js";
import { CLAUDE_AGENT_DEFINITION } from "./claude-agent.js";
import { CODEX_AGENT_DEFINITION } from "./codex-agent.js";
import type { ExternalAgent } from "./external-agent.js";
import { GEMINI_CLI_AGENT_DEFINITION } from "./gemini-cli-agent.js";

/** A lookup table of agent definitions keyed by provider id, able to create agents from them. */
export class ExternalAgentDefinitionRegistry {
  readonly #definitions = new Map<string, ExternalAgentDefinition>();

  /** @param definitions - Definitions to register up front. */
  constructor(definitions: readonly ExternalAgentDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Adds a definition, replacing any definition with the same provider id.
   *
   * @param definition - The agent definition.
   * @throws InputValidationError (from `@google/adk`) when
   * `definition.provider.id` is empty.
   */
  register(definition: ExternalAgentDefinition): void {
    const providerId = definition.provider.id;
    if (!providerId) {
      throw new InputValidationError("External agent provider id is required");
    }
    this.#definitions.set(providerId, definition);
  }

  /** @returns The definition registered for provider `id`, or `undefined`. */
  get(id: string): ExternalAgentDefinition | undefined {
    return this.#definitions.get(id);
  }

  /** @returns Whether a definition is registered for provider `id`. */
  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  /** @returns A copy of the registered definitions, in registration order. */
  list(): ExternalAgentDefinition[] {
    return [...this.#definitions.values()];
  }

  /**
   * Creates an agent from the definition registered for a provider.
   *
   * @param id - Provider id, for example `"codex"`.
   * @param config - Agent options. `driverOptions` configure the
   * definition's default driver.
   * @returns The new agent.
   * @throws InputValidationError (from `@google/adk`) when no definition is
   * registered for `id`, or when the `driverOptions` cannot be applied (see
   * {@link createExternalAgentConfig}).
   */
  create(id: string, config: ExternalAgentDefinitionConfig): ExternalAgent {
    const definition = this.get(id);
    if (!definition) {
      throw new InputValidationError(`Unknown external agent provider: ${id}`);
    }
    return createExternalAgent(definition, config);
  }
}

/**
 * Creates a registry of the built-in agent definitions.
 *
 * @returns A new registry holding the built-in Codex, Claude and Gemini CLI
 *   definitions.
 */
export function createDefaultExternalAgentDefinitionRegistry(): ExternalAgentDefinitionRegistry {
  return new ExternalAgentDefinitionRegistry([
    CODEX_AGENT_DEFINITION,
    CLAUDE_AGENT_DEFINITION,
    GEMINI_CLI_AGENT_DEFINITION,
  ]);
}
