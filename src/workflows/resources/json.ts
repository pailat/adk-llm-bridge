import { canonicalJson as canonicalJsonText } from "../internal/canonical-hash.js";
import { isWorkflowIdentifier } from "../internal/identifiers.js";

/** JSON scalar allowed in resource payloads. */
export type WorkflowResourceJsonPrimitive = boolean | number | string | null;
/** Any JSON-safe value: scalar, readonly array, or plain object. */
export type WorkflowResourceJsonValue =
  | WorkflowResourceJsonPrimitive
  | readonly WorkflowResourceJsonValue[]
  | WorkflowResourceJsonObject;
/** Plain JSON object with readonly entries. */
export interface WorkflowResourceJsonObject {
  readonly [key: string]: WorkflowResourceJsonValue;
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_LENGTH = 1_048_576;

/**
 * Validates a resource identity used in ids and revisions.
 *
 * @param value - Candidate identity.
 * @param field - Field name used in the error message.
 * @returns The same string when it is an opaque id: 1-256 characters of
 * `[A-Za-z0-9._:+/-]` starting with an alphanumeric.
 * @throws `TypeError` when the value is not a safe identity.
 */
export function requiredResourceIdentity(value: string, field: string): string {
  if (!isWorkflowIdentifier(value, "opaque")) {
    throw new TypeError(
      `${field} must be a safe 1-256 character resource identity`,
    );
  }
  return value;
}

/**
 * Snapshots an optional JSON object, treating `undefined` as `{}`.
 *
 * @param value - Object to snapshot.
 * @param field - Field name used in error messages.
 * @returns A deep-frozen copy with sorted keys.
 * @throws `TypeError` under the same conditions as {@link snapshotJson}.
 */
export function optionalJsonObject(
  value: WorkflowResourceJsonObject | undefined,
  field: string,
): WorkflowResourceJsonObject {
  return snapshotJson(value ?? {}, field) as WorkflowResourceJsonObject;
}

/**
 * Deep-copies and freezes a JSON value, rejecting anything that is not plain JSON.
 *
 * @remarks
 * Enforces limits (depth 32, 10 000 nodes, 1 MiB per string) and rejects
 * cycles, non-finite numbers, accessors, symbols, sparse arrays and non-plain
 * prototypes, so a stored snapshot cannot change or smuggle host objects.
 *
 * @param value - Value to snapshot.
 * @param field - Field name used in error messages.
 * @returns The frozen copy.
 * @throws `TypeError` when the value violates the rules above.
 */
export function snapshotJson(
  value: WorkflowResourceJsonValue,
  field: string,
): WorkflowResourceJsonValue {
  const seen = new Set<object>();
  const budget = { nodes: 0 };
  return cloneJson(value, field, 0, seen, budget);
}

/**
 * Serializes a JSON value to canonical text.
 *
 * @remarks
 * Object keys are sorted by UTF-16 code unit at every level (see
 * `src/workflows/internal/canonical-hash.ts`).
 *
 * @param value - JSON value.
 * @returns Canonical JSON text.
 */
export function canonicalJson(value: WorkflowResourceJsonValue): string {
  return canonicalJsonText(value);
}

function cloneJson(
  value: WorkflowResourceJsonValue,
  field: string,
  depth: number,
  seen: Set<object>,
  budget: { nodes: number },
): WorkflowResourceJsonValue {
  budget.nodes++;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new TypeError(`${field} exceeds JSON structure limits`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${field} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw new TypeError(`${field} contains an oversized JSON string`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${field} must be JSON-safe`);
  }
  if (seen.has(value)) {
    throw new TypeError(`${field} must not contain JSON cycles`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      assertPlainArray(value, field);
      return Object.freeze(
        value.map((entry, index) =>
          cloneJson(entry, `${field}[${index}]`, depth + 1, seen, budget),
        ),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${field} must contain only plain JSON objects`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    if (Reflect.ownKeys(value).length !== keys.length) {
      throw new TypeError(`${field} contains non-JSON object properties`);
    }
    const output: Record<string, WorkflowResourceJsonValue> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${field} contains non-data JSON properties`);
      }
      output[key] = cloneJson(
        descriptor.value as WorkflowResourceJsonValue,
        `${field}.${key}`,
        depth + 1,
        seen,
        budget,
      );
    }
    return Object.freeze(output);
  } finally {
    seen.delete(value);
  }
}

function assertPlainArray(value: readonly unknown[], field: string): void {
  const keys = Object.keys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    keys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !("value" in descriptor);
    }) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key === "symbol" || (key !== "length" && !keys.includes(key)),
    )
  ) {
    throw new TypeError(`${field} must contain dense plain JSON arrays`);
  }
}

/**
 * Throws when the signal has aborted.
 *
 * @param signal - Optional abort signal.
 * @throws The signal's reason, or an `Error` when it has none.
 */
export function throwIfResourceAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Workflow resource operation aborted");
}
