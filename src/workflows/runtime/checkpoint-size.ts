import type { WorkflowCheckpointV1 } from "../checkpoint/schema.js";
import type { WorkflowCheckpointFailureReason } from "../checkpoint/store.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowCheckpointSizeContributor } from "../events.js";
import { attachCause } from "../internal/error-support.js";

/**
 * Share of a store's `maxCheckpointBytes` at which a run emits one
 * `checkpoint_size_warning` event: 0.8 (80%).
 */
export const WORKFLOW_CHECKPOINT_SIZE_WARNING_RATIO = 0.8;

const DEFAULT_CONTRIBUTOR_COUNT = 5;
const encoder = new TextEncoder();

/**
 * Whether a checkpoint of `bytes` reaches the warning threshold of `maxBytes`.
 *
 * @param bytes - UTF-8 JSON size of the checkpoint.
 * @param maxBytes - Configured limit.
 * @returns `true` when `bytes` is at least 80% of `maxBytes`.
 * @internal
 */
export function reachesCheckpointSizeWarning(
  bytes: number,
  maxBytes: number,
): boolean {
  // Integer form of `bytes >= 0.8 * maxBytes`, free of rounding error.
  return bytes * 5 >= maxBytes * 4;
}

/**
 * Ranks the parts of a checkpoint by UTF-8 JSON size.
 *
 * @remarks
 * Candidates are the top-level fields other than `steps`, each field of each
 * step record other than `result`, and each field of each step result. A
 * path is a list of keys, so a step id that contains a dot stays unambiguous.
 *
 * @param checkpoint - Checkpoint to measure.
 * @param count - Number of entries to return.
 * @returns At most `count` entries, largest first.
 * @internal
 */
export function largestCheckpointContributors(
  checkpoint: WorkflowCheckpointV1,
  count = DEFAULT_CONTRIBUTOR_COUNT,
): WorkflowCheckpointSizeContributor[] {
  const entries: WorkflowCheckpointSizeContributor[] = [];
  const add = (path: string[], value: unknown) => {
    if (value === undefined) return;
    entries.push({ path, bytes: jsonByteLength(value) });
  };
  for (const [key, value] of Object.entries(checkpoint)) {
    if (key !== "steps") add([key], value);
  }
  for (const [stepId, step] of Object.entries(checkpoint.steps)) {
    for (const [key, value] of Object.entries(step)) {
      if (key !== "result") add(["steps", stepId, key], value);
    }
    for (const [key, value] of Object.entries(step.result ?? {})) {
      add(["steps", stepId, "result", key], value);
    }
  }
  return entries.sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

/**
 * Whether `error` is a store's refusal to save an oversized checkpoint.
 *
 * @param error - Value thrown by `WorkflowCheckpointStore.save`.
 * @internal
 */
export function isCheckpointSizeSaveError(
  error: unknown,
): error is WorkflowError {
  return (
    error instanceof WorkflowError &&
    error.details?.reason ===
      ("checkpoint_size_limit_exceeded" satisfies WorkflowCheckpointFailureReason) &&
    error.details.direction !== "load" &&
    error.details.largestContributors === undefined
  );
}

/**
 * Adds the step id and the largest contributors to a store's size error.
 *
 * @remarks
 * Keeps the code, the message prefix and every detail the store set
 * (`reason`, `checkpointKey`, `maxBytes`, `actualBytes`, `direction`). The
 * store's error becomes the non-enumerable `cause`, so its class and stack
 * stay reachable and nothing extra is serialized.
 *
 * @param error - Error from {@link isCheckpointSizeSaveError}.
 * @param checkpoint - Checkpoint the store refused.
 * @param stepId - Step whose transition triggered the save, if any.
 * @returns A new {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR`.
 * @internal
 */
export function enrichCheckpointSizeError(
  error: WorkflowError,
  checkpoint: WorkflowCheckpointV1,
  stepId: string | undefined,
): WorkflowError {
  const details = error.details ?? {};
  const largestContributors = largestCheckpointContributors(checkpoint);
  const largest = largestContributors
    .map((entry) => `${entry.path.join(".")}=${entry.bytes}`)
    .join(", ");
  const sizes = `${String(details.actualBytes)} bytes > limit ${String(details.maxBytes)}`;
  const where = stepId === undefined ? "" : `step ${stepId}; `;
  return attachCause(
    new WorkflowError(
      error.code,
      `${error.message} (${where}${sizes}; largest: ${largest})`,
      {
        ...details,
        ...(stepId === undefined ? {} : { stepId }),
        largestContributors,
      },
    ),
    error,
  );
}

function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").byteLength;
}
