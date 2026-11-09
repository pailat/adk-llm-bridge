import type { InvocationContext } from "@google/adk";
import { WorkflowError } from "../contracts.js";
import { legacyDigest } from "../internal/canonical-hash.js";
import { hashWorkflowValue } from "./hash.js";
import type { WorkflowCheckpointV1 } from "./schema.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
} from "./schema.js";

/** Prefix of every checkpoint key stored in ADK session state. */
export const WORKFLOW_CHECKPOINT_STATE_PREFIX = "__adk_llm_bridge_workflow_v1";
/** Default maximum UTF-8 JSON size of one checkpoint: 4 MiB. */
export const DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

const adkSessionCheckpointObservations = new WeakMap<
  InvocationContext["session"],
  Map<string, CheckpointObservation>
>();

/** Identifies one checkpoint. */
export interface WorkflowCheckpointLocator {
  /** Workflow definition id. */
  workflowId: string;
  /** Execution id. */
  executionId: string;
}

/** Input to {@link WorkflowCheckpointStore.load}. */
export interface LoadWorkflowCheckpointInput extends WorkflowCheckpointLocator {
  /** ADK invocation context the checkpoint is read for. */
  context: InvocationContext;
}

/** Input to {@link WorkflowCheckpointStore.save}. */
export interface SaveWorkflowCheckpointInput {
  /** ADK invocation context the checkpoint is written for. */
  context: InvocationContext;
  /** Checkpoint to persist. */
  checkpoint: WorkflowCheckpointV1;
  /**
   * Revision that must currently exist. `null` means the checkpoint must be
   * absent; `undefined` preserves unconditional writes for legacy adapters.
   */
  expectedRevision?: WorkflowCheckpointRevision | null;
  /** Deterministic revision of `checkpoint`, supplied by the coordinator. */
  revision?: WorkflowCheckpointRevision;
}

/** Deterministic content digest of a checkpoint, used for compare-and-swap writes. */
export type WorkflowCheckpointRevision = string;

/**
 * Values of `details.reason` on the {@link WorkflowError} (code
 * `WORKFLOW_EXECUTION_ERROR`) that checkpoint stores throw.
 *
 * @remarks
 * - `checkpoint_revision_conflict`: a compare-and-swap write found another
 *   revision ({@link WorkflowCheckpointConflictError}).
 * - `checkpoint_size_limit_exceeded`: a checkpoint is larger than the limit.
 * - `checkpoint_revision_invalid`: the supplied revision does not match the
 *   checkpoint, or a stored file carries an invalid revision.
 * - `checkpoint_schema_invalid`: a save was given an invalid checkpoint.
 * - `checkpoint_file_corrupt`: a stored file is not valid JSON or not a valid
 *   checkpoint file.
 * - `checkpoint_file_unsafe`: a checkpoint path is a symlink or not a regular
 *   file.
 * - `checkpoint_directory_create_failed`, `checkpoint_read_failed`,
 *   `checkpoint_stat_failed`, `checkpoint_write_failed`: a file system call
 *   failed (`details.causeCode` has the system code).
 * - `checkpoint_lock_timeout`: the per-checkpoint lock was not acquired in
 *   time.
 * - `checkpoint_lock_corrupt`: the lock is not a safe directory or has no
 *   valid owner, so it is never taken over.
 * - `checkpoint_lock_ownership_lost`: another writer took the lock before the
 *   commit.
 * - `checkpoint_lock_acquire_failed`, `checkpoint_lock_candidate_failed`,
 *   `checkpoint_lock_candidate_cleanup_failed`, `checkpoint_lock_read_failed`,
 *   `checkpoint_lock_recovery_failed`, `checkpoint_lock_release_failed`,
 *   `checkpoint_lock_cleanup_failed`: a file system call on the lock failed.
 */
export type WorkflowCheckpointFailureReason =
  | "checkpoint_revision_conflict"
  | "checkpoint_size_limit_exceeded"
  | "checkpoint_revision_invalid"
  | "checkpoint_file_corrupt"
  | "checkpoint_schema_invalid"
  | "checkpoint_file_unsafe"
  | "checkpoint_directory_create_failed"
  | "checkpoint_read_failed"
  | "checkpoint_stat_failed"
  | "checkpoint_write_failed"
  | "checkpoint_lock_timeout"
  | "checkpoint_lock_corrupt"
  | "checkpoint_lock_ownership_lost"
  | "checkpoint_lock_acquire_failed"
  | "checkpoint_lock_candidate_failed"
  | "checkpoint_lock_candidate_cleanup_failed"
  | "checkpoint_lock_read_failed"
  | "checkpoint_lock_recovery_failed"
  | "checkpoint_lock_release_failed"
  | "checkpoint_lock_cleanup_failed";

/** Details carried by {@link WorkflowCheckpointConflictError}. */
export interface WorkflowCheckpointConflictDetails {
  /** Constant discriminator. */
  reason: Extract<
    WorkflowCheckpointFailureReason,
    "checkpoint_revision_conflict"
  >;
  /** Key of the conflicting checkpoint. */
  checkpointKey: string;
  /** Revision the writer expected; `null` means it expected no checkpoint. */
  expectedRevision: WorkflowCheckpointRevision | null;
  /** Revision found in storage; `null` means no checkpoint exists. */
  actualRevision: WorkflowCheckpointRevision | null;
}

/**
 * Deterministic stale-write failure shared by checkpoint store adapters.
 *
 * @remarks
 * Its `code` is `WORKFLOW_EXECUTION_ERROR`; check `conflict.reason` to tell it apart.
 */
export class WorkflowCheckpointConflictError extends WorkflowError {
  /** Structured conflict details, also copied into the error `details`. */
  readonly conflict: WorkflowCheckpointConflictDetails;

  /**
   * @param checkpointKey - Key of the conflicting checkpoint.
   * @param expectedRevision - Revision the writer expected, or `null` for none.
   * @param actualRevision - Revision found in storage, or `null` for none.
   */
  constructor(
    checkpointKey: string,
    expectedRevision: WorkflowCheckpointRevision | null,
    actualRevision: WorkflowCheckpointRevision | null,
  ) {
    const conflict: WorkflowCheckpointConflictDetails = {
      reason: "checkpoint_revision_conflict",
      checkpointKey,
      expectedRevision,
      actualRevision,
    };
    super(
      "WORKFLOW_EXECUTION_ERROR",
      `Workflow checkpoint revision conflict: ${checkpointKey}`,
      { ...conflict },
    );
    this.name = "WorkflowCheckpointConflictError";
    this.conflict = conflict;
  }
}

/** Result of a successful {@link WorkflowCheckpointStore.save}. */
export interface WorkflowCheckpointWrite {
  /** Key the checkpoint was written under. */
  checkpointKey: string;
  /** Attach this object to an ADK event through `actions.stateDelta`. */
  stateDelta: Record<string, unknown>;
}

/** Persistence boundary for workflow checkpoints. */
export interface WorkflowCheckpointStore {
  /**
   * Loads a checkpoint.
   *
   * @param input - Workflow id, execution id and invocation context.
   * @returns The checkpoint, or `undefined` when none exists.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the stored value is invalid or too large.
   */
  load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined>;
  /**
   * Saves a checkpoint.
   *
   * @remarks
   * Durable adapters should compare `expectedRevision` and write the new
   * checkpoint atomically in one storage transaction. Optional CAS fields keep
   * unconditional adapters source-compatible.
   *
   * @param input - Checkpoint plus optional revision preconditions.
   * @returns The key and the `stateDelta` to attach to an ADK event.
   * @throws {@link WorkflowCheckpointConflictError} when `expectedRevision` does not match the stored revision.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` for an invalid or oversized checkpoint.
   */
  save(input: SaveWorkflowCheckpointInput): Promise<WorkflowCheckpointWrite>;
}

/** Options for {@link ADKSessionCheckpointStore}. */
export interface ADKSessionCheckpointStoreOptions {
  /**
   * Maximum UTF-8 JSON size of one durable checkpoint.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES}
   */
  maxCheckpointBytes?: number;
}

/**
 * Computes the revision of a checkpoint.
 *
 * @param checkpoint - Checkpoint to digest.
 * @returns The canonical content digest.
 */
export async function workflowCheckpointRevision(
  checkpoint: WorkflowCheckpointV1,
): Promise<WorkflowCheckpointRevision> {
  return await hashWorkflowValue(checkpoint);
}

/**
 * Tells whether `stored` is the revision of `checkpoint`.
 *
 * @remarks
 * Accepts the canonical digest and the `localeCompare`-based digest written by
 * releases before 0.7.0. Legacy acceptance lives only here and in
 * `src/workflows/internal/canonical-hash.ts`.
 *
 * @param checkpoint - Checkpoint to digest.
 * @param stored - Revision read from storage.
 * @returns `true` when `stored` matches either form.
 */
export async function workflowCheckpointRevisionMatches(
  checkpoint: WorkflowCheckpointV1,
  stored: string,
): Promise<boolean> {
  if (stored === (await workflowCheckpointRevision(checkpoint))) return true;
  return stored === (await legacyDigest(checkpoint, "locale"));
}

/**
 * Measures the UTF-8 JSON size of a checkpoint.
 *
 * @param checkpoint - Checkpoint to measure.
 * @returns Size in bytes.
 */
export function workflowCheckpointByteLength(
  checkpoint: WorkflowCheckpointV1,
): number {
  return new TextEncoder().encode(JSON.stringify(checkpoint)).byteLength;
}

/**
 * Rejects checkpoints larger than the configured limit.
 *
 * @param checkpoint - Checkpoint to measure.
 * @param checkpointKey - Key used in the error details.
 * @param maxBytes - Maximum allowed size in bytes.
 * @param direction - Whether the checkpoint is being loaded or saved.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` and `details.reason` `checkpoint_size_limit_exceeded`.
 */
export function assertWorkflowCheckpointSize(
  checkpoint: WorkflowCheckpointV1,
  checkpointKey: string,
  maxBytes: number,
  direction: "load" | "save",
): void {
  const actualBytes = workflowCheckpointByteLength(checkpoint);
  if (actualBytes > maxBytes) {
    throw workflowCheckpointSizeLimitError(
      checkpointKey,
      maxBytes,
      actualBytes,
      direction,
    );
  }
}

/**
 * Builds the error for an oversized checkpoint.
 *
 * @param checkpointKey - Key of the checkpoint.
 * @param maxBytes - Configured limit in bytes.
 * @param actualBytes - Measured size in bytes.
 * @param direction - Whether the checkpoint was being loaded or saved.
 * @returns A {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR`.
 */
export function workflowCheckpointSizeLimitError(
  checkpointKey: string,
  maxBytes: number,
  actualBytes: number,
  direction: "load" | "save",
): WorkflowError {
  return new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    `Workflow checkpoint exceeds size limit: ${checkpointKey}`,
    {
      reason:
        "checkpoint_size_limit_exceeded" satisfies WorkflowCheckpointFailureReason,
      checkpointKey,
      maxBytes,
      actualBytes,
      direction,
    },
  );
}

/**
 * Builds the session-state key of a checkpoint.
 *
 * @param workflowId - Workflow definition id.
 * @param executionId - Execution id.
 * @returns The key `<prefix>:<workflowId>:<executionId>`.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when either id is blank.
 * @internal
 */
export function workflowCheckpointKey(
  workflowId: string,
  executionId: string,
): string {
  if (!workflowId.trim() || !executionId.trim()) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow id and execution id are required for checkpointing",
    );
  }
  return `${WORKFLOW_CHECKPOINT_STATE_PREFIX}:${workflowId}:${executionId}`;
}

/**
 * Persists checkpoints through ADK's event `stateDelta` contract.
 *
 * @remarks
 * `save` intentionally does not mutate `session.state`; the ADK Runner owns
 * state application and durable session persistence after the returned delta
 * is attached to an emitted event. A process-local shadow coordinates store
 * instances sharing the same ADK session object, but it is not an atomic
 * cross-process compare-and-swap guarantee.
 */
export class ADKSessionCheckpointStore implements WorkflowCheckpointStore {
  readonly #maxCheckpointBytes: number;

  /**
   * @param options - Size limit options.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when `maxCheckpointBytes` is not a positive safe integer.
   */
  constructor(options: ADKSessionCheckpointStoreOptions = {}) {
    this.#maxCheckpointBytes = positiveSafeInteger(
      "maxCheckpointBytes",
      options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    );
  }

  /**
   * Reads the checkpoint visible in session state, or the pending one saved in this process.
   *
   * @param input - Workflow id, execution id and invocation context.
   * @returns The checkpoint, or `undefined` when none exists.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the stored value is invalid or too large.
   */
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    const key = workflowCheckpointKey(input.workflowId, input.executionId);
    const observation = await this.#observe(input.context, key);
    return observation.currentCheckpoint;
  }

  /**
   * Validates a checkpoint and returns the `stateDelta` that persists it.
   *
   * @param input - Checkpoint plus optional revision preconditions.
   * @returns The key and the `stateDelta` to attach to an ADK event.
   * @throws {@link WorkflowCheckpointConflictError} when `expectedRevision` does not match the current revision.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` for an invalid checkpoint, an oversized
   * checkpoint, or a supplied `revision` that does not match the checkpoint.
   */
  async save(
    input: SaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    if (!isWorkflowCheckpointV1(input.checkpoint)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Cannot persist an invalid workflow checkpoint",
      );
    }
    const durableCheckpoint = toDurableWorkflowCheckpoint(input.checkpoint);
    const checkpointKey = workflowCheckpointKey(
      durableCheckpoint.workflowId,
      durableCheckpoint.executionId,
    );
    assertWorkflowCheckpointSize(
      durableCheckpoint,
      checkpointKey,
      this.#maxCheckpointBytes,
      "save",
    );
    const revision = await workflowCheckpointRevision(durableCheckpoint);
    if (input.revision !== undefined && input.revision !== revision) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Workflow checkpoint revision does not match checkpoint: ${checkpointKey}`,
        {
          checkpointKey,
          suppliedRevision: input.revision,
          computedRevision: revision,
        },
      );
    }

    // Validation, compaction, sizing, and revision checks precede observation
    // so a rejected write cannot publish a process-local shadow value.
    const observation = await this.#observe(input.context, checkpointKey);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== observation.currentRevision
    ) {
      throw new WorkflowCheckpointConflictError(
        checkpointKey,
        input.expectedRevision,
        observation.currentRevision,
      );
    }

    observation.currentRevision = revision;
    observation.currentCheckpoint = durableCheckpoint;

    return {
      checkpointKey,
      stateDelta: { [checkpointKey]: durableCheckpoint },
    };
  }

  async #observe(
    context: InvocationContext,
    checkpointKey: string,
  ): Promise<CheckpointObservation> {
    const stateCheckpoint = checkpointFromState(
      context,
      checkpointKey,
      this.#maxCheckpointBytes,
    );
    const stateRevision = stateCheckpoint
      ? await workflowCheckpointRevision(stateCheckpoint)
      : null;
    let byKey = adkSessionCheckpointObservations.get(context.session);
    if (!byKey) {
      byKey = new Map();
      adkSessionCheckpointObservations.set(context.session, byKey);
    }

    const existing = byKey.get(checkpointKey);
    if (!existing) {
      const observation = {
        stateRevision,
        currentRevision: stateRevision,
        currentCheckpoint: stateCheckpoint,
      };
      byKey.set(checkpointKey, observation);
      return observation;
    }

    if (stateRevision === existing.currentRevision) {
      existing.stateRevision = stateRevision;
      existing.currentCheckpoint = stateCheckpoint;
    } else if (stateRevision !== existing.stateRevision) {
      // The visible ADK state moved to a value other than our pending delta.
      existing.stateRevision = stateRevision;
      existing.currentRevision = stateRevision;
      existing.currentCheckpoint = stateCheckpoint;
    }
    return existing;
  }
}

interface CheckpointObservation {
  /** Last revision observed directly in ADK session state. */
  stateRevision: WorkflowCheckpointRevision | null;
  /** Latest revision returned as a pending stateDelta in this process. */
  currentRevision: WorkflowCheckpointRevision | null;
  currentCheckpoint: WorkflowCheckpointV1 | undefined;
}

function checkpointFromState(
  context: InvocationContext,
  checkpointKey: string,
  maxCheckpointBytes: number,
): WorkflowCheckpointV1 | undefined {
  const value = context.session.state[checkpointKey];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isWorkflowCheckpointV1(value)) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      `Invalid workflow checkpoint in ADK session state: ${checkpointKey}`,
      { checkpointKey },
    );
  }
  const durableCheckpoint = toDurableWorkflowCheckpoint(value);
  assertWorkflowCheckpointSize(
    durableCheckpoint,
    checkpointKey,
    maxCheckpointBytes,
    "load",
  );
  return durableCheckpoint;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      `${name} must be a positive safe integer`,
      { name, value },
    );
  }
  return value;
}
