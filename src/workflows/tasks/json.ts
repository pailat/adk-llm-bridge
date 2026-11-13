import { freezeJson } from "../internal/immutable-json.js";
import { WorkflowTaskControlError } from "./contracts.js";

/**
 * Bounds enforced on JSON values stored in tasks.
 *
 * @remarks
 * Every field must be a positive safe integer.
 * @internal
 */
export interface WorkflowTaskJsonLimits {
  /** Maximum nesting depth. */
  maxDepth: number;
  /** Maximum number of values, counting containers and leaves. */
  maxNodes: number;
  /** Maximum length of any string value or object key. */
  maxStringLength: number;
}

/**
 * Default {@link WorkflowTaskJsonLimits}: depth 32, 10,000 nodes, 1 MiB strings.
 *
 * @internal
 */
export const DEFAULT_WORKFLOW_TASK_JSON_LIMITS: Readonly<WorkflowTaskJsonLimits> =
  Object.freeze({
    maxDepth: 32,
    maxNodes: 10_000,
    maxStringLength: 1_048_576,
  });

/**
 * Validates a JSON value and returns a deep-frozen copy.
 *
 * @remarks
 * Frozen copies keep stored records from being mutated through shared
 * references. `undefined` object properties are dropped.
 *
 * @param value - Value to validate and copy.
 * @param limits - Size bounds to enforce.
 * @returns A deep-frozen copy of `value`.
 * @throws {@link WorkflowTaskControlError} with code `WORKFLOW_TASK_INVALID_REQUEST`
 * when the value has a cycle, a non-finite number, a non-plain object, a
 * symbol-keyed property, a sparse array, exceeds
 * `limits`, or `limits` itself is invalid.
 * @internal
 */
export function immutableTaskJson<T>(
  value: T,
  limits: WorkflowTaskJsonLimits = DEFAULT_WORKFLOW_TASK_JSON_LIMITS,
): T {
  return freezeJson(value, limits, invalid);
}

function invalid(message: string): never {
  throw new WorkflowTaskControlError("WORKFLOW_TASK_INVALID_REQUEST", message);
}
