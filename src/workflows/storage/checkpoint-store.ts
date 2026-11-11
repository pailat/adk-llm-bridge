import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointStatus,
  type WorkflowCheckpointV1,
} from "../checkpoint/schema.js";
import {
  assertWorkflowCheckpointSize,
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointLocator,
  type WorkflowCheckpointRevision,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite,
  workflowCheckpointKey,
  workflowCheckpointRevision,
  workflowCheckpointRevisionMatches,
} from "../checkpoint/store.js";
import { WorkflowError } from "../contracts.js";
import { isWorkflowStorageError, WorkflowStorageError } from "./errors.js";
import {
  recordWorkflowStorageOperation,
  retryWorkflowStorageOperation,
  type WorkflowStorageHealth,
  type WorkflowStorageMetricsObserver,
  type WorkflowStorageOperationMetric,
  type WorkflowStorageRetryPolicy,
} from "./support.js";

/**
 * Version of the checkpoint provider contract that
 * {@link BaseWorkflowCheckpointStore} implements.
 *
 * @remarks
 * It changes only when a provider written against the previous version would
 * stop being correct. The conformance suite of
 * `adk-llm-bridge/workflows/storage/conformance` tests one version.
 *
 * @experimental
 */
export const WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION = 1;

/** Default page size of {@link BaseWorkflowCheckpointStore.list}. */
export const DEFAULT_WORKFLOW_CHECKPOINT_LIST_LIMIT = 50;
/** Largest page size of {@link BaseWorkflowCheckpointStore.list}. */
export const MAX_WORKFLOW_CHECKPOINT_LIST_LIMIT = 500;

const DEFAULT_WORKFLOW_CHECKPOINT_PRUNE_LIMIT = 500;

/**
 * What a checkpoint provider guarantees. The runtime and the conformance
 * suite read these flags; a provider never claims more than it enforces.
 *
 * @experimental
 */
export interface WorkflowCheckpointStoreCapabilities {
  /**
   * `atomic`: the revision comparison and the write are one storage
   * transaction, so exactly one of several concurrent writers wins, across
   * processes. `advisory`: the comparison is made, but another writer can
   * commit between it and the write.
   */
  compareAndSet: "atomic" | "advisory";
  /**
   * Whether leases with fencing tokens are implemented and checked in the
   * same transaction as a save.
   */
  leases: boolean;
  /** Whether a saved checkpoint survives the end of the process. */
  durable: boolean;
  /** Whether writers in several processes can share the storage. */
  multiProcess: boolean;
  /** Whether {@link BaseWorkflowCheckpointStore.list} is implemented. */
  listing: boolean;
  /**
   * Whether {@link BaseWorkflowCheckpointStore.delete} and
   * {@link BaseWorkflowCheckpointStore.prune} are implemented.
   */
  pruning: boolean;
  /** Largest UTF-8 JSON size of one checkpoint, in bytes. */
  maxCheckpointBytes: number;
}

/**
 * Options shared by every {@link BaseWorkflowCheckpointStore}.
 *
 * @experimental
 */
export interface BaseWorkflowCheckpointStoreOptions {
  /**
   * Maximum UTF-8 JSON size of one checkpoint, in bytes.
   *
   * @defaultValue `DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES` (4 MiB)
   */
  maxCheckpointBytes?: number;
  /**
   * Time limit of one try of a storage operation, in milliseconds. A try
   * that exceeds it fails with `WORKFLOW_STORAGE_TIMEOUT`, which is retried
   * under the `retry` policy, so a backend that never answers holds the call
   * for up to `retry.maxAttempts` tries plus the backoff delays.
   *
   * @defaultValue 30000
   */
  operationTimeoutMs?: number;
  /**
   * Retry rules for transient failures (`WORKFLOW_STORAGE_UNAVAILABLE`,
   * `WORKFLOW_STORAGE_TIMEOUT`). Conflicts and lease errors are never
   * retried.
   *
   * @defaultValue 4 tries, 50 ms initial delay, doubling up to 2 s
   */
  retry?: WorkflowStorageRetryPolicy;
  /** Receives one metric per finished operation, without payloads. */
  onOperation?: WorkflowStorageMetricsObserver;
}

/**
 * A checkpoint as a provider holds it.
 *
 * @experimental
 */
export interface StoredWorkflowCheckpoint {
  /** The checkpoint in its durable form. */
  checkpoint: WorkflowCheckpointV1;
  /** Content digest of `checkpoint`. */
  revision: WorkflowCheckpointRevision;
  /** Epoch milliseconds of the last successful save. */
  updatedAt: number;
}

/**
 * One row of a checkpoint listing. It has no step data.
 *
 * @experimental
 */
export interface WorkflowCheckpointSummary extends WorkflowCheckpointLocator {
  /** Content digest of the stored checkpoint. */
  revision: WorkflowCheckpointRevision;
  /** Status recorded in the checkpoint. */
  status: WorkflowCheckpointStatus;
  /** Epoch milliseconds of the last successful save. */
  updatedAt: number;
  /** UTF-8 JSON size of the stored checkpoint, in bytes. */
  bytes: number;
}

/**
 * Filters and page position of {@link BaseWorkflowCheckpointStore.list}.
 *
 * @experimental
 */
export interface ListWorkflowCheckpointsInput {
  /** Return only checkpoints of this workflow definition. */
  workflowId?: string;
  /** Return only checkpoints in this status. */
  status?: WorkflowCheckpointStatus;
  /** Return only checkpoints last saved before this time (epoch milliseconds). */
  updatedBefore?: number;
  /** Opaque cursor from the `nextCursor` of the previous page. */
  cursor?: string;
  /**
   * Page size, from 1 to {@link MAX_WORKFLOW_CHECKPOINT_LIST_LIMIT}.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_CHECKPOINT_LIST_LIMIT}
   */
  limit?: number;
}

/**
 * One page of {@link BaseWorkflowCheckpointStore.list}.
 *
 * @experimental
 */
export interface ListWorkflowCheckpointsResult {
  /** Summaries ordered by workflow id, then execution id. */
  items: readonly WorkflowCheckpointSummary[];
  /** Cursor of the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * Input of {@link BaseWorkflowCheckpointStore.delete}.
 *
 * @experimental
 */
export interface DeleteWorkflowCheckpointInput
  extends WorkflowCheckpointLocator {
  /**
   * Revision that must be stored for the delete to happen. Omit to delete
   * whatever is stored.
   */
  expectedRevision?: WorkflowCheckpointRevision;
}

/**
 * Input of {@link BaseWorkflowCheckpointStore.prune}.
 *
 * @experimental
 */
export interface PruneWorkflowCheckpointsInput {
  /** Delete only checkpoints last saved before this time (epoch milliseconds). */
  updatedBefore: number;
  /** Delete only checkpoints of this workflow definition. */
  workflowId?: string;
  /**
   * Delete only checkpoints in one of these statuses.
   *
   * @defaultValue `["completed", "failed"]`
   */
  statuses?: readonly WorkflowCheckpointStatus[];
  /**
   * Largest number of checkpoints one call deletes.
   *
   * @defaultValue 500
   */
  limit?: number;
}

/**
 * Result of {@link BaseWorkflowCheckpointStore.prune}.
 *
 * @experimental
 */
export interface PruneWorkflowCheckpointsResult {
  /** Number of checkpoints deleted by this call. */
  deleted: number;
  /** Whether more matching checkpoints remain; call again to continue. */
  hasMore: boolean;
}

/**
 * Input of {@link BaseWorkflowCheckpointStore.acquireLease}.
 *
 * @experimental
 */
export interface AcquireWorkflowCheckpointLeaseInput
  extends WorkflowCheckpointLocator {
  /** Opaque id of the worker asking for the lease; unique per worker. */
  ownerId: string;
  /** Lifetime of the lease from now, in milliseconds. */
  ttlMs: number;
}

/**
 * Exclusive right of one worker to advance an execution, until it expires or
 * a newer lease replaces it.
 *
 * @remarks
 * Expiry is judged by the clock of the acquiring process, so it only decides
 * when a takeover may happen. Safety comes from `fencingToken`: a save that
 * carries a token lower than the current one is rejected by the store.
 *
 * @experimental
 */
export interface WorkflowCheckpointLease extends WorkflowCheckpointLocator {
  /** Owner the lease was granted to. */
  ownerId: string;
  /**
   * Positive safe integer that grows by one with every lease granted for the
   * execution.
   */
  fencingToken: number;
  /** Epoch milliseconds after which another owner may take the lease. */
  expiresAt: number;
}

/**
 * Input of {@link BaseWorkflowCheckpointStore.save}: the store contract's
 * input plus an optional fencing token.
 *
 * @experimental
 */
export interface FencedSaveWorkflowCheckpointInput
  extends SaveWorkflowCheckpointInput {
  /**
   * Fencing token of the lease the writer holds. When set, the store rejects
   * the save with `WORKFLOW_STORAGE_LEASE_LOST` unless it is the current
   * token of the execution. A provider without lease support rejects a save
   * that carries a token with `WORKFLOW_STORAGE_UNSUPPORTED`.
   */
  fencingToken?: number;
}

/**
 * Input of {@link BaseWorkflowCheckpointStore.put}: a save that needs no ADK
 * invocation context.
 *
 * @experimental
 */
export type PutWorkflowCheckpointInput = Omit<
  FencedSaveWorkflowCheckpointInput,
  "context"
>;

/**
 * A validated write, as {@link BaseWorkflowCheckpointStore} hands it to a
 * provider.
 *
 * @experimental
 */
export interface WorkflowCheckpointWriteRequest
  extends WorkflowCheckpointLocator {
  /** Key of the checkpoint, as `stateDelta` uses it. */
  checkpointKey: string;
  /** The checkpoint in its durable form, already validated. */
  checkpoint: WorkflowCheckpointV1;
  /** `JSON.stringify(checkpoint)`, measured against the size limit. */
  serialized: string;
  /** UTF-8 size of `serialized`, in bytes. */
  bytes: number;
  /** Content digest of `checkpoint`, computed by the base class. */
  revision: WorkflowCheckpointRevision;
  /**
   * Revision that must be stored: `null` means none may exist, `undefined`
   * means the write is unconditional.
   */
  expectedRevision: WorkflowCheckpointRevision | null | undefined;
  /** Fencing token to verify in the same transaction, when given. */
  fencingToken?: number;
}

/**
 * Abstract contract of a workflow checkpoint provider, in the style of ADK's
 * `BaseSessionService`: the host creates one provider and injects it as
 * `checkpointStore`.
 *
 * @remarks
 * The public methods validate, measure, time out, retry and report metrics
 * once for every provider; a provider implements the protected storage
 * primitives. Guarantees every provider gives, each one a test of the
 * conformance suite:
 *
 * - Atomic write: after `save` resolves, `load` returns the new checkpoint;
 *   if `save` rejects or the process dies, `load` returns the previous one,
 *   never a mix.
 * - Compare-and-set: with `expectedRevision`, the save happens only when the
 *   stored revision equals it (`null`: nothing stored); otherwise it rejects
 *   with `WorkflowCheckpointConflictError`. With `compareAndSet: "atomic"`
 *   exactly one of N concurrent writers wins.
 * - Idempotent save: repeating a save whose revision is already stored
 *   resolves without a conflict, so a retry after a timeout is safe.
 * - Fencing: with `leases: true`, a save carrying a fencing token lower than
 *   the current one rejects with `WORKFLOW_STORAGE_LEASE_LOST` and writes
 *   nothing.
 * - Integrity: a stored value that is not the checkpoint its revision names
 *   is never returned; `load` rejects.
 * - Bounded size: a checkpoint larger than `maxCheckpointBytes` is rejected
 *   before any write (`checkpoint_size_limit_exceeded`).
 * - No fallback: a provider never reads from or writes to another provider.
 *
 * Operations a provider does not implement reject with
 * `WORKFLOW_STORAGE_UNSUPPORTED`, and the matching capability flag is
 * `false`.
 *
 * @example
 * ```ts
 * import { WorkflowAgent, getWorkflowCheckpointStoreFromUri } from "adk-llm-bridge/workflows";
 *
 * const checkpointStore = await getWorkflowCheckpointStoreFromUri("sqlite:///var/lib/app/workflows.db");
 * const agent = new WorkflowAgent({ name: "release", definition, agents, checkpointStore });
 * ```
 *
 * @experimental
 */
export abstract class BaseWorkflowCheckpointStore
  implements WorkflowCheckpointStore
{
  /** Contract version this provider was written against. */
  readonly contractVersion: number = WORKFLOW_CHECKPOINT_STORE_CONTRACT_VERSION;
  /** Short provider name used in metrics and health results, for example `sqlite`. */
  abstract readonly providerName: string;
  /** What this provider guarantees. */
  abstract readonly capabilities: WorkflowCheckpointStoreCapabilities;

  /** Options given to the constructor. */
  protected readonly baseOptions: BaseWorkflowCheckpointStoreOptions;

  #closed = false;
  #closing: Promise<void> | undefined;

  /**
   * Stores the shared options.
   *
   * @param options - Size limit, time limit, retry rules and metrics
   * observer.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_INVALID_OPTION` for a value that is not a positive
   * safe integer.
   */
  constructor(options: BaseWorkflowCheckpointStoreOptions = {}) {
    optionalPositiveInteger("maxCheckpointBytes", options.maxCheckpointBytes);
    optionalPositiveInteger("operationTimeoutMs", options.operationTimeoutMs);
    const retry = options.retry;
    if (retry !== undefined) {
      optionalPositiveInteger("retry.maxAttempts", retry.maxAttempts);
      optionalNonNegativeNumber("retry.initialDelayMs", retry.initialDelayMs);
      optionalNonNegativeNumber("retry.maxDelayMs", retry.maxDelayMs);
      if (
        retry.jitter !== undefined &&
        !(
          Number.isFinite(retry.jitter) &&
          retry.jitter >= 0 &&
          retry.jitter <= 1
        )
      ) {
        throw invalidOption("retry.jitter", "must be a number from 0 to 1");
      }
    }
    this.baseOptions = options;
  }

  /**
   * Loads a checkpoint for the runtime.
   *
   * @param input - Workflow id, execution id and invocation context; the
   * context is not used by providers that own their storage.
   * @returns The checkpoint, or `undefined` when none exists.
   * @throws `WorkflowError` with code `WORKFLOW_EXECUTION_ERROR`, or
   * {@link WorkflowStorageError} with code `WORKFLOW_STORAGE_CORRUPT`, when
   * the stored value is invalid or too large.
   */
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    return await this.#operation("load", async (report) => {
      const stored = await this.#read(input);
      if (stored) report.bytes = stored.bytes;
      return stored?.value.checkpoint;
    });
  }

  /**
   * Saves a checkpoint for the runtime.
   *
   * @param input - Checkpoint, revision preconditions and optional fencing
   * token.
   * @returns The key and the `stateDelta` to attach to an ADK event.
   * @throws `WorkflowCheckpointConflictError` when `expectedRevision` does
   * not match the stored revision.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_LEASE_LOST` when the fencing token is stale.
   * @throws `WorkflowError` with code `WORKFLOW_EXECUTION_ERROR` for an
   * invalid or oversized checkpoint.
   */
  async save(
    input: FencedSaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    return await this.#operation("save", async (report) => {
      const written = await this.#write(input);
      report.bytes = written.bytes;
      return {
        checkpointKey: written.checkpointKey,
        stateDelta: { [written.checkpointKey]: written.checkpoint },
      };
    });
  }

  /**
   * Reads a checkpoint with its revision, without an ADK invocation context.
   *
   * @param locator - Workflow id and execution id.
   * @returns The stored checkpoint, or `undefined` when none exists.
   * @throws The same errors as {@link BaseWorkflowCheckpointStore.load}.
   */
  async get(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    return await this.#operation("get", async (report) => {
      const stored = await this.#read(locator);
      if (stored) report.bytes = stored.bytes;
      return stored?.value;
    });
  }

  /**
   * Saves a checkpoint without an ADK invocation context.
   *
   * @param input - Checkpoint, revision preconditions and optional fencing
   * token.
   * @returns What was stored.
   * @throws The same errors as {@link BaseWorkflowCheckpointStore.save}.
   */
  async put(
    input: PutWorkflowCheckpointInput,
  ): Promise<StoredWorkflowCheckpoint> {
    return await this.#operation("put", async (report) => {
      const written = await this.#write(input);
      report.bytes = written.bytes;
      return {
        checkpoint: written.checkpoint,
        revision: written.revision,
        updatedAt: written.updatedAt,
      };
    });
  }

  /**
   * Lists checkpoint summaries, one page at a time.
   *
   * @param input - Filters, cursor and page size.
   * @returns A page and the cursor of the next one.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.listing` is `false`,
   * or `WORKFLOW_STORAGE_INVALID_OPTION` for a bad cursor or limit.
   */
  async list(
    input: ListWorkflowCheckpointsInput = {},
  ): Promise<ListWorkflowCheckpointsResult> {
    return await this.#operation("list", async (report) => {
      this.#require("listing", "list");
      const limit = input.limit ?? DEFAULT_WORKFLOW_CHECKPOINT_LIST_LIMIT;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_WORKFLOW_CHECKPOINT_LIST_LIMIT
      ) {
        throw invalidOption(
          "limit",
          `must be an integer from 1 to ${MAX_WORKFLOW_CHECKPOINT_LIST_LIMIT}`,
        );
      }
      if (
        input.cursor !== undefined &&
        (typeof input.cursor !== "string" || input.cursor === "")
      ) {
        throw invalidOption("cursor", "must be a non-empty string");
      }
      if (input.updatedBefore !== undefined) {
        finiteTime("updatedBefore", input.updatedBefore);
      }
      if (input.workflowId !== undefined) {
        nonEmptyString("workflowId", input.workflowId);
      }
      if (input.status !== undefined) status("status", input.status);
      const page = await this.#attempt(() =>
        this.listCheckpoints({ ...input, limit }),
      );
      report.records = page.items.length;
      return page;
    });
  }

  /**
   * Deletes one checkpoint and its lease.
   *
   * @param input - Locator and optional expected revision.
   * @returns `true` when a checkpoint was deleted, `false` when none existed.
   * @throws `WorkflowCheckpointConflictError` when `expectedRevision` does
   * not match.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.pruning` is `false`.
   */
  async delete(input: DeleteWorkflowCheckpointInput): Promise<boolean> {
    return await this.#operation("delete", async () => {
      this.#require("pruning", "delete");
      workflowCheckpointKey(input.workflowId, input.executionId);
      if (
        input.expectedRevision !== undefined &&
        typeof input.expectedRevision !== "string"
      ) {
        throw invalidOption("expectedRevision", "must be a string");
      }
      return await this.#attempt(() => this.deleteCheckpoint(input));
    });
  }

  /**
   * Deletes old checkpoints: the retention hook a host calls on a schedule.
   *
   * @param input - Age limit, filters and batch size.
   * @returns How many were deleted and whether more remain.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.pruning` is `false`.
   */
  async prune(
    input: PruneWorkflowCheckpointsInput,
  ): Promise<PruneWorkflowCheckpointsResult> {
    return await this.#operation("prune", async (report) => {
      this.#require("pruning", "prune");
      finiteTime("updatedBefore", input.updatedBefore);
      const statuses = input.statuses ?? ["completed", "failed"];
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw invalidOption("statuses", "must be a non-empty array");
      }
      for (const value of statuses) status("statuses", value);
      const limit = input.limit ?? DEFAULT_WORKFLOW_CHECKPOINT_PRUNE_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw invalidOption("limit", "must be a positive safe integer");
      }
      if (input.workflowId !== undefined) {
        nonEmptyString("workflowId", input.workflowId);
      }
      const result = await this.#attempt(() =>
        this.pruneCheckpoints({
          updatedBefore: input.updatedBefore,
          statuses: [...statuses],
          limit,
          ...(input.workflowId === undefined
            ? {}
            : { workflowId: input.workflowId }),
        }),
      );
      report.records = result.deleted;
      return result;
    });
  }

  /**
   * Grants the lease of an execution to `ownerId` when no other owner holds
   * an unexpired one, and raises the fencing token by one.
   *
   * @param input - Locator, owner and lifetime.
   * @returns The granted lease.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_LEASE_HELD` (details: `expiresAt`) when another owner
   * holds it, or `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.leases`
   * is `false`.
   */
  async acquireLease(
    input: AcquireWorkflowCheckpointLeaseInput,
  ): Promise<WorkflowCheckpointLease> {
    return await this.#operation("acquireLease", async () => {
      this.#require("leases", "acquireLease");
      workflowCheckpointKey(input.workflowId, input.executionId);
      nonEmptyString("ownerId", input.ownerId);
      positiveInteger("ttlMs", input.ttlMs);
      return await this.#attempt(() =>
        this.acquireCheckpointLease(input, this.currentTime()),
      );
    });
  }

  /**
   * Extends a lease that is still the current one; the token is unchanged.
   *
   * @param lease - The lease to extend.
   * @param ttlMs - New lifetime from now, in milliseconds.
   * @returns The lease with its new expiry.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_LEASE_LOST` when a newer lease replaced it.
   */
  async renewLease(
    lease: WorkflowCheckpointLease,
    ttlMs: number,
  ): Promise<WorkflowCheckpointLease> {
    return await this.#operation("renewLease", async () => {
      this.#require("leases", "renewLease");
      validateLease(lease);
      positiveInteger("ttlMs", ttlMs);
      return await this.#attempt(() =>
        this.renewCheckpointLease(lease, this.currentTime() + ttlMs),
      );
    });
  }

  /**
   * Gives a lease back. Releasing a lease that is no longer current does
   * nothing.
   *
   * @param lease - The lease to release.
   */
  async releaseLease(lease: WorkflowCheckpointLease): Promise<void> {
    await this.#operation("releaseLease", async () => {
      this.#require("leases", "releaseLease");
      validateLease(lease);
      await this.#attempt(() => this.releaseCheckpointLease(lease));
    });
  }

  /**
   * Checks that the backend answers a read and accepts writes.
   *
   * @returns The health result; it resolves (with `ok: false`) when the
   * backend fails, and never throws.
   */
  async healthCheck(): Promise<WorkflowStorageHealth> {
    const started = performance.now();
    const finish = (
      health: Omit<WorkflowStorageHealth, "provider" | "latencyMs">,
    ): WorkflowStorageHealth => {
      const latencyMs = performance.now() - started;
      this.#report({
        operation: "healthCheck",
        durationMs: latencyMs,
        outcome: health.ok ? "ok" : "error",
        ...(health.code === undefined ? {} : { errorCode: health.code }),
      });
      return { provider: this.providerName, latencyMs, ...health };
    };
    try {
      this.#assertOpen();
      const schemaVersion = await retryWorkflowStorageOperation(
        () => this.checkHealth(),
        {
          maxAttempts: 1,
          attemptTimeoutMs: this.#timeoutMs(),
        },
      );
      return finish({
        ok: true,
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
      });
    } catch (error) {
      if (isWorkflowStorageError(error)) {
        return finish({ ok: false, code: error.code, message: error.message });
      }
      return finish({
        ok: false,
        code: "WORKFLOW_STORAGE_UNAVAILABLE",
        message: "The health probe failed",
      });
    }
  }

  /**
   * Releases the resources of the provider. Later calls reject with
   * `WORKFLOW_STORAGE_CLOSED`. Closing twice does nothing.
   */
  async close(): Promise<void> {
    if (this.#closing) {
      // A second close waits for the first one and never rethrows its failure.
      await this.#closing.catch(() => undefined);
      return;
    }
    this.#closed = true;
    this.#closing = this.closeStore();
    await this.#closing;
  }

  /**
   * Clock the lease operations read, in epoch milliseconds. A provider with
   * an injectable clock overrides it.
   *
   * @returns The current time.
   */
  protected currentTime(): number {
    return Date.now();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_CLOSED",
        `The ${this.providerName} checkpoint provider is closed`,
        { details: { provider: this.providerName } },
      );
    }
  }

  #require(flag: "listing" | "pruning" | "leases", operation: string): void {
    if (this.capabilities[flag]) return;
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNSUPPORTED",
      `The ${this.providerName} checkpoint provider does not support ${operation}`,
      {
        capability: flag,
        details: { provider: this.providerName, operation, capability: flag },
      },
    );
  }

  #timeoutMs(): number {
    return this.baseOptions.operationTimeoutMs ?? 30_000;
  }

  #attempt<T>(run: () => Promise<T>): Promise<T> {
    return retryWorkflowStorageOperation(() => run(), {
      ...this.baseOptions.retry,
      attemptTimeoutMs: this.#timeoutMs(),
    });
  }

  #report(
    metric: Omit<WorkflowStorageOperationMetric, "capability" | "provider">,
  ): void {
    recordWorkflowStorageOperation(
      { capability: "checkpoints", provider: this.providerName, ...metric },
      this.baseOptions.onOperation,
    );
  }

  async #operation<T>(
    operation: string,
    run: (report: { bytes?: number; records?: number }) => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    const report: { bytes?: number; records?: number } = {};
    try {
      this.#assertOpen();
      const value = await run(report);
      this.#report({
        operation,
        durationMs: performance.now() - started,
        outcome: "ok",
        ...report,
      });
      return value;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.#report({
        operation,
        durationMs: performance.now() - started,
        outcome:
          error instanceof WorkflowCheckpointConflictError
            ? "conflict"
            : "error",
        ...report,
        ...(typeof code === "string" ? { errorCode: code } : {}),
      });
      throw error;
    }
  }

  async #read(locator: WorkflowCheckpointLocator): Promise<
    | {
        value: StoredWorkflowCheckpoint;
        bytes: number;
      }
    | undefined
  > {
    const checkpointKey = workflowCheckpointKey(
      locator.workflowId,
      locator.executionId,
    );
    const raw = await this.#attempt(() => this.readCheckpoint(locator));
    if (raw === undefined) return undefined;
    if (
      !raw ||
      !isWorkflowCheckpointV1(raw.checkpoint) ||
      typeof raw.revision !== "string" ||
      typeof raw.updatedAt !== "number" ||
      raw.checkpoint.workflowId !== locator.workflowId ||
      raw.checkpoint.executionId !== locator.executionId
    ) {
      throw corruptCheckpoint(
        this.providerName,
        "checkpoint_schema_invalid",
        "The stored value is not a valid checkpoint for this execution",
      );
    }
    const durable = toDurableWorkflowCheckpoint(raw.checkpoint);
    assertWorkflowCheckpointSize(
      durable,
      checkpointKey,
      this.#maxBytes(),
      "load",
    );
    if (
      !(await workflowCheckpointRevisionMatches(raw.checkpoint, raw.revision))
    ) {
      throw corruptCheckpoint(
        this.providerName,
        "checkpoint_revision_invalid",
        "The stored value does not match its revision",
      );
    }
    const serialized = JSON.stringify(durable);
    return {
      value: {
        checkpoint: durable,
        revision: await workflowCheckpointRevision(durable),
        updatedAt: raw.updatedAt,
      },
      bytes: new TextEncoder().encode(serialized).byteLength,
    };
  }

  #maxBytes(): number {
    return Math.min(
      this.baseOptions.maxCheckpointBytes ??
        DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
      this.capabilities.maxCheckpointBytes,
    );
  }

  async #write(
    input: FencedSaveWorkflowCheckpointInput | PutWorkflowCheckpointInput,
  ): Promise<{
    checkpointKey: string;
    checkpoint: WorkflowCheckpointV1;
    revision: WorkflowCheckpointRevision;
    updatedAt: number;
    bytes: number;
  }> {
    if (!isWorkflowCheckpointV1(input.checkpoint)) {
      throw checkpointError(
        "checkpoint_schema_invalid",
        workflowCheckpointKey("invalid", "invalid"),
        "Cannot persist an invalid workflow checkpoint",
      );
    }
    const checkpoint = toDurableWorkflowCheckpoint(input.checkpoint);
    const checkpointKey = workflowCheckpointKey(
      checkpoint.workflowId,
      checkpoint.executionId,
    );
    assertWorkflowCheckpointSize(
      checkpoint,
      checkpointKey,
      this.#maxBytes(),
      "save",
    );
    const revision = await workflowCheckpointRevision(checkpoint);
    if (input.revision !== undefined && input.revision !== revision) {
      throw checkpointError(
        "checkpoint_revision_invalid",
        checkpointKey,
        `Workflow checkpoint revision does not match checkpoint: ${checkpointKey}`,
        { suppliedRevision: input.revision, computedRevision: revision },
      );
    }
    if (input.fencingToken !== undefined) {
      if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
        throw invalidOption("fencingToken", "must be a positive safe integer");
      }
      this.#require("leases", "save with a fencing token");
    }
    const serialized = JSON.stringify(checkpoint);
    const request: WorkflowCheckpointWriteRequest = {
      workflowId: checkpoint.workflowId,
      executionId: checkpoint.executionId,
      checkpointKey,
      checkpoint,
      serialized,
      bytes: new TextEncoder().encode(serialized).byteLength,
      revision,
      expectedRevision: input.expectedRevision,
      ...(input.fencingToken === undefined
        ? {}
        : { fencingToken: input.fencingToken }),
    };
    const updatedAt = await this.#attempt(async () => {
      try {
        return await this.writeCheckpoint(request);
      } catch (error) {
        // A write that was applied but not acknowledged conflicts with
        // itself on the retry: when the stored revision is the one being
        // written, the save has already happened.
        if (
          error instanceof WorkflowCheckpointConflictError &&
          error.conflict.actualRevision === revision
        ) {
          const current = await this.readCheckpoint(request);
          if (current?.revision === revision) return current.updatedAt;
        }
        throw error;
      }
    });
    return {
      checkpointKey,
      checkpoint,
      revision,
      updatedAt,
      bytes: request.bytes,
    };
  }

  /**
   * Reads the stored value of one checkpoint.
   *
   * @param locator - Workflow id and execution id.
   * @returns The stored checkpoint, or `undefined` when none exists. The base
   * class validates the schema, the size and the revision of what is
   * returned.
   */
  protected abstract readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined>;

  /**
   * Compares the stored revision and the fencing token, then writes, as one
   * storage transaction.
   *
   * @param request - The validated write.
   * @returns Epoch milliseconds recorded as the save time.
   * @throws `WorkflowCheckpointConflictError` when `expectedRevision` does
   * not match the stored revision.
   */
  protected abstract writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number>;

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.list}.
   *
   * @param input - Validated filters with a concrete `limit`.
   * @returns A page and the cursor of the next one.
   */
  protected listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    void input;
    return Promise.reject(
      unsupportedOperation(this.providerName, "listCheckpoints"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.delete}.
   *
   * @param input - Locator and optional expected revision.
   * @returns `true` when a checkpoint was deleted.
   */
  protected deleteCheckpoint(
    input: DeleteWorkflowCheckpointInput,
  ): Promise<boolean> {
    void input;
    return Promise.reject(
      unsupportedOperation(this.providerName, "deleteCheckpoint"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.prune}.
   *
   * @param input - Validated input with concrete `statuses` and `limit`.
   * @returns How many were deleted and whether more remain.
   */
  protected pruneCheckpoints(
    input: Required<
      Pick<
        PruneWorkflowCheckpointsInput,
        "updatedBefore" | "statuses" | "limit"
      >
    > &
      Pick<PruneWorkflowCheckpointsInput, "workflowId">,
  ): Promise<PruneWorkflowCheckpointsResult> {
    void input;
    return Promise.reject(
      unsupportedOperation(this.providerName, "pruneCheckpoints"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.acquireLease}.
   *
   * @param input - Validated input.
   * @param now - Epoch milliseconds to judge expiry with.
   * @returns The granted lease.
   */
  protected acquireCheckpointLease(
    input: AcquireWorkflowCheckpointLeaseInput,
    now: number,
  ): Promise<WorkflowCheckpointLease> {
    void input;
    void now;
    return Promise.reject(
      unsupportedOperation(this.providerName, "acquireCheckpointLease"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.renewLease}.
   *
   * @param lease - The lease to extend.
   * @param expiresAt - New expiry, in epoch milliseconds.
   * @returns The lease with its new expiry.
   */
  protected renewCheckpointLease(
    lease: WorkflowCheckpointLease,
    expiresAt: number,
  ): Promise<WorkflowCheckpointLease> {
    void lease;
    void expiresAt;
    return Promise.reject(
      unsupportedOperation(this.providerName, "renewCheckpointLease"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.releaseLease}.
   *
   * @param lease - The lease to release.
   */
  protected releaseCheckpointLease(
    lease: WorkflowCheckpointLease,
  ): Promise<void> {
    void lease;
    return Promise.reject(
      unsupportedOperation(this.providerName, "releaseCheckpointLease"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowCheckpointStore.healthCheck}: a
   * cheap read and write probe that throws on failure. The default does not
   * touch storage, so a provider with a backend should override it.
   *
   * @returns The schema version found in storage, when the provider keeps
   * one.
   */
  protected checkHealth(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }

  /** Storage primitive of {@link BaseWorkflowCheckpointStore.close}. */
  protected closeStore(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Tells whether a store implements the provider contract, not only `load`
 * and `save`.
 *
 * @param store - Any checkpoint store.
 * @returns `true` when `store` extends {@link BaseWorkflowCheckpointStore}.
 *
 * @experimental
 */
export function isWorkflowCheckpointProvider(
  store: WorkflowCheckpointStore,
): store is BaseWorkflowCheckpointStore {
  return store instanceof BaseWorkflowCheckpointStore;
}

function unsupportedOperation(
  provider: string,
  operation: string,
): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNSUPPORTED",
    `The ${provider} checkpoint provider does not implement ${operation}`,
    { details: { provider, operation } },
  );
}

function invalidOption(
  name: string,
  requirement: string,
): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_INVALID_OPTION",
    `${name} ${requirement}`,
    { details: { option: name } },
  );
}

function optionalPositiveInteger(
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined) positiveInteger(name, value);
}

function positiveInteger(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidOption(name, "must be a positive safe integer");
  }
}

function optionalNonNegativeNumber(
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined && !(Number.isFinite(value) && value >= 0)) {
    throw invalidOption(name, "must be a non-negative number");
  }
}

function finiteTime(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidOption(name, "must be a finite number of epoch milliseconds");
  }
}

function nonEmptyString(name: string, value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidOption(name, "must be a non-empty string");
  }
}

function status(name: string, value: unknown): void {
  if (
    value !== "running" &&
    value !== "completed" &&
    value !== "failed" &&
    value !== "cancelled"
  ) {
    throw invalidOption(name, "must be a checkpoint status");
  }
}

function validateLease(lease: WorkflowCheckpointLease): void {
  workflowCheckpointKey(lease.workflowId, lease.executionId);
  nonEmptyString("ownerId", lease.ownerId);
  positiveInteger("fencingToken", lease.fencingToken);
}

function checkpointError(
  reason: "checkpoint_schema_invalid" | "checkpoint_revision_invalid",
  checkpointKey: string,
  message: string,
  details: Record<string, unknown> = {},
): WorkflowError {
  return new WorkflowError("WORKFLOW_EXECUTION_ERROR", message, {
    reason,
    checkpointKey,
    ...details,
  });
}

function corruptCheckpoint(
  provider: string,
  reason: "checkpoint_schema_invalid" | "checkpoint_revision_invalid",
  message: string,
): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_CORRUPT",
    `The ${provider} checkpoint provider holds a corrupt value: ${message}`,
    { details: { provider, reason } },
  );
}
