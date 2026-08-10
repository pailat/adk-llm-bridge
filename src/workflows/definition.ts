/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { WorkflowExecutionLimits, WorkflowHandler } from "./contracts.js";
import { WorkflowError } from "./contracts.js";

export interface WorkflowDefinitionBase {
  /** Stable workflow identity. Changing behavior requires changing version. */
  id: string;
  version: string;
  description?: string;
  limits?: WorkflowExecutionLimits;
}

export interface TrustedWorkflowDefinition extends WorkflowDefinitionBase {
  kind: "trusted";
  handler: WorkflowHandler;
}

export interface ScriptWorkflowDefinition extends WorkflowDefinitionBase {
  kind: "script";
  /**
   * Synchronous generator-function body evaluated by the script runtime.
   * Host operations are yielded as JSON descriptors; the runtime resumes the
   * generator with each result. Async functions and imports are not supported.
   */
  source: string;
}

export type WorkflowDefinition =
  | TrustedWorkflowDefinition
  | ScriptWorkflowDefinition;

export type TrustedWorkflowDefinitionInput = Omit<
  TrustedWorkflowDefinition,
  "kind"
>;

export type ScriptWorkflowDefinitionInput = Omit<
  ScriptWorkflowDefinition,
  "kind"
>;

export function defineWorkflow(
  definition: TrustedWorkflowDefinitionInput,
): TrustedWorkflowDefinition {
  validateWorkflowIdentity(definition);
  if (typeof definition.handler !== "function") {
    throw invalidDefinition("Trusted workflow handler must be a function");
  }
  return Object.freeze({ ...definition, kind: "trusted" });
}

export function defineScriptWorkflow(
  definition: ScriptWorkflowDefinitionInput,
): ScriptWorkflowDefinition {
  validateWorkflowIdentity(definition);
  if (!definition.source.trim()) {
    throw invalidDefinition("Script workflow source is required");
  }
  return Object.freeze({ ...definition, kind: "script" });
}

export function isWorkflowDefinition(
  value: unknown,
): value is WorkflowDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkflowDefinition>;
  if (!candidate.id?.trim() || !candidate.version?.trim()) {
    return false;
  }
  return (
    (candidate.kind === "trusted" && typeof candidate.handler === "function") ||
    (candidate.kind === "script" &&
      typeof candidate.source === "string" &&
      candidate.source.trim().length > 0)
  );
}

function validateWorkflowIdentity(definition: WorkflowDefinitionBase): void {
  if (!definition.id?.trim()) {
    throw invalidDefinition("Workflow id is required");
  }
  if (!definition.version?.trim()) {
    throw invalidDefinition("Workflow version is required");
  }
}

function invalidDefinition(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message);
}
