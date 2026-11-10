import { InputValidationError } from "@google/adk";
import { CODEX_PROVIDER } from "./codex.js";
import { GEMINI_CLI_PROVIDER } from "./gemini-cli.js";
import {
  CLAUDE_PROVIDER,
  type ExternalAgentProviderDefinition,
} from "./schema.js";

/** A lookup table of provider definitions keyed by provider id. */
export class ExternalAgentProviderRegistry {
  readonly #providers = new Map<string, ExternalAgentProviderDefinition>();

  /** @param providers - Providers to register up front. */
  constructor(providers: readonly ExternalAgentProviderDefinition[] = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  /**
   * Adds a provider, replacing any provider with the same id.
   *
   * @param provider - The provider definition.
   * @throws InputValidationError (from `@google/adk`) when `provider.id` is
   * empty.
   */
  register(provider: ExternalAgentProviderDefinition): void {
    if (!provider.id) {
      throw new InputValidationError("External agent provider id is required");
    }
    this.#providers.set(provider.id, provider);
  }

  /** @returns The provider registered under `id`, or `undefined`. */
  get(id: string): ExternalAgentProviderDefinition | undefined {
    return this.#providers.get(id);
  }

  /** @returns Whether a provider is registered under `id`. */
  has(id: string): boolean {
    return this.#providers.has(id);
  }

  /** @returns A copy of the registered providers, in registration order. */
  list(): ExternalAgentProviderDefinition[] {
    return [...this.#providers.values()];
  }
}

/**
 * Creates a registry of the built-in providers.
 *
 * @returns A new registry holding the built-in Codex, Claude and Gemini CLI
 *   providers.
 */
export function createDefaultExternalAgentProviderRegistry(): ExternalAgentProviderRegistry {
  return new ExternalAgentProviderRegistry([
    CODEX_PROVIDER,
    CLAUDE_PROVIDER,
    GEMINI_CLI_PROVIDER,
  ]);
}
