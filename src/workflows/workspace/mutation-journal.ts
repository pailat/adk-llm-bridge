import { isWorkflowIdentifier } from "../internal/identifiers.js";
import {
  canonicalJson,
  snapshotJson,
  type WorkflowResourceJsonValue,
} from "../resources/json.js";
import type { WorkspaceDescriptor } from "../resources/workspace-provisioner.js";
import type { WorkflowChangeOperationOptions } from "./change-driver.js";

/** Kind of host-side repository mutation that is journaled. */
export type WorkflowHostMutationKind = "commit" | "integration";
/** Lifecycle of a journaled mutation; `ambiguous` means the outcome is unknown. */
export type WorkflowHostMutationStatus = "pending" | "completed" | "ambiguous";

/** What the host is about to do, recorded before the mutation starts. */
export interface WorkflowHostMutationIntent {
  /** Safe identity of the operation; the idempotency key. */
  operationId: string;
  /** Lowercase `sha256:` digest of the intended mutation. */
  intentDigest: string;
  /** Kind of mutation. */
  kind: WorkflowHostMutationKind;
  /** Workflow execution that issued the mutation. */
  executionId: string;
  /** Task that issued the mutation. */
  taskId: string;
  /** Start time in epoch milliseconds. */
  startedAt: number;
}

/** Stored state of one journaled mutation. */
export interface WorkflowHostMutationRecord extends WorkflowHostMutationIntent {
  /** Compare-and-set revision, starting at 1 and incremented on each change. */
  revision: number;
  /** Current lifecycle status. */
  status: WorkflowHostMutationStatus;
  /** Last update time in epoch milliseconds. */
  updatedAt: number;
  /** JSON result recorded by `complete`. */
  result?: WorkflowResourceJsonValue;
  /** Reason recorded by `markAmbiguous`. */
  ambiguity?: string;
  /** Set atomically when the host mutation driver first crosses its boundary. */
  hostStartedAt?: number;
}

/** Result of beginning a journaled mutation. */
export interface WorkflowHostMutationBeginResult {
  /** The current record for the operation. */
  record: WorkflowHostMutationRecord;
  /** `true` when this call created the record or crossed the host boundary. */
  created: boolean;
}

/** Durable implementations provide idempotency by operationId + intentDigest. */
export interface WorkflowHostMutationJournal {
  /**
   * Records an intent, or returns the existing record for the same operation.
   *
   * @param intent - Intent to record.
   * @returns The record and whether it was created.
   * @throws {@link WorkflowHostMutationConflictError} when `operationId` was
   * reused with a different `intentDigest`.
   */
  begin(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult>;
  /**
   * Marks that the host driver is about to cross its mutation boundary.
   *
   * @remarks
   * Only the first call per operation returns `created: true`; a record with
   * `hostStartedAt` set after a crash means the mutation may have happened.
   *
   * @param intent - Intent to record and mark started.
   * @returns The record and whether this call set `hostStartedAt`.
   * @throws {@link WorkflowHostMutationConflictError} on digest reuse.
   */
  beginHostMutation(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult>;
  /** Returns the record for an operation, or `undefined` when unknown. */
  get(operationId: string): Promise<WorkflowHostMutationRecord | undefined>;
  /**
   * Marks an operation completed with a JSON result.
   *
   * @param operationId - Operation to complete.
   * @param intentDigest - Digest the operation was begun with.
   * @param result - JSON-safe result to store.
   * @returns The completed record; repeating with an equal result is a no-op.
   * @throws {@link WorkflowHostMutationConflictError} when the operation is
   * unknown, the digest differs or a different result is already stored.
   */
  complete(
    operationId: string,
    intentDigest: string,
    result: WorkflowResourceJsonValue,
  ): Promise<WorkflowHostMutationRecord>;
  /**
   * Marks an operation whose outcome cannot be determined.
   *
   * @param operationId - Operation to mark.
   * @param intentDigest - Digest the operation was begun with.
   * @param reason - Non-empty explanation.
   * @returns The ambiguous record.
   * @throws {@link WorkflowHostMutationConflictError} when the operation is
   * unknown, the digest differs or it is already completed.
   */
  markAmbiguous(
    operationId: string,
    intentDigest: string,
    reason: string,
  ): Promise<WorkflowHostMutationRecord>;
  /** Lists an execution's records ordered by start time, then operation id. */
  list(executionId: string): Promise<readonly WorkflowHostMutationRecord[]>;
}

/**
 * Cross-instance repository critical section. Every host operation that can
 * checkout or move a publication target must participate in the same lock.
 */
export interface WorkflowRepositoryMutationLock {
  /**
   * Acquires the lock for one repository, waiting for other holders.
   *
   * @param repositoryId - Repository to lock.
   * @param options - Optional abort signal.
   * @returns A lease that must be released.
   */
  acquire(
    repositoryId: string,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowRepositoryMutationLease>;
}

/** Held repository lock. */
export interface WorkflowRepositoryMutationLease {
  /** Repository the lock covers. */
  readonly repositoryId: string;
  /** Releases the lock; resolves `true` once and `false` afterwards. */
  release(): Promise<boolean>;
}

/** Thrown by a mutation journal on digest reuse or an invalid state change. */
export class WorkflowHostMutationConflictError extends Error {
  /** Stable error code. */
  readonly code = "WORKFLOW_HOST_MUTATION_CONFLICT" as const;

  /** @param message - Description of the conflict. */
  constructor(message: string) {
    super(message);
    this.name = "WorkflowHostMutationConflictError";
  }
}

/** Single-process reference. Production hosts should persist the same CAS rules. */
export class InMemoryWorkflowHostMutationJournal
  implements WorkflowHostMutationJournal
{
  readonly #records = new Map<string, WorkflowHostMutationRecord>();

  /** {@inheritDoc WorkflowHostMutationJournal.begin} */
  async begin(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult> {
    return this.#begin(intent);
  }

  #begin(intent: WorkflowHostMutationIntent): WorkflowHostMutationBeginResult {
    const normalized = normalizeIntent(intent);
    const current = this.#records.get(normalized.operationId);
    if (current) {
      assertSameIntent(current, normalized.intentDigest);
      return Object.freeze({ record: current, created: false });
    }
    const record = freezeRecord({
      ...normalized,
      revision: 1,
      status: "pending",
      updatedAt: normalized.startedAt,
    });
    this.#records.set(record.operationId, record);
    return Object.freeze({ record, created: true });
  }

  /** {@inheritDoc WorkflowHostMutationJournal.beginHostMutation} */
  async beginHostMutation(
    intent: WorkflowHostMutationIntent,
  ): Promise<WorkflowHostMutationBeginResult> {
    const begun = this.#begin(intent);
    if (begun.record.hostStartedAt !== undefined) {
      return Object.freeze({ record: begun.record, created: false });
    }
    const record = freezeRecord({
      ...begun.record,
      revision: begun.record.revision + 1,
      hostStartedAt: begun.record.startedAt,
      updatedAt: nextTimestamp(begun.record.updatedAt),
    });
    this.#records.set(record.operationId, record);
    return Object.freeze({ record, created: true });
  }

  /** {@inheritDoc WorkflowHostMutationJournal.get} */
  async get(
    operationId: string,
  ): Promise<WorkflowHostMutationRecord | undefined> {
    return this.#records.get(requiredIdentity(operationId, "operationId"));
  }

  /** {@inheritDoc WorkflowHostMutationJournal.complete} */
  async complete(
    operationId: string,
    intentDigest: string,
    result: WorkflowResourceJsonValue,
  ): Promise<WorkflowHostMutationRecord> {
    const current = this.#required(operationId, intentDigest);
    const normalizedResult = snapshotJson(result, "mutation result");
    if (current.status === "completed") {
      if (
        canonicalJson(current.result ?? null) !==
        canonicalJson(normalizedResult)
      ) {
        throw conflict(operationId, "already has a different completed result");
      }
      return current;
    }
    const record = freezeRecord({
      ...current,
      revision: current.revision + 1,
      status: "completed",
      updatedAt: nextTimestamp(current.updatedAt),
      result: normalizedResult,
    });
    this.#records.set(operationId, record);
    return record;
  }

  /** {@inheritDoc WorkflowHostMutationJournal.markAmbiguous} */
  async markAmbiguous(
    operationId: string,
    intentDigest: string,
    reason: string,
  ): Promise<WorkflowHostMutationRecord> {
    const current = this.#required(operationId, intentDigest);
    const ambiguity = requiredNonEmptyString(reason, "ambiguity reason");
    if (current.status === "completed") {
      throw conflict(operationId, "is already completed");
    }
    if (current.status === "ambiguous" && current.ambiguity === ambiguity) {
      return current;
    }
    const record = freezeRecord({
      ...current,
      revision: current.revision + 1,
      status: "ambiguous",
      updatedAt: nextTimestamp(current.updatedAt),
      ambiguity,
    });
    this.#records.set(operationId, record);
    return record;
  }

  /** {@inheritDoc WorkflowHostMutationJournal.list} */
  async list(
    executionId: string,
  ): Promise<readonly WorkflowHostMutationRecord[]> {
    const id = requiredIdentity(executionId, "executionId");
    return Object.freeze(
      [...this.#records.values()]
        .filter((record) => record.executionId === id)
        .sort(
          (left, right) =>
            left.startedAt - right.startedAt ||
            left.operationId.localeCompare(right.operationId),
        ),
    );
  }

  #required(
    operationId: string,
    intentDigest: string,
  ): WorkflowHostMutationRecord {
    const id = requiredIdentity(operationId, "operationId");
    const current = this.#records.get(id);
    if (!current) throw conflict(id, "does not exist");
    assertSameIntent(current, requiredDigest(intentDigest));
    return current;
  }
}

/** Brand symbol identifying a {@link WorkflowWorkspaceAttachment}. */
export const WORKFLOW_WORKSPACE_ATTACHMENT = Symbol(
  "WorkflowWorkspaceAttachment",
);

/** Host-only attachment reconstructed from a durable JSON descriptor. */
export interface WorkflowWorkspaceAttachment<HostWorkspace = unknown> {
  /** Brand marker. */
  readonly [WORKFLOW_WORKSPACE_ATTACHMENT]: true;
  /** Durable descriptor the attachment was rebuilt from. */
  readonly descriptor: WorkspaceDescriptor;
  /** Host-specific workspace handle. */
  readonly host: HostWorkspace;
  /** Detaches without deleting; resolves `true` once and `false` afterwards. */
  detach(): Promise<boolean>;
}

/** Host port used after restart to attach to or recover a durable workspace. */
export interface WorkflowWorkspaceRecoveryPort<HostWorkspace = unknown> {
  /** Attaches to an existing workspace, or resolves `undefined` when it is gone. */
  attach(
    descriptor: WorkspaceDescriptor,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowWorkspaceAttachment<HostWorkspace> | undefined>;
  /** Attaches after repairing an interrupted workspace; rejects if it cannot. */
  recover(
    descriptor: WorkspaceDescriptor,
    options?: WorkflowChangeOperationOptions,
  ): Promise<WorkflowWorkspaceAttachment<HostWorkspace>>;
}

function normalizeIntent(
  input: WorkflowHostMutationIntent,
): WorkflowHostMutationIntent {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Mutation intent must be an object");
  }
  const keys = Object.keys(input).sort();
  if (
    keys.join(",") !==
    "executionId,intentDigest,kind,operationId,startedAt,taskId"
  ) {
    throw new TypeError("Mutation intent contains unknown properties");
  }
  if (input.kind !== "commit" && input.kind !== "integration") {
    throw new TypeError("Mutation intent kind is invalid");
  }
  return Object.freeze({
    operationId: requiredIdentity(input.operationId, "operationId"),
    intentDigest: requiredDigest(input.intentDigest),
    kind: input.kind,
    executionId: requiredIdentity(input.executionId, "executionId"),
    taskId: requiredIdentity(input.taskId, "taskId"),
    startedAt: requiredTimestamp(input.startedAt, "startedAt"),
  });
}

function freezeRecord(
  input: WorkflowHostMutationRecord,
): WorkflowHostMutationRecord {
  return Object.freeze(input);
}

function assertSameIntent(
  record: WorkflowHostMutationRecord,
  intentDigest: string,
): void {
  if (record.intentDigest !== intentDigest) {
    throw conflict(
      record.operationId,
      "was reused with a different intent digest",
    );
  }
}

function requiredIdentity(value: unknown, field: string): string {
  if (!isWorkflowIdentifier(value, "opaque")) {
    throw new TypeError(`${field} must be a safe identity`);
  }
  return value;
}

function requiredDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("intentDigest must be a lowercase SHA-256 digest");
  }
  return value;
}

function requiredNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function nextTimestamp(previous: number): number {
  return Math.max(previous + 1, Date.now());
}

function conflict(
  operationId: string,
  detail: string,
): WorkflowHostMutationConflictError {
  return new WorkflowHostMutationConflictError(
    `Mutation operation ${operationId} ${detail}`,
  );
}
