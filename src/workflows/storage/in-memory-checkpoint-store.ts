import type { WorkflowCheckpointStatus } from "../checkpoint/schema.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointLocator,
  workflowCheckpointKey,
} from "../checkpoint/store.js";
import {
  type AcquireWorkflowCheckpointLeaseInput,
  BaseWorkflowCheckpointStore,
  type BaseWorkflowCheckpointStoreOptions,
  type DeleteWorkflowCheckpointInput,
  type ListWorkflowCheckpointsInput,
  type ListWorkflowCheckpointsResult,
  type PruneWorkflowCheckpointsInput,
  type PruneWorkflowCheckpointsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointLease,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointSummary,
  type WorkflowCheckpointWriteRequest,
} from "./checkpoint-store.js";
import { WorkflowStorageError } from "./errors.js";

const DEFAULT_MAX_CHECKPOINTS = 10_000;
const MAX_CURSOR_LENGTH = 8192;

interface Entry {
  workflowId: string;
  executionId: string;
  serialized: string;
  bytes: number;
  revision: string;
  status: WorkflowCheckpointStatus;
  updatedAt: number;
}

interface LeaseRecord {
  ownerId: string | undefined;
  fencingToken: number;
  expiresAt: number;
}

/**
 * Options of {@link InMemoryWorkflowCheckpointStore}.
 *
 * @experimental
 */
export interface InMemoryWorkflowCheckpointStoreOptions
  extends BaseWorkflowCheckpointStoreOptions {
  /**
   * Largest number of checkpoints kept. A save that would exceed it rejects
   * with `WORKFLOW_STORAGE_UNAVAILABLE` (not retryable); nothing is evicted.
   *
   * @defaultValue 10000
   */
  maxCheckpoints?: number;
  /**
   * Clock used for `updatedAt` and lease expiry, in epoch milliseconds.
   *
   * @defaultValue `Date.now`
   */
  now?: () => number;
}

/**
 * Reference checkpoint provider that keeps everything in the memory of one
 * process: the default for tests, in the role of ADK's
 * `InMemorySessionService`. URI: `memory://`.
 *
 * @remarks
 * It implements the whole contract (compare-and-set, leases, listing,
 * pruning) with `durable: false` and `multiProcess: false`. Checkpoints are
 * stored as serialized JSON, so a caller cannot change a stored value by
 * mutating the object it saved or loaded.
 *
 * @experimental
 */
export class InMemoryWorkflowCheckpointStore extends BaseWorkflowCheckpointStore {
  /** Provider name: `memory`. */
  readonly providerName = "memory";
  /** Full contract, not durable, one process. */
  readonly capabilities: WorkflowCheckpointStoreCapabilities;

  readonly #entries = new Map<string, Entry>();
  readonly #leases = new Map<string, LeaseRecord>();
  readonly #maxCheckpoints: number;
  readonly #clock: () => number;

  /**
   * Creates an empty store.
   *
   * @param options - Capacity, clock and the shared provider options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for a capacity that is not a positive safe integer.
   */
  constructor(options: InMemoryWorkflowCheckpointStoreOptions = {}) {
    super(options);
    const maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    if (!Number.isSafeInteger(maxCheckpoints) || maxCheckpoints < 1) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        "maxCheckpoints must be a positive safe integer",
        { details: { option: "maxCheckpoints" } },
      );
    }
    this.#maxCheckpoints = maxCheckpoints;
    this.#clock = options.now ?? Date.now;
    this.capabilities = Object.freeze({
      compareAndSet: "atomic",
      leases: true,
      durable: false,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxCheckpointBytes:
        options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    });
  }

  protected override currentTime(): number {
    return this.#clock();
  }

  protected async readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    const entry = this.#entries.get(
      workflowCheckpointKey(locator.workflowId, locator.executionId),
    );
    if (!entry) return undefined;
    return {
      checkpoint: JSON.parse(entry.serialized),
      revision: entry.revision,
      updatedAt: entry.updatedAt,
    };
  }

  // Nothing here awaits, so the comparison and the write are one step: the
  // event loop cannot interleave another writer between them.
  protected async writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    const key = request.checkpointKey;
    if (request.fencingToken !== undefined) {
      const current = this.#leases.get(key)?.fencingToken ?? 0;
      if (request.fencingToken < current) {
        throw leaseLost(request.fencingToken, current);
      }
    }
    const existing = this.#entries.get(key);
    if (request.expectedRevision !== undefined) {
      const actual = existing?.revision ?? null;
      if (actual !== request.expectedRevision) {
        throw new WorkflowCheckpointConflictError(
          key,
          request.expectedRevision,
          actual,
        );
      }
    }
    if (!existing && this.#entries.size >= this.#maxCheckpoints) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNAVAILABLE",
        `The in-memory checkpoint store holds its limit of ${this.#maxCheckpoints} checkpoints`,
        { retryable: false, details: { maxCheckpoints: this.#maxCheckpoints } },
      );
    }
    const updatedAt = this.#clock();
    this.#entries.set(key, {
      workflowId: request.workflowId,
      executionId: request.executionId,
      serialized: request.serialized,
      bytes: request.bytes,
      revision: request.revision,
      status: request.checkpoint.status,
      updatedAt,
    });
    return updatedAt;
  }

  protected override async listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const matches = [...this.#entries.values()]
      .filter(
        (entry) =>
          (input.workflowId === undefined ||
            entry.workflowId === input.workflowId) &&
          (input.status === undefined || entry.status === input.status) &&
          (input.updatedBefore === undefined ||
            entry.updatedAt < input.updatedBefore) &&
          (after === undefined || compareEntries(entry, after) > 0),
      )
      .sort(compareEntries);
    const page = matches.slice(0, input.limit);
    const last = page[page.length - 1];
    const items: WorkflowCheckpointSummary[] = page.map((entry) => ({
      workflowId: entry.workflowId,
      executionId: entry.executionId,
      revision: entry.revision,
      status: entry.status,
      updatedAt: entry.updatedAt,
      bytes: entry.bytes,
    }));
    return matches.length > page.length && last
      ? { items, nextCursor: encodeCursor(last) }
      : { items };
  }

  protected override async deleteCheckpoint(
    input: DeleteWorkflowCheckpointInput,
  ): Promise<boolean> {
    const key = workflowCheckpointKey(input.workflowId, input.executionId);
    const existing = this.#entries.get(key);
    if (input.expectedRevision !== undefined) {
      const actual = existing?.revision ?? null;
      if (actual !== input.expectedRevision) {
        throw new WorkflowCheckpointConflictError(
          key,
          input.expectedRevision,
          actual,
        );
      }
    }
    this.#leases.delete(key);
    return this.#entries.delete(key);
  }

  protected override async pruneCheckpoints(
    input: Required<
      Pick<
        PruneWorkflowCheckpointsInput,
        "updatedBefore" | "statuses" | "limit"
      >
    > &
      Pick<PruneWorkflowCheckpointsInput, "workflowId">,
  ): Promise<PruneWorkflowCheckpointsResult> {
    const matches = [...this.#entries.entries()]
      .filter(
        ([, entry]) =>
          entry.updatedAt < input.updatedBefore &&
          input.statuses.includes(entry.status) &&
          (input.workflowId === undefined ||
            entry.workflowId === input.workflowId),
      )
      .sort(([, a], [, b]) => compareEntries(a, b));
    const doomed = matches.slice(0, input.limit);
    for (const [key] of doomed) {
      this.#entries.delete(key);
      this.#leases.delete(key);
    }
    return {
      deleted: doomed.length,
      hasMore: matches.length > doomed.length,
    };
  }

  protected override async acquireCheckpointLease(
    input: AcquireWorkflowCheckpointLeaseInput,
    now: number,
  ): Promise<WorkflowCheckpointLease> {
    const key = workflowCheckpointKey(input.workflowId, input.executionId);
    const current = this.#leases.get(key);
    if (
      current?.ownerId !== undefined &&
      current.ownerId !== input.ownerId &&
      now < current.expiresAt
    ) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_LEASE_HELD",
        "Another owner holds the lease of this execution",
        { details: { expiresAt: current.expiresAt } },
      );
    }
    const record: LeaseRecord = {
      ownerId: input.ownerId,
      fencingToken: (current?.fencingToken ?? 0) + 1,
      expiresAt: now + input.ttlMs,
    };
    this.#leases.set(key, record);
    return leaseOf(input, record);
  }

  protected override async renewCheckpointLease(
    lease: WorkflowCheckpointLease,
    expiresAt: number,
  ): Promise<WorkflowCheckpointLease> {
    const key = workflowCheckpointKey(lease.workflowId, lease.executionId);
    const current = this.#leases.get(key);
    if (
      !current ||
      current.ownerId !== lease.ownerId ||
      current.fencingToken !== lease.fencingToken
    ) {
      throw leaseLost(lease.fencingToken, current?.fencingToken ?? 0);
    }
    current.expiresAt = expiresAt;
    return leaseOf(lease, current);
  }

  protected override async releaseCheckpointLease(
    lease: WorkflowCheckpointLease,
  ): Promise<void> {
    const key = workflowCheckpointKey(lease.workflowId, lease.executionId);
    const current = this.#leases.get(key);
    if (
      current &&
      current.ownerId === lease.ownerId &&
      current.fencingToken === lease.fencingToken
    ) {
      // The token stays so the next lease still counts up.
      current.ownerId = undefined;
      current.expiresAt = 0;
    }
  }

  protected override async closeStore(): Promise<void> {
    this.#entries.clear();
    this.#leases.clear();
  }
}

function leaseOf(
  locator: WorkflowCheckpointLocator,
  record: LeaseRecord,
): WorkflowCheckpointLease {
  return {
    workflowId: locator.workflowId,
    executionId: locator.executionId,
    ownerId: record.ownerId ?? "",
    fencingToken: record.fencingToken,
    expiresAt: record.expiresAt,
  };
}

function leaseLost(given: number, current: number): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_LEASE_LOST",
    "The lease of this execution was replaced; the write was not applied",
    { details: { fencingToken: given, currentFencingToken: current } },
  );
}

function compareEntries(
  a: { workflowId: string; executionId: string },
  b: { workflowId: string; executionId: string },
): number {
  if (a.workflowId !== b.workflowId) {
    return a.workflowId < b.workflowId ? -1 : 1;
  }
  if (a.executionId !== b.executionId) {
    return a.executionId < b.executionId ? -1 : 1;
  }
  return 0;
}

function encodeCursor(entry: {
  workflowId: string;
  executionId: string;
}): string {
  return Buffer.from(
    JSON.stringify([entry.workflowId, entry.executionId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  workflowId: string;
  executionId: string;
} {
  const invalid = () =>
    new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_OPTION",
      "cursor is not a cursor this provider returned",
      { details: { option: "cursor" } },
    );
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { workflowId: parsed[0], executionId: parsed[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw invalid();
}
