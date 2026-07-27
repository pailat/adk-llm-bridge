/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { WorkflowError } from "./contracts.js";
import type { WorkflowDefinition } from "./definition.js";
import { isWorkflowDefinition } from "./definition.js";

/** Explicit, injectable workflow registry. No process-global registry is created. */
export class WorkflowDefinitionRegistry {
  readonly #definitions = new Map<string, WorkflowDefinition>();

  constructor(definitions: readonly WorkflowDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: WorkflowDefinition): this {
    if (!isWorkflowDefinition(definition)) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        "Invalid workflow definition",
      );
    }
    if (this.#definitions.has(definition.id)) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Workflow is already registered: ${definition.id}`,
        { workflowId: definition.id },
      );
    }
    this.#definitions.set(definition.id, definition);
    return this;
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.#definitions.get(id);
  }

  require(id: string): WorkflowDefinition {
    const definition = this.get(id);
    if (!definition) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Unknown workflow: ${id}`,
        { workflowId: id },
      );
    }
    return definition;
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  list(): WorkflowDefinition[] {
    return [...this.#definitions.values()];
  }

  delete(id: string): boolean {
    return this.#definitions.delete(id);
  }
}
