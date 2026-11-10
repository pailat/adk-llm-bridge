import { randomUUID } from "node:crypto";
import type { WorkflowCheckpointV1 } from "../checkpoint/schema.js";
import {
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite,
  workflowCheckpointKey,
} from "../checkpoint/store.js";
import type {
  BaseWorkflowCheckpointStore,
  WorkflowCheckpointLease,
} from "./checkpoint-store.js";
import { isWorkflowStorageError, WorkflowStorageError } from "./errors.js";
import { requireWorkflowCheckpointCapability } from "./support.js";

/** Default lifetime of an execution lease, in milliseconds. */
export const DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS = 30_000;

/**
 * Options of {@link LeasedWorkflowCheckpointStore}.
 *
 * @experimental
 */
export interface LeasedWorkflowCheckpointStoreOptions {
  /** Provider that holds the checkpoints; `capabilities.leases` must be `true`. */
  store: BaseWorkflowCheckpointStore;
  /**
   * Opaque id of this worker.
   *
   * @defaultValue a random UUID per instance
   */
  ownerId?: string;
  /**
   * Lifetime of a lease, in milliseconds. The lease is renewed every third
   * of it while the execution is active.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS}
   */
  ttlMs?: number;
  /**
   * Called once when the lease of an execution is lost (a renewal failed or
   * a save was fenced). The host should stop the run.
   */
  onLeaseLost?: (lost: {
    workflowId: string;
    executionId: string;
    fencingToken: number;
  }) => void;
}

/**
 * Wraps a provider so that one worker at a time advances each execution:
 * inject the wrapper as `checkpointStore` on every worker.
 *
 * @remarks
 * The first `load` or `save` of an execution acquires its lease; when another
 * worker holds an unexpired lease the call rejects with
 * `WORKFLOW_STORAGE_LEASE_HELD` and the run fails before any step starts.
 * Every save carries the fencing token, so a worker that lost its lease (a
 * pause longer than the lifetime, then a takeover) cannot overwrite the
 * checkpoint of the new owner: its save rejects with
 * `WORKFLOW_STORAGE_LEASE_LOST`. The lease is renewed on an unreferenced
 * timer and released when a checkpoint with status `completed` or `failed`
 * (or `cancelled`) is saved, or on {@link LeasedWorkflowCheckpointStore.close}.
 * A waiting run releases its lease too, so another worker can answer it. A
 * `load` that returns a finished, failed, cancelled or waiting checkpoint
 * releases the lease at once, because no save follows it. A lease that was
 * loaded but never saved is released after ten lifetimes.
 *
 * The constructor refuses a provider that does not declare
 * `compareAndSet: "atomic"` (through `requireWorkflowCheckpointCapability`)
 * or that has `leases: false`, so an advisory provider is never used where
 * only one writer may advance an execution.
 *
 * The runtime needs no change: it sees a `WorkflowCheckpointStore`.
 *
 * @experimental
 */
export class LeasedWorkflowCheckpointStore implements WorkflowCheckpointStore {
  /** The wrapped provider. */
  readonly store: BaseWorkflowCheckpointStore;
  /** Id this worker acquires leases with. */
  readonly ownerId: string;

  readonly #ttlMs: number;
  readonly #onLeaseLost: LeasedWorkflowCheckpointStoreOptions["onLeaseLost"];
  readonly #held = new Map<string, HeldLease>();
  readonly #acquiring = new Map<string, Promise<HeldLease>>();
  #closed = false;

  /**
   * Wraps a provider.
   *
   * @param options - The provider, the owner id and the lease lifetime.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_UNSUPPORTED`
   * when the provider has `capabilities.leases` `false`, or
   * `WORKFLOW_STORAGE_INVALID_OPTION` for a bad `ttlMs` or `ownerId`.
   */
  constructor(options: LeasedWorkflowCheckpointStoreOptions) {
    requireWorkflowCheckpointCapability(options.store, "compareAndSet");
    if (!options.store.capabilities.leases) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNSUPPORTED",
        `The ${options.store.providerName} checkpoint provider does not implement leases`,
        {
          capability: "leases",
          details: {
            provider: options.store.providerName,
            capability: "leases",
          },
        },
      );
    }
    const ttlMs = options.ttlMs ?? DEFAULT_WORKFLOW_CHECKPOINT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw invalidOption("ttlMs", "must be a positive safe integer");
    }
    const ownerId = options.ownerId ?? randomUUID();
    if (typeof ownerId !== "string" || ownerId.trim() === "") {
      throw invalidOption("ownerId", "must be a non-empty string");
    }
    this.store = options.store;
    this.ownerId = ownerId;
    this.#ttlMs = ttlMs;
    this.#onLeaseLost = options.onLeaseLost;
  }

  /**
   * Acquires the lease of the execution when this worker does not hold it,
   * then loads the checkpoint.
   *
   * @param input - Workflow id, execution id and invocation context.
   * @returns The checkpoint, or `undefined` when none exists.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_LEASE_HELD`
   * when another worker holds the lease.
   */
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    this.#assertOpen();
    const held = await this.#lease(input.workflowId, input.executionId);
    held.touchedAt = Date.now();
    const loaded = await this.store.load(input);
    // A check-only load of a finished or waiting run is not followed by a
    // save, so the lease is not kept; a later save acquires it again.
    if (loaded && givesUpExecution(loaded)) await this.#release(held);
    return loaded;
  }

  /**
   * Saves a checkpoint with the fencing token of the held lease.
   *
   * @param input - Checkpoint plus optional revision preconditions.
   * @returns The key and the `stateDelta` to attach to an ADK event.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_LEASE_LOST`
   * when a newer lease replaced the one this worker holds.
   * @throws `WorkflowCheckpointConflictError` when `expectedRevision` does
   * not match the stored revision.
   */
  async save(
    input: SaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    this.#assertOpen();
    const { workflowId, executionId } = input.checkpoint;
    const held = await this.#lease(workflowId, executionId);
    held.saved = true;
    let write: WorkflowCheckpointWrite;
    try {
      write = await this.store.save({
        ...input,
        fencingToken: held.lease.fencingToken,
      });
    } catch (error) {
      if (isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST")) {
        this.#lose(held);
      }
      throw error;
    }
    if (givesUpExecution(input.checkpoint)) await this.#release(held);
    return write;
  }

  /**
   * Stops the renewal timers and releases every lease this worker holds.
   * The wrapped provider stays open.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const held = [...this.#held.values()];
    await Promise.all(held.map((entry) => this.#release(entry)));
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_CLOSED",
        "The leased checkpoint store is closed",
      );
    }
  }

  async #lease(workflowId: string, executionId: string): Promise<HeldLease> {
    const key = workflowCheckpointKey(workflowId, executionId);
    const held = this.#held.get(key);
    if (held) return held;
    const pending = this.#acquiring.get(key);
    if (pending) return await pending;
    const acquisition = this.#acquire(key, workflowId, executionId);
    this.#acquiring.set(key, acquisition);
    try {
      return await acquisition;
    } finally {
      this.#acquiring.delete(key);
    }
  }

  async #acquire(
    key: string,
    workflowId: string,
    executionId: string,
  ): Promise<HeldLease> {
    const lease = await this.store.acquireLease({
      workflowId,
      executionId,
      ownerId: this.ownerId,
      ttlMs: this.#ttlMs,
    });
    const held: HeldLease = {
      key,
      lease,
      timer: undefined,
      renewing: false,
      released: false,
      saved: false,
      touchedAt: Date.now(),
    };
    if (this.#closed) {
      await this.store.releaseLease(lease).catch(() => undefined);
      this.#assertOpen();
    }
    held.timer = setInterval(
      () => void this.#renew(held),
      Math.max(1, Math.floor(this.#ttlMs / 3)),
    );
    held.timer.unref();
    this.#held.set(key, held);
    return held;
  }

  async #renew(held: HeldLease): Promise<void> {
    if (held.renewing || held.released) return;
    if (
      !held.saved &&
      Date.now() - held.touchedAt > this.#ttlMs * IDLE_LEASE_TTL_MULTIPLE
    ) {
      // Loaded but never saved for a long time: the run did not start.
      await this.#release(held);
      return;
    }
    held.renewing = true;
    try {
      held.lease = await this.store.renewLease(held.lease, this.#ttlMs);
    } catch (error) {
      // A transient failure is retried on the next tick; only a replaced
      // lease is a loss.
      if (isWorkflowStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST")) {
        this.#lose(held);
      }
    } finally {
      held.renewing = false;
    }
  }

  #lose(held: HeldLease): void {
    if (held.released) return;
    this.#forget(held);
    try {
      this.#onLeaseLost?.({
        workflowId: held.lease.workflowId,
        executionId: held.lease.executionId,
        fencingToken: held.lease.fencingToken,
      });
    } catch {
      // The host callback never breaks the store.
    }
  }

  #forget(held: HeldLease): void {
    held.released = true;
    if (held.timer) clearInterval(held.timer);
    if (this.#held.get(held.key) === held) this.#held.delete(held.key);
  }

  async #release(held: HeldLease): Promise<void> {
    if (held.released) return;
    this.#forget(held);
    try {
      await this.store.releaseLease(held.lease);
    } catch {
      // An unreleased lease only expires on its own.
    }
  }
}

interface HeldLease {
  key: string;
  lease: WorkflowCheckpointLease;
  timer: ReturnType<typeof setInterval> | undefined;
  renewing: boolean;
  released: boolean;
  /** Whether a save went through this lease. */
  saved: boolean;
  /** Last time a call used the lease, in epoch milliseconds. */
  touchedAt: number;
}

/** A lease that never saw a save is released after this many lifetimes. */
const IDLE_LEASE_TTL_MULTIPLE = 10;

/** A finished, failed, cancelled or waiting run no longer needs the lease. */
function givesUpExecution(checkpoint: WorkflowCheckpointV1): boolean {
  return (
    checkpoint.status !== "running" ||
    Object.values(checkpoint.steps).some((step) => step.status === "waiting")
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
