import { freezeJson } from "../internal/immutable-json.js";
import { WorkflowExecutionControlError } from "./contracts.js";

/**
 * Bounds enforced on JSON values stored in executions.
 *
 * @internal
 */
export interface WorkflowExecutionJsonLimits {
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum number of values, counting containers and leaves. */
  maxNodes: number;
  /** Maximum length of any string value or object key. */
  maxStringLength: number;
}

/**
 * Default {@link WorkflowExecutionJsonLimits}: depth 32, 10,000 nodes, 1 MiB strings.
 *
 * @internal
 */
export const DEFAULT_WORKFLOW_EXECUTION_JSON_LIMITS: Readonly<WorkflowExecutionJsonLimits> =
  Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringLength: 1_048_576,
  });

/**
 * Validates a JSON value and returns a deep-frozen copy.
 *
 * @param value - Value to validate and copy.
 * @param limits - Size bounds to enforce.
 * @returns A deep-frozen copy of `value`.
 * @throws {@link WorkflowExecutionControlError} with code `WORKFLOW_EXECUTION_INVALID_REQUEST`
 * when the value has a cycle, a non-finite number, a non-plain object, a
 * symbol-keyed property, a sparse array, or
 * exceeds `limits`.
 * @internal
 */
export function immutableJson<T>(
  value: T,
  limits: WorkflowExecutionJsonLimits = DEFAULT_WORKFLOW_EXECUTION_JSON_LIMITS,
): T {
  return freezeJson(value, limits, invalid);
}

function invalid(message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_REQUEST",
    message,
  );
}
