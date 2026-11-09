import { WorkflowError } from "./contracts.js";
import type { WorkflowDefinition } from "./definition.js";
import { isWorkflowDefinition } from "./definition.js";

/**
 * Explicit, injectable registry of workflow definitions keyed by id and
 * version.
 *
 * @remarks
 * No process-global registry is created. Several versions of one workflow id
 * can be registered side by side, because a checkpoint written by one version
 * is replayed only by that version; every lookup therefore names the version.
 */
export class WorkflowDefinitionRegistry {
  // Keyed by id, then version; both maps keep registration order.
  readonly #definitions = new Map<string, Map<string, WorkflowDefinition>>();

  /**
   * @param definitions - Definitions to register up front.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when
   * a definition is invalid or its id and version are duplicated.
   */
  constructor(definitions: readonly WorkflowDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  /**
   * Registers a definition.
   *
   * @param definition - Definition to add.
   * @returns This registry, for chaining.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when
   * the definition is invalid or the same id and version are already
   * registered.
   */
  register(definition: WorkflowDefinition): this {
    if (!isWorkflowDefinition(definition)) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        "Invalid workflow definition",
      );
    }
    const { id, version } = definition;
    let versions = this.#definitions.get(id);
    if (versions?.has(version)) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Workflow is already registered: ${id}@${version}`,
        { workflowId: id, workflowVersion: version },
      );
    }
    if (!versions) {
      versions = new Map();
      this.#definitions.set(id, versions);
    }
    versions.set(version, definition);
    return this;
  }

  /**
   * Looks up a definition.
   *
   * @param id - Workflow id.
   * @param version - Workflow version.
   * @returns The definition, or `undefined` when none is registered.
   */
  get(id: string, version: string): WorkflowDefinition | undefined {
    return this.#definitions.get(id)?.get(version);
  }

  /**
   * Looks up a definition that must exist.
   *
   * @param id - Workflow id.
   * @param version - Workflow version.
   * @returns The registered definition.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_NOT_FOUND`
   * when no definition has this id and version.
   */
  require(id: string, version: string): WorkflowDefinition {
    const definition = this.get(id, version);
    if (!definition) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_NOT_FOUND",
        `Unknown workflow: ${id}@${version}`,
        { workflowId: id, workflowVersion: version },
      );
    }
    return definition;
  }

  /**
   * Whether a definition with this id and version is registered.
   *
   * @param id - Workflow id.
   * @param version - Workflow version.
   * @returns True when the pair is registered.
   */
  has(id: string, version: string): boolean {
    return this.#definitions.get(id)?.has(version) ?? false;
  }

  /**
   * Lists the registered versions of one workflow id.
   *
   * @param id - Workflow id.
   * @returns The versions in registration order; empty when the id is unknown.
   */
  versions(id: string): string[] {
    return [...(this.#definitions.get(id)?.keys() ?? [])];
  }

  /**
   * Lists every registered definition.
   *
   * @returns The definitions grouped by id, in registration order.
   */
  list(): WorkflowDefinition[] {
    return [...this.#definitions.values()].flatMap((versions) => [
      ...versions.values(),
    ]);
  }

  /**
   * Removes one version of a definition.
   *
   * @param id - Workflow id.
   * @param version - Workflow version.
   * @returns True when a definition was removed.
   */
  delete(id: string, version: string): boolean {
    const versions = this.#definitions.get(id);
    if (!versions?.delete(version)) {
      return false;
    }
    if (versions.size === 0) {
      this.#definitions.delete(id);
    }
    return true;
  }
}
