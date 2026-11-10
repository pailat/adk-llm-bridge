import type { WorkflowExecutionLimits, WorkflowHandler } from "./contracts.js";
import { WorkflowError } from "./contracts.js";
import { isWorkflowIdentifier } from "./internal/identifiers.js";

/** Fields shared by every workflow definition. */
export interface WorkflowDefinitionBase {
  /** Stable workflow identity. Changing behavior requires changing version. */
  id: string;
  /** Workflow version; checkpoints from another version are not replayed. */
  version: string;
  /** Human-readable description. */
  description?: string;
  /** Overrides for the default execution limits. */
  limits?: WorkflowExecutionLimits;
}

/** Workflow whose handler is host JavaScript running in-process. */
export interface TrustedWorkflowDefinition extends WorkflowDefinitionBase {
  /** Discriminator. */
  kind: "trusted";
  /** Handler that drives the steps. */
  handler: WorkflowHandler;
}

/** Workflow whose source runs inside the sandboxed script runtime. */
export interface ScriptWorkflowDefinition extends WorkflowDefinitionBase {
  /** Discriminator. */
  kind: "script";
  /**
   * Synchronous generator-function body evaluated by the script runtime.
   * Host operations are yielded as JSON descriptors; the runtime resumes the
   * generator with each result. Async functions and imports are not supported.
   */
  source: string;
}

/** Any workflow definition: trusted or script. */
export type WorkflowDefinition =
  | TrustedWorkflowDefinition
  | ScriptWorkflowDefinition;

/** Input of {@link defineWorkflow}. */
export type TrustedWorkflowDefinitionInput = Omit<
  TrustedWorkflowDefinition,
  "kind"
>;

/** Input of {@link defineScriptWorkflow}. */
export type ScriptWorkflowDefinitionInput = Omit<
  ScriptWorkflowDefinition,
  "kind"
>;

/**
 * Creates a frozen trusted workflow definition.
 *
 * @param definition - Identity, optional limits and the handler.
 * @returns The frozen definition with `kind: "trusted"`.
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when
 * the definition is not an object, the id or version is not an opaque id
 * (1-256 characters of `A-Z a-z 0-9 . _ : + / -`, starting with a letter or
 * digit), or the handler is not a function.
 */
export function defineWorkflow(
  definition: TrustedWorkflowDefinitionInput,
): TrustedWorkflowDefinition {
  validateWorkflowIdentity(definition);
  if (typeof definition.handler !== "function") {
    throw invalidDefinition("Trusted workflow handler must be a function");
  }
  return Object.freeze({ ...definition, kind: "trusted" });
}

/**
 * Creates a frozen script workflow definition.
 *
 * @param definition - Identity, optional limits and the script source.
 * @returns The frozen definition with `kind: "script"`.
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when
 * the definition is not an object, the id or version is not an opaque id
 * (1-256 characters of `A-Z a-z 0-9 . _ : + / -`, starting with a letter or
 * digit), or the source is not a non-blank string.
 */
export function defineScriptWorkflow(
  definition: ScriptWorkflowDefinitionInput,
): ScriptWorkflowDefinition {
  validateWorkflowIdentity(definition);
  if (!isNonBlankString(definition.source)) {
    throw invalidDefinition("Script workflow source is required");
  }
  return Object.freeze({ ...definition, kind: "script" });
}

/**
 * Type guard for {@link WorkflowDefinition}.
 *
 * @param value - Value to test.
 * @returns True when `value` has an opaque id and version and a handler or
 * source matching its `kind`; false otherwise, including when a field cannot
 * be read (a throwing getter or Proxy trap).
 */
export function isWorkflowDefinition(
  value: unknown,
): value is WorkflowDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkflowDefinition>;
  try {
    if (
      !isWorkflowIdentifier(candidate.id, "opaque") ||
      !isWorkflowIdentifier(candidate.version, "opaque")
    ) {
      return false;
    }
    return (
      (candidate.kind === "trusted" &&
        typeof candidate.handler === "function") ||
      (candidate.kind === "script" && isNonBlankString(candidate.source))
    );
  } catch {
    // A type guard answers false for a value whose fields cannot be read.
    return false;
  }
}

function validateWorkflowIdentity(definition: WorkflowDefinitionBase): void {
  if (!definition || typeof definition !== "object") {
    throw invalidDefinition("Workflow definition must be an object");
  }
  for (const field of ["id", "version"] as const) {
    const value = definition[field];
    if (!isNonBlankString(value)) {
      throw invalidDefinition(`Workflow ${field} is required`);
    }
    if (!isWorkflowIdentifier(value, "opaque")) {
      throw invalidDefinition(
        `Workflow ${field} is invalid: ${JSON.stringify(value)}`,
      );
    }
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidDefinition(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message);
}
