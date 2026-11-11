/**
 * Host-approved changes for completed steps: the operator's acceptance of a
 * known-equivalent input or model change, and its audit entry in the
 * checkpoint.
 */

import { isModelId } from "../../agents/driver/model.js";
import { WorkflowError } from "../contracts.js";

/** What an acceptance covers: the step input or the requested model. */
export type WorkflowReplayChangeKind = "input" | "model";

/**
 * One host-approved change for one completed step of one execution.
 *
 * @remarks
 * Security: an acceptance replays an old result for a new input or model.
 * Load acceptances only from a host-only source (the operator's command line,
 * or a file outside every agent's `workingDirectory`, `allowedPaths` and
 * `readPaths` and outside every lane worktree, writable only by the
 * operator). An agent that can write that file can make a gate replay its old
 * verdict for changed code: it changes the code, then accepts the review
 * step's new input hash. `approvedBy` is a label for the audit, not
 * authentication.
 */
export interface WorkflowReplayAcceptance {
  /** Execution the step belongs to. Entries for other executions are ignored. */
  executionId: string;
  /** Step id. */
  stepId: string;
  /** What changed. */
  kind: WorkflowReplayChangeKind;
  /**
   * Exact saved value: the saved `inputHash` (`sha256:` and 64 lowercase hex)
   * for `input`; the saved requested model (or the `to` of the step's latest
   * accepted model change) for `model`.
   */
  from: string;
  /** Exact current value, in the same form as `from`. */
  to: string;
  /** Why the change is equivalent: 1 to 512 characters, no control characters. */
  reason: string;
  /** Who approved it: 1 to 128 characters, no control characters. A label, not authentication. */
  approvedBy?: string;
}

/**
 * Audit entry of an applied acceptance, stored on the completed step.
 *
 * @remarks
 * The checkpoint store is trusted. A stored entry grants nothing on a later
 * turn: a later replay goes through only because the saved value now equals
 * the current one.
 */
export interface WorkflowCheckpointStepAcceptanceV1 {
  /** What changed. */
  kind: WorkflowReplayChangeKind;
  /** Saved value before the change. */
  from: string;
  /** Accepted value. */
  to: string;
  /** The operator's reason. */
  reason: string;
  /** The operator's label, when given. */
  approvedBy?: string;
  /** Epoch milliseconds when the acceptance was applied. */
  acceptedAt: number;
}

/** Most acceptances one host configuration may carry. */
export const MAX_WORKFLOW_REPLAY_ACCEPTANCES = 1000;
/** Most audit entries one step may hold. */
export const MAX_STEP_ACCEPTANCES = 32;
const MAX_REASON_LENGTH = 512;
const MAX_APPROVED_BY_LENGTH = 128;
const MAX_ID_LENGTH = 1024;
const INPUT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "executionId",
  "stepId",
  "kind",
  "from",
  "to",
  "reason",
  "approvedBy",
]);
const STORED_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "from",
  "to",
  "reason",
  "approvedBy",
  "acceptedAt",
]);

/**
 * Validates a list of host acceptances, for example read from an operator
 * file, and returns frozen copies.
 *
 * @remarks
 * Security: read the list only from a host-only source, never from a file
 * inside any agent's `workingDirectory`, `allowedPaths` or `readPaths`, or a
 * lane worktree (see {@link WorkflowReplayAcceptance}). Validation checks the
 * shape, not where the list came from.
 *
 * Only own data properties are read; an accessor, a symbol key or a
 * prototype other than `Object.prototype` (or `null`) is refused. The error
 * never contains a `reason` text.
 *
 * @param value - Untrusted list.
 * @returns The validated entries, frozen, in the given order.
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` for
 * a value that is not an array, more than 1000 entries, an entry that is not
 * a plain object, an unknown key, an empty or control-character
 * `executionId`/`stepId`, a `kind` other than `input`/`model`, an `input`
 * value that is not `sha256:` and 64 lowercase hex, a `model` value that is
 * not a valid model id, `from` equal to `to`, a `reason`/`approvedBy` out of
 * bounds, or two entries for the same execution, step and kind.
 */
export function parseWorkflowReplayAcceptances(
  value: unknown,
): readonly WorkflowReplayAcceptance[] {
  if (!Array.isArray(value)) {
    throw invalid("replay.acceptChanges must be an array");
  }
  if (value.length > MAX_WORKFLOW_REPLAY_ACCEPTANCES) {
    throw invalid(
      `replay.acceptChanges holds more than ${MAX_WORKFLOW_REPLAY_ACCEPTANCES} entries`,
    );
  }
  const seen = new Set<string>();
  const parsed: WorkflowReplayAcceptance[] = [];
  for (let index = 0; index < value.length; index++) {
    const fields = dataFields(
      Object.hasOwn(value, index) ? value[index] : undefined,
      ENTRY_KEYS,
    );
    if (!fields) {
      throw invalid(
        `replay.acceptChanges[${index}] must be a plain object with only the documented keys`,
      );
    }
    const entry = parseEntry(fields, index);
    const key = JSON.stringify([entry.executionId, entry.stepId, entry.kind]);
    if (seen.has(key)) {
      throw invalid(
        `replay.acceptChanges[${index}] repeats execution, step and kind of an earlier entry`,
      );
    }
    seen.add(key);
    parsed.push(Object.freeze(entry));
  }
  return Object.freeze(parsed);
}

function parseEntry(
  fields: Record<string, unknown>,
  index: number,
): WorkflowReplayAcceptance {
  const at = `replay.acceptChanges[${index}]`;
  const { executionId, stepId, kind, from, to, reason, approvedBy } = fields;
  if (!isId(executionId)) throw invalid(`${at}.executionId is invalid`);
  if (!isId(stepId)) throw invalid(`${at}.stepId is invalid`);
  if (kind !== "input" && kind !== "model") {
    throw invalid(`${at}.kind must be "input" or "model"`);
  }
  if (!isChangeValue(kind, from) || !isChangeValue(kind, to)) {
    throw invalid(
      kind === "input"
        ? `${at}.from and .to must be sha256: digests of 64 lowercase hex`
        : `${at}.from and .to must be model ids`,
    );
  }
  if (from === to) throw invalid(`${at}.from and .to must differ`);
  if (!isText(reason, MAX_REASON_LENGTH)) {
    throw invalid(
      `${at}.reason must be 1 to ${MAX_REASON_LENGTH} characters without control characters`,
    );
  }
  if (approvedBy !== undefined && !isText(approvedBy, MAX_APPROVED_BY_LENGTH)) {
    throw invalid(
      `${at}.approvedBy must be 1 to ${MAX_APPROVED_BY_LENGTH} characters without control characters`,
    );
  }
  return {
    executionId,
    stepId,
    kind,
    from,
    to,
    reason,
    ...(approvedBy === undefined ? {} : { approvedBy }),
  };
}

/**
 * Whether a stored `acceptances` field is well formed: 1 to 32 audit
 * entries, allowed only on a `completed` step.
 *
 * @internal
 */
export function isStepAcceptances(value: unknown, status: unknown): boolean {
  if (
    status !== "completed" ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STEP_ACCEPTANCES
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    const fields = dataFields(
      Object.hasOwn(value, index) ? value[index] : undefined,
      STORED_KEYS,
    );
    if (!fields) return false;
    const { kind, from, to, reason, approvedBy, acceptedAt } = fields;
    if (
      (kind !== "input" && kind !== "model") ||
      !isChangeValue(kind, from) ||
      !isChangeValue(kind, to) ||
      from === to ||
      !isText(reason, MAX_REASON_LENGTH) ||
      (approvedBy !== undefined &&
        !isText(approvedBy, MAX_APPROVED_BY_LENGTH)) ||
      typeof acceptedAt !== "number" ||
      !Number.isFinite(acceptedAt)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The model a completed step counts as having run with for every model
 * comparison: the `to` of its latest accepted model change, else the model
 * its agent requested. `model.requested` itself is never rewritten.
 *
 * @internal
 */
export function effectiveSavedModel(saved: {
  model?: { requested?: string };
  acceptances?: readonly WorkflowCheckpointStepAcceptanceV1[];
}): string | undefined {
  const accepted = saved.acceptances?.findLast(
    (entry) => entry.kind === "model",
  );
  return accepted ? accepted.to : saved.model?.requested;
}

/** Builds the audit entry stored for an applied acceptance. @internal */
export function acceptanceAuditEntry(
  acceptance: WorkflowReplayAcceptance,
  acceptedAt: number,
): WorkflowCheckpointStepAcceptanceV1 {
  return {
    kind: acceptance.kind,
    from: acceptance.from,
    to: acceptance.to,
    reason: acceptance.reason,
    ...(acceptance.approvedBy === undefined
      ? {}
      : { approvedBy: acceptance.approvedBy }),
    acceptedAt,
  };
}

/**
 * Own enumerable data properties of a plain object, or `undefined` when the
 * value is not one, has an accessor or symbol key, or has a key outside
 * `allowed`. Values are read from the descriptors, so no getter runs.
 */
function dataFields(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const fields: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return undefined;
    }
    fields[key] = descriptor.value;
  }
  return fields;
}

function isChangeValue(
  kind: WorkflowReplayChangeKind,
  value: unknown,
): value is string {
  return kind === "input"
    ? typeof value === "string" && INPUT_DIGEST.test(value)
    : isModelId(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !CONTROL.test(value)
  );
}

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    !CONTROL.test(value)
  );
}

function invalid(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message);
}
