/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type WorkflowTaskClaim,
  type WorkflowTaskClaimedTransitionRequest,
  type WorkflowTaskClaimGuard,
  type WorkflowTaskClaimRequest,
  type WorkflowTaskCancelExpiredClaimRequest,
  type WorkflowTaskCancellationRequest,
  WorkflowTaskControlError,
  type WorkflowTaskListRequest,
  type WorkflowTaskListResult,
  type WorkflowTaskMessage,
  type WorkflowTaskMessageAppendRequest,
  type WorkflowTaskMessageReadRequest,
  type WorkflowTaskMessageReadResult,
  type WorkflowTaskRecord,
  type WorkflowTaskRenewClaimRequest,
  type WorkflowTaskRequeueExpiredRequest,
  type WorkflowTaskStatus,
} from "./contracts.js";
import { immutableTaskJson } from "./json.js";

export const DEFAULT_WORKFLOW_TASK_LIST_LIMIT = 50;
export const MAX_WORKFLOW_TASK_LIST_LIMIT = 500;
export const DEFAULT_WORKFLOW_TASK_MESSAGE_READ_LIMIT = 100;
export const MAX_WORKFLOW_TASK_MESSAGE_READ_LIMIT = 1_000;
export const DEFAULT_WORKFLOW_TASK_MAILBOX_CAPACITY = 10_000;
export const MAX_WORKFLOW_TASK_MAILBOX_CAPACITY = 100_000;

const TASK_STATUSES = new Set<WorkflowTaskStatus>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export interface WorkflowTaskStore {
  create(record: WorkflowTaskRecord): Promise<WorkflowTaskRecord>;
  get(
    executionId: string,
    taskId: string,
  ): Promise<WorkflowTaskRecord | undefined>;
  compareAndSet(
    record: WorkflowTaskRecord,
    expectedRevision: number,
  ): Promise<WorkflowTaskRecord>;
  list(request: WorkflowTaskListRequest): Promise<WorkflowTaskListResult>;
}

/**
 * Optional durable claim capability for distributed task workers.
 *
 * Implementations must make every operation atomic and monotonically increase
 * fencing tokens per task. Delivery is at-least-once: expiry permits a later
 * worker to repeat an attempt, so this interface never promises exactly-once
 * execution or effects.
 */
export interface WorkflowTaskClaimStore extends WorkflowTaskStore {
  claim(request: WorkflowTaskClaimRequest): Promise<WorkflowTaskRecord>;
  renewClaim(
    request: WorkflowTaskRenewClaimRequest,
  ): Promise<WorkflowTaskRecord>;
  compareAndSetClaimed(
    request: WorkflowTaskClaimedTransitionRequest,
  ): Promise<WorkflowTaskRecord>;
  /**
   * Persists remote cancellation intent without acquiring or changing the
   * active worker claim. Effects remain at-least-once and worker-fenced.
   */
  requestCancellation(
    request: WorkflowTaskCancellationRequest,
  ): Promise<WorkflowTaskRecord>;
  requeueExpired(
    request: WorkflowTaskRequeueExpiredRequest,
  ): Promise<WorkflowTaskRecord>;
  /**
   * Finalizes an expired cancelling attempt without granting its old worker
   * authority. This is an at-least-once recovery transition, not an
   * exactly-once guarantee for effects performed before cancellation.
   */
  cancelExpiredClaim(
    request: WorkflowTaskCancelExpiredClaimRequest,
  ): Promise<WorkflowTaskRecord>;
}

/** Optional long-poll capability; adapters may use ordinary polling instead. */
export interface WorkflowTaskRevisionWaitStore extends WorkflowTaskStore {
  waitForRevision(
    executionId: string,
    taskId: string,
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskRecord>;
}

export interface WorkflowTaskMessageStore {
  append(
    request: WorkflowTaskMessageAppendRequest & { sentAt: number },
  ): Promise<WorkflowTaskMessage>;
  read(
    request: WorkflowTaskMessageReadRequest,
  ): Promise<WorkflowTaskMessageReadResult>;
  wait(
    request: WorkflowTaskMessageReadRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskMessageReadResult>;
}

export interface InMemoryWorkflowTaskStoreConfig {
  now?: () => number;
}

/**
 * Single-process reference store with atomic durable-claim semantics.
 * It models at-least-once recovery and intentionally does not claim
 * distributed durability or exactly-once execution.
 */
export class InMemoryWorkflowTaskStore
  implements WorkflowTaskClaimStore, WorkflowTaskRevisionWaitStore
{
  readonly #records = new Map<string, WorkflowTaskRecord>();
  readonly #order: string[] = [];
  readonly #nextFencingTokens = new Map<string, number>();
  readonly #revisionWaiters = new Map<string, Set<TaskRevisionWaiter>>();
  readonly #now: () => number;

  constructor(config: InMemoryWorkflowTaskStoreConfig = {}) {
    this.#now = config.now ?? Date.now;
  }

  async create(record: WorkflowTaskRecord): Promise<WorkflowTaskRecord> {
    validateTaskRecord(record);
    if (record.revision !== 1) invalid("Initial task revision must be 1");
    const key = taskKey(record.executionId, record.taskId);
    if (this.#records.has(key)) duplicate(record.executionId, record.taskId);
    const snapshot = immutableTaskJson(record);
    this.#records.set(key, snapshot);
    this.#order.push(key);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async get(
    executionId: string,
    taskId: string,
  ): Promise<WorkflowTaskRecord | undefined> {
    validateTaskHandle({ executionId, taskId });
    return this.#records.get(taskKey(executionId, taskId));
  }

  async compareAndSet(
    record: WorkflowTaskRecord,
    expectedRevision: number,
  ): Promise<WorkflowTaskRecord> {
    validateTaskRecord(record);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      invalid("Expected task revision must be a positive integer");
    }
    const key = taskKey(record.executionId, record.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(record.executionId, record.taskId);
    if (current.revision !== expectedRevision) {
      conflict(
        record.executionId,
        record.taskId,
        expectedRevision,
        current.revision,
      );
    }
    if (record.revision !== expectedRevision + 1) {
      invalid("Replacement task revision must increment by one");
    }
    assertImmutableIdentity(current, record);
    if (current.claim !== undefined || record.claim !== undefined) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_CLAIM_CONFLICT",
        `Claimed workflow tasks require a fenced transition: ${record.taskId}`,
        {
          executionId: record.executionId,
          taskId: record.taskId,
          actualRevision: current.revision,
        },
      );
    }
    assertTransition(current, record);
    const snapshot = immutableTaskJson(record);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async claim(request: WorkflowTaskClaimRequest): Promise<WorkflowTaskRecord> {
    validateClaimRequest(request);
    const key = taskKey(request.executionId, request.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(request.executionId, request.taskId);
    if (
      request.expectedRevision !== undefined &&
      current.revision !== request.expectedRevision
    ) {
      conflict(
        request.executionId,
        request.taskId,
        request.expectedRevision,
        current.revision,
      );
    }
    if (current.status !== "queued" || current.claim !== undefined) {
      claimConflict(request, current);
    }
    const now = this.#timestamp();
    const fencingToken = this.#nextFencingTokens.get(key) ?? 1;
    this.#nextFencingTokens.set(key, fencingToken + 1);
    const snapshot = immutableTaskJson({
      ...current,
      status: "running",
      revision: current.revision + 1,
      updatedAt: now,
      startedAt: now,
      claim: {
        workerId: request.workerId,
        leaseId: request.leaseId,
        fencingToken,
        claimedAt: now,
        heartbeatAt: now,
        expiresAt: now + request.leaseDurationMs,
      },
    } satisfies WorkflowTaskRecord);
    validateTaskRecord(snapshot);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async renewClaim(
    request: WorkflowTaskRenewClaimRequest,
  ): Promise<WorkflowTaskRecord> {
    validateClaimGuard(request);
    validateExpectedRevision(request.expectedRevision);
    validateLeaseDuration(request.leaseDurationMs);
    const key = taskKey(request.executionId, request.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(request.executionId, request.taskId);
    assertExpectedRevision(current, request.expectedRevision);
    const now = this.#timestamp();
    assertCurrentClaim(current, request, now);
    const snapshot = immutableTaskJson({
      ...current,
      revision: current.revision + 1,
      updatedAt: now,
      claim: {
        ...current.claim,
        heartbeatAt: now,
        expiresAt: now + request.leaseDurationMs,
      },
    } satisfies WorkflowTaskRecord);
    validateTaskRecord(snapshot);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async compareAndSetClaimed(
    request: WorkflowTaskClaimedTransitionRequest,
  ): Promise<WorkflowTaskRecord> {
    validateClaimGuard(request.claim);
    validateExpectedRevision(request.expectedRevision);
    validateTaskRecord(request.record);
    const key = taskKey(request.record.executionId, request.record.taskId);
    if (
      request.claim.executionId !== request.record.executionId ||
      request.claim.taskId !== request.record.taskId
    ) {
      invalid("Workflow task claim guard belongs to another task");
    }
    const current = this.#records.get(key);
    if (!current) notFound(request.record.executionId, request.record.taskId);
    assertExpectedRevision(current, request.expectedRevision);
    assertCurrentClaim(current, request.claim, this.#timestamp());
    if (request.record.revision !== request.expectedRevision + 1) {
      invalid("Replacement task revision must increment by one");
    }
    assertImmutableIdentity(current, request.record);
    assertTransition(current, request.record);
    if (isTerminalTaskStatus(request.record.status)) {
      if (request.record.claim !== undefined) {
        invalid("Terminal workflow tasks cannot retain a durable claim");
      }
    } else {
      assertClaimUnchanged(current.claim, request.record.claim);
    }
    const snapshot = immutableTaskJson(request.record);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async requestCancellation(
    request: WorkflowTaskCancellationRequest,
  ): Promise<WorkflowTaskRecord> {
    validateTaskHandle(request);
    validateExpectedRevision(request.expectedRevision);
    const key = taskKey(request.executionId, request.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(request.executionId, request.taskId);
    assertExpectedRevision(current, request.expectedRevision);
    if (current.status === "cancelling" && current.claim !== undefined) {
      return current;
    }
    if (current.status !== "running" || current.claim === undefined) {
      claimConflict(request, current);
    }
    const now = this.#timestamp();
    const snapshot = immutableTaskJson({
      ...current,
      status: "cancelling",
      revision: current.revision + 1,
      updatedAt: now,
      cancelRequestedAt: now,
    } satisfies WorkflowTaskRecord);
    validateTaskRecord(snapshot);
    assertClaimUnchanged(current.claim, snapshot.claim);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async requeueExpired(
    request: WorkflowTaskRequeueExpiredRequest,
  ): Promise<WorkflowTaskRecord> {
    validateTaskHandle(request);
    validateExpectedRevision(request.expectedRevision);
    const key = taskKey(request.executionId, request.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(request.executionId, request.taskId);
    assertExpectedRevision(current, request.expectedRevision);
    const now = this.#timestamp();
    if (current.status !== "running" || current.claim === undefined) {
      claimConflict(request, current);
    }
    if (current.claim.expiresAt > now) {
      leaseNotExpired(request, current.claim);
    }
    const {
      claim: _claim,
      startedAt: _startedAt,
      cancelRequestedAt: _cancelRequestedAt,
      ...durable
    } = current;
    const snapshot = immutableTaskJson({
      ...durable,
      status: "queued",
      revision: current.revision + 1,
      attempt: current.attempt + 1,
      updatedAt: now,
    } satisfies WorkflowTaskRecord);
    validateTaskRecord(snapshot);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async cancelExpiredClaim(
    request: WorkflowTaskCancelExpiredClaimRequest,
  ): Promise<WorkflowTaskRecord> {
    validateTaskHandle(request);
    validateExpectedRevision(request.expectedRevision);
    const key = taskKey(request.executionId, request.taskId);
    const current = this.#records.get(key);
    if (!current) notFound(request.executionId, request.taskId);
    assertExpectedRevision(current, request.expectedRevision);
    const now = this.#timestamp();
    if (current.status !== "cancelling" || current.claim === undefined) {
      claimConflict(request, current);
    }
    if (current.claim.expiresAt > now) {
      leaseNotExpired(request, current.claim);
    }
    const { claim: _claim, ...durable } = current;
    const snapshot = immutableTaskJson({
      ...durable,
      status: "cancelled",
      revision: current.revision + 1,
      updatedAt: now,
      completedAt: now,
      error: {
        code: "WORKFLOW_TASK_CANCELLED",
        message: "Workflow task was cancelled",
      },
    } satisfies WorkflowTaskRecord);
    validateTaskRecord(snapshot);
    this.#records.set(key, snapshot);
    this.#wakeRevisionWaiters(key, snapshot);
    return snapshot;
  }

  async waitForRevision(
    executionId: string,
    taskId: string,
    afterRevision: number,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskRecord> {
    validateTaskHandle({ executionId, taskId });
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      invalid("Workflow task wait revision must be a non-negative integer");
    }
    const key = taskKey(executionId, taskId);
    const current = this.#records.get(key);
    if (!current) notFound(executionId, taskId);
    if (current.revision > afterRevision) return current;
    if (signal?.aborted) taskWaitAborted(executionId, taskId);
    return await new Promise<WorkflowTaskRecord>((resolve, reject) => {
      const waiters = this.#revisionWaiters.get(key) ?? new Set();
      const waiter: TaskRevisionWaiter = {
        afterRevision,
        resolve,
        reject,
        signal,
        onAbort: () => {
          this.#settleRevisionWaiter(key, waiter);
          reject(taskWaitAbortedError(executionId, taskId));
        },
      };
      if (!this.#revisionWaiters.has(key)) {
        this.#revisionWaiters.set(key, waiters);
      }
      waiters.add(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });

      const afterRegistration = this.#records.get(key);
      if (afterRegistration && afterRegistration.revision > afterRevision) {
        this.#settleRevisionWaiter(key, waiter);
        resolve(afterRegistration);
      }
    });
  }

  #timestamp(): number {
    const timestamp = this.#now();
    if (!validTimestamp(timestamp)) {
      invalid("Workflow task store clock returned an invalid timestamp");
    }
    return timestamp;
  }

  #wakeRevisionWaiters(key: string, record: WorkflowTaskRecord): void {
    const waiters = this.#revisionWaiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (record.revision <= waiter.afterRevision) continue;
      this.#settleRevisionWaiter(key, waiter);
      waiter.resolve(record);
    }
  }

  #settleRevisionWaiter(key: string, waiter: TaskRevisionWaiter): void {
    const waiters = this.#revisionWaiters.get(key);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.#revisionWaiters.delete(key);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }

  async list(
    request: WorkflowTaskListRequest,
  ): Promise<WorkflowTaskListResult> {
    validateTaskListRequest(request);
    const limit = boundedLimit(
      request.limit,
      DEFAULT_WORKFLOW_TASK_LIST_LIMIT,
      MAX_WORKFLOW_TASK_LIST_LIMIT,
      "task list",
    );
    const offset = decodeTaskListCursor(
      request.cursor,
      request,
      this.#order.length,
    );
    const records: WorkflowTaskRecord[] = [];
    let index = offset;
    for (; index < this.#order.length && records.length < limit; index++) {
      const record = this.#records.get(this.#order[index] as string);
      if (record && matchesTaskList(record, request)) records.push(record);
    }
    const hasMore = this.#order.slice(index).some((key) => {
      const record = this.#records.get(key);
      return Boolean(record && matchesTaskList(record, request));
    });
    return Object.freeze({
      records: Object.freeze(records),
      ...(hasMore ? { nextCursor: encodeTaskListCursor(request, index) } : {}),
    });
  }
}

export interface InMemoryWorkflowTaskMessageStoreConfig {
  capacity?: number;
}

/** Bounded single-process mailbox; provider push delivery remains host-owned. */
export class InMemoryWorkflowTaskMessageStore
  implements WorkflowTaskMessageStore
{
  readonly #streams = new Map<string, WorkflowTaskMessage[]>();
  readonly #waiters = new Map<string, Set<MailboxWaiter>>();
  readonly #capacity: number;

  constructor(config: InMemoryWorkflowTaskMessageStoreConfig = {}) {
    this.#capacity = boundedLimit(
      config.capacity,
      DEFAULT_WORKFLOW_TASK_MAILBOX_CAPACITY,
      MAX_WORKFLOW_TASK_MAILBOX_CAPACITY,
      "mailbox capacity",
    );
  }

  async append(
    request: WorkflowTaskMessageAppendRequest & { sentAt: number },
  ): Promise<WorkflowTaskMessage> {
    validateMessageAppend(request);
    const key = taskKey(request.executionId, request.taskId);
    const stream = this.#streams.get(key) ?? [];
    if (stream.length >= this.#capacity) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_MAILBOX_FULL",
        `Workflow task mailbox reached its capacity: ${request.taskId}`,
        {
          executionId: request.executionId,
          taskId: request.taskId,
          capacity: this.#capacity,
        },
      );
    }
    const record = immutableTaskJson({
      ...request,
      sequence: stream.length + 1,
    } satisfies WorkflowTaskMessage);
    if (!this.#streams.has(key)) this.#streams.set(key, stream);
    stream.push(record);
    this.#wake(key);
    return record;
  }

  async read(
    request: WorkflowTaskMessageReadRequest,
  ): Promise<WorkflowTaskMessageReadResult> {
    return this.#readSnapshot(request);
  }

  async wait(
    request: WorkflowTaskMessageReadRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskMessageReadResult> {
    const immediate = this.#readSnapshot(request);
    if (immediate.messages.length > 0) return immediate;
    if (signal?.aborted) waitAborted(request);
    const key = taskKey(request.executionId, request.taskId);
    return await new Promise<WorkflowTaskMessageReadResult>(
      (resolve, reject) => {
        const waiters = this.#waiters.get(key) ?? new Set<MailboxWaiter>();
        const waiter: MailboxWaiter = {
          request: immutableTaskJson(request),
          resolve,
          reject,
          signal,
          onAbort: () => {
            this.#settle(key, waiter);
            reject(waitAbortedError(request));
          },
        };
        if (!this.#waiters.has(key)) this.#waiters.set(key, waiters);
        waiters.add(waiter);
        signal?.addEventListener("abort", waiter.onAbort, { once: true });

        // Registration and this second snapshot are synchronous, closing the
        // read/register window for stores that later add asynchronous adapters.
        const afterRegistration = this.#readSnapshot(request);
        if (afterRegistration.messages.length > 0) {
          this.#settle(key, waiter);
          resolve(afterRegistration);
        }
      },
    );
  }

  #readSnapshot(
    request: WorkflowTaskMessageReadRequest,
  ): WorkflowTaskMessageReadResult {
    validateMessageRead(request);
    const limit = boundedLimit(
      request.limit,
      DEFAULT_WORKFLOW_TASK_MESSAGE_READ_LIMIT,
      MAX_WORKFLOW_TASK_MESSAGE_READ_LIMIT,
      "mailbox read",
    );
    const afterSequence = request.cursor?.afterSequence ?? 0;
    const stream =
      this.#streams.get(taskKey(request.executionId, request.taskId)) ?? [];
    if (afterSequence > stream.length) {
      invalid("Workflow task message cursor is beyond the end of the mailbox");
    }
    const messages = stream.slice(afterSequence, afterSequence + limit);
    const lastSequence = messages.at(-1)?.sequence ?? afterSequence;
    return Object.freeze({
      messages: Object.freeze(messages),
      cursor: Object.freeze({
        executionId: request.executionId,
        taskId: request.taskId,
        afterSequence: lastSequence,
      }),
      hasMore: stream.length > lastSequence,
    });
  }

  #wake(key: string): void {
    const waiters = this.#waiters.get(key);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      const result = this.#readSnapshot(waiter.request);
      if (result.messages.length === 0) continue;
      this.#settle(key, waiter);
      waiter.resolve(result);
    }
  }

  #settle(key: string, waiter: MailboxWaiter): void {
    const waiters = this.#waiters.get(key);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.#waiters.delete(key);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  }
}

interface MailboxWaiter {
  request: WorkflowTaskMessageReadRequest;
  resolve(result: WorkflowTaskMessageReadResult): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
}

interface TaskRevisionWaiter {
  afterRevision: number;
  resolve(record: WorkflowTaskRecord): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort(): void;
}

export function validateTaskHandle(handle: {
  executionId: string;
  taskId: string;
}): void {
  if (!handle || typeof handle !== "object" || Array.isArray(handle)) {
    invalid("Workflow task handle must be an object");
  }
  validateIdentifier(handle.executionId, "executionId");
  validateIdentifier(handle.taskId, "taskId");
}

export function validateIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)
  ) {
    invalid(`Workflow task ${field} is invalid`);
  }
}

function validateTaskRecord(record: WorkflowTaskRecord): void {
  validateTaskHandle(record);
  if (record.parentTaskId !== undefined) {
    validateIdentifier(record.parentTaskId, "parentTaskId");
    if (record.parentTaskId === record.taskId) {
      invalid("A workflow task cannot be its own parent");
    }
  }
  validateIdentifier(record.agentId, "agentId");
  if (
    !TASK_STATUSES.has(record.status) ||
    !positiveSafeInteger(record.revision) ||
    !positiveSafeInteger(record.attempt) ||
    !validTimestamp(record.createdAt) ||
    !validTimestamp(record.updatedAt) ||
    record.updatedAt < record.createdAt
  ) {
    invalid("Workflow task record is invalid");
  }
  for (const [name, value] of [
    ["startedAt", record.startedAt],
    ["completedAt", record.completedAt],
    ["cancelRequestedAt", record.cancelRequestedAt],
  ] as const) {
    if (
      value !== undefined &&
      (!validTimestamp(value) ||
        value < record.createdAt ||
        value > record.updatedAt)
    ) {
      invalid(`Workflow task ${name} is invalid`);
    }
  }
  if (record.input !== undefined) immutableTaskJson(record.input);
  if (record.output !== undefined) immutableTaskJson(record.output);
  if (record.error) validateTaskError(record.error);
  if (record.claim !== undefined) {
    validateTaskClaim(record.claim, record);
    if (record.status !== "running" && record.status !== "cancelling") {
      invalid("Only active workflow tasks can contain a durable claim");
    }
  }
  const terminal = isTerminalTaskStatus(record.status);
  if (terminal !== (record.completedAt !== undefined)) {
    invalid("Terminal workflow tasks must have completedAt exclusively");
  }
  if (record.status === "running" && record.startedAt === undefined) {
    invalid("Running workflow tasks require startedAt");
  }
  if (
    (record.status === "completed" || record.status === "failed") &&
    record.startedAt === undefined
  ) {
    invalid("Completed and failed workflow tasks require startedAt");
  }
  if (record.status === "queued" && record.startedAt !== undefined) {
    invalid("Queued workflow tasks cannot contain startedAt");
  }
  if (record.status === "completed" && record.error !== undefined) {
    invalid("Completed workflow tasks cannot contain an error");
  }
  if (
    (record.status === "failed" || record.status === "cancelled") &&
    record.error === undefined
  ) {
    invalid("Failed and cancelled workflow tasks require an error");
  }
  if (record.status !== "completed" && record.output !== undefined) {
    invalid("Only completed workflow tasks can contain output");
  }
  if (
    (record.status === "queued" ||
      record.status === "running" ||
      record.status === "cancelling") &&
    (record.output !== undefined || record.error !== undefined)
  ) {
    invalid("Non-terminal workflow tasks cannot contain output or error");
  }
  if (
    (record.status === "cancelling" || record.status === "cancelled") &&
    record.cancelRequestedAt === undefined
  ) {
    invalid(
      "Cancelling and cancelled workflow tasks require cancelRequestedAt",
    );
  }
}

function validateTaskClaim(
  claim: WorkflowTaskClaim,
  record?: WorkflowTaskRecord,
): void {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    invalid("Workflow task claim must be an object");
  }
  validateIdentifier(claim.workerId, "claim.workerId");
  validateIdentifier(claim.leaseId, "claim.leaseId");
  if (!positiveSafeInteger(claim.fencingToken)) {
    invalid("Workflow task claim fencingToken must be a positive integer");
  }
  if (
    !validTimestamp(claim.claimedAt) ||
    !validTimestamp(claim.heartbeatAt) ||
    !validTimestamp(claim.expiresAt) ||
    claim.heartbeatAt < claim.claimedAt ||
    claim.expiresAt <= claim.heartbeatAt ||
    (record !== undefined &&
      (claim.claimedAt < record.createdAt ||
        claim.heartbeatAt > record.updatedAt))
  ) {
    invalid("Workflow task claim timestamps are invalid");
  }
}

function validateClaimRequest(request: WorkflowTaskClaimRequest): void {
  validateTaskHandle(request);
  validateIdentifier(request.workerId, "claim.workerId");
  validateIdentifier(request.leaseId, "claim.leaseId");
  validateLeaseDuration(request.leaseDurationMs);
  if (request.expectedRevision !== undefined) {
    validateExpectedRevision(request.expectedRevision);
  }
}

function validateClaimGuard(request: WorkflowTaskClaimGuard): void {
  validateTaskHandle(request);
  validateIdentifier(request.workerId, "claim.workerId");
  validateIdentifier(request.leaseId, "claim.leaseId");
  if (!positiveSafeInteger(request.fencingToken)) {
    invalid("Workflow task claim fencingToken must be a positive integer");
  }
}

function validateLeaseDuration(leaseDurationMs: number): void {
  if (!positiveSafeInteger(leaseDurationMs)) {
    invalid("Workflow task claim leaseDurationMs must be a positive integer");
  }
}

function validateExpectedRevision(expectedRevision: number): void {
  if (!positiveSafeInteger(expectedRevision)) {
    invalid("Expected task revision must be a positive integer");
  }
}

function assertExpectedRevision(
  current: WorkflowTaskRecord,
  expectedRevision: number,
): void {
  if (current.revision !== expectedRevision) {
    conflict(
      current.executionId,
      current.taskId,
      expectedRevision,
      current.revision,
    );
  }
}

function assertCurrentClaim(
  current: WorkflowTaskRecord,
  expected: WorkflowTaskClaimGuard,
  now: number,
): asserts current is WorkflowTaskRecord & { claim: WorkflowTaskClaim } {
  const claim = current.claim;
  if (
    claim === undefined ||
    claim.workerId !== expected.workerId ||
    claim.leaseId !== expected.leaseId ||
    claim.fencingToken !== expected.fencingToken
  ) {
    claimConflict(expected, current);
  }
  if (claim.expiresAt <= now) {
    throw new WorkflowTaskControlError(
      "WORKFLOW_TASK_LEASE_EXPIRED",
      `Workflow task claim has expired: ${current.taskId}`,
      {
        executionId: current.executionId,
        taskId: current.taskId,
        workerId: expected.workerId,
        leaseId: expected.leaseId,
        fencingToken: expected.fencingToken,
        expiresAt: claim.expiresAt,
        now,
      },
    );
  }
}

function assertClaimUnchanged(
  current: WorkflowTaskClaim | undefined,
  replacement: WorkflowTaskClaim | undefined,
): void {
  if (JSON.stringify(current) !== JSON.stringify(replacement)) {
    invalid("A claimed transition cannot replace its durable claim");
  }
}

function validateTaskError(error: {
  code: string;
  message: string;
  details?: unknown;
}): void {
  if (
    !error ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    typeof error.code !== "string" ||
    !error.code.trim() ||
    typeof error.message !== "string" ||
    !error.message.trim()
  ) {
    invalid("Workflow task error is invalid");
  }
  if (error.details !== undefined) immutableTaskJson(error.details);
}

function assertImmutableIdentity(
  current: WorkflowTaskRecord,
  replacement: WorkflowTaskRecord,
): void {
  if (
    replacement.executionId !== current.executionId ||
    replacement.taskId !== current.taskId ||
    replacement.parentTaskId !== current.parentTaskId ||
    replacement.agentId !== current.agentId ||
    replacement.createdAt !== current.createdAt ||
    JSON.stringify(replacement.input) !== JSON.stringify(current.input)
  ) {
    invalid("Workflow task identity fields are immutable");
  }
}

function assertTransition(
  current: WorkflowTaskRecord,
  replacement: WorkflowTaskRecord,
): void {
  const allowed: Readonly<
    Record<WorkflowTaskStatus, readonly WorkflowTaskStatus[]>
  > = {
    queued: ["running", "cancelling", "cancelled"],
    running: ["cancelling", "completed", "failed", "cancelled"],
    cancelling: ["cancelled"],
    completed: [],
    failed: ["queued"],
    cancelled: ["queued"],
  };
  if (!allowed[current.status].includes(replacement.status)) {
    invalid(
      `Workflow task transition ${current.status} -> ${replacement.status} is invalid`,
    );
  }
  const resuming = replacement.status === "queued";
  if (replacement.attempt !== current.attempt + (resuming ? 1 : 0)) {
    invalid("Workflow task attempt is inconsistent with its transition");
  }
}

function validateTaskListRequest(request: WorkflowTaskListRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        key !== "executionId" &&
        key !== "parentTaskId" &&
        key !== "agentId" &&
        key !== "status" &&
        key !== "cursor" &&
        key !== "limit",
    )
  ) {
    invalid("Workflow task list request is invalid");
  }
  validateIdentifier(request.executionId, "executionId");
  if (request.parentTaskId !== undefined)
    validateIdentifier(request.parentTaskId, "parentTaskId");
  if (request.agentId !== undefined)
    validateIdentifier(request.agentId, "agentId");
  if (request.status !== undefined && !TASK_STATUSES.has(request.status)) {
    invalid("Workflow task list status is invalid");
  }
  if (request.cursor !== undefined && typeof request.cursor !== "string") {
    invalid("Workflow task list cursor is invalid");
  }
}

function matchesTaskList(
  record: WorkflowTaskRecord,
  request: WorkflowTaskListRequest,
): boolean {
  return (
    record.executionId === request.executionId &&
    (request.parentTaskId === undefined ||
      record.parentTaskId === request.parentTaskId) &&
    (request.agentId === undefined || record.agentId === request.agentId) &&
    (request.status === undefined || record.status === request.status)
  );
}

function validateMessageAppend(
  request: WorkflowTaskMessageAppendRequest & { sentAt: number },
): void {
  validateTaskHandle(request);
  if (request.senderTaskId !== undefined)
    validateIdentifier(request.senderTaskId, "senderTaskId");
  if (!validTimestamp(request.sentAt))
    invalid("Workflow task message sentAt is invalid");
  immutableTaskJson(request.payload);
}

function validateMessageRead(request: WorkflowTaskMessageReadRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        key !== "executionId" &&
        key !== "taskId" &&
        key !== "cursor" &&
        key !== "limit",
    )
  ) {
    invalid("Workflow task message read request is invalid");
  }
  validateTaskHandle(request);
  if (request.cursor) {
    if (
      !request.cursor ||
      typeof request.cursor !== "object" ||
      Array.isArray(request.cursor) ||
      Object.keys(request.cursor).some(
        (key) =>
          key !== "executionId" && key !== "taskId" && key !== "afterSequence",
      ) ||
      request.cursor.executionId !== request.executionId ||
      request.cursor.taskId !== request.taskId ||
      !Number.isSafeInteger(request.cursor.afterSequence) ||
      request.cursor.afterSequence < 0
    ) {
      invalid(
        "Workflow task message cursor is invalid or belongs to another mailbox",
      );
    }
  }
}

function boundedLimit(
  requested: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const value = requested ?? fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    invalid(`${field} must be between 1 and ${maximum}`);
  }
  return value;
}

function encodeTaskListCursor(
  request: WorkflowTaskListRequest,
  offset: number,
): string {
  return `workflow-tasks:v1:${encodeURIComponent(taskListScope(request))}:${offset}`;
}

function decodeTaskListCursor(
  cursor: string | undefined,
  request: WorkflowTaskListRequest,
  size: number,
): number {
  if (cursor === undefined) return 0;
  const match = /^workflow-tasks:v1:([^:]+):(\d+)$/u.exec(cursor);
  let decodedScope: string | undefined;
  try {
    decodedScope = match ? decodeURIComponent(match[1] as string) : undefined;
  } catch {
    invalid("Workflow task list cursor is invalid");
  }
  const offset = match ? Number(match[2]) : Number.NaN;
  if (
    decodedScope !== taskListScope(request) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > size
  ) {
    invalid(
      "Workflow task list cursor is invalid or belongs to another execution",
    );
  }
  return offset;
}

function taskListScope(request: WorkflowTaskListRequest): string {
  return JSON.stringify({
    executionId: request.executionId,
    parentTaskId: request.parentTaskId ?? null,
    agentId: request.agentId ?? null,
    status: request.status ?? null,
  });
}

function taskKey(executionId: string, taskId: string): string {
  return `${executionId}\u0000${taskId}`;
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function isTerminalTaskStatus(status: WorkflowTaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function duplicate(executionId: string, taskId: string): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_DUPLICATE",
    `Workflow task already exists: ${taskId}`,
    { executionId, taskId },
  );
}

function notFound(executionId: string, taskId: string): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_NOT_FOUND",
    `Workflow task was not found: ${taskId}`,
    { executionId, taskId },
  );
}

function conflict(
  executionId: string,
  taskId: string,
  expectedRevision: number,
  actualRevision: number,
): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_CONFLICT",
    `Workflow task revision conflict: ${taskId}`,
    { executionId, taskId, expectedRevision, actualRevision },
  );
}

function claimConflict(
  handle: { executionId: string; taskId: string },
  current: WorkflowTaskRecord,
): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_CLAIM_CONFLICT",
    `Workflow task claim conflict: ${handle.taskId}`,
    {
      executionId: handle.executionId,
      taskId: handle.taskId,
      actualRevision: current.revision,
      status: current.status,
      ...(current.claim
        ? {
            actualWorkerId: current.claim.workerId,
            actualLeaseId: current.claim.leaseId,
            actualFencingToken: current.claim.fencingToken,
          }
        : {}),
    },
  );
}

function leaseNotExpired(
  handle: { executionId: string; taskId: string },
  claim: WorkflowTaskClaim,
): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_CLAIM_CONFLICT",
    `Workflow task claim has not expired: ${handle.taskId}`,
    {
      executionId: handle.executionId,
      taskId: handle.taskId,
      expiresAt: claim.expiresAt,
    },
  );
}

function invalid(message: string): never {
  throw new WorkflowTaskControlError("WORKFLOW_TASK_INVALID_REQUEST", message);
}

function waitAborted(request: WorkflowTaskMessageReadRequest): never {
  throw waitAbortedError(request);
}

function waitAbortedError(
  request: WorkflowTaskMessageReadRequest,
): WorkflowTaskControlError {
  return new WorkflowTaskControlError(
    "WORKFLOW_TASK_WAIT_ABORTED",
    `Workflow task mailbox wait was aborted: ${request.taskId}`,
    { executionId: request.executionId, taskId: request.taskId },
  );
}

function taskWaitAborted(executionId: string, taskId: string): never {
  throw taskWaitAbortedError(executionId, taskId);
}

function taskWaitAbortedError(
  executionId: string,
  taskId: string,
): WorkflowTaskControlError {
  return new WorkflowTaskControlError(
    "WORKFLOW_TASK_WAIT_ABORTED",
    `Workflow task revision wait was aborted: ${taskId}`,
    { executionId, taskId },
  );
}
