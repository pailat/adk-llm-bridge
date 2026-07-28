/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type WorkflowTaskAwaitAnyResult,
  type WorkflowTaskClaimGuard,
  WorkflowTaskControlError,
  type WorkflowTaskDriver,
  type WorkflowTaskError,
  type WorkflowTaskHandle,
  type WorkflowTaskJsonValue,
  type WorkflowTaskListRequest,
  type WorkflowTaskListResult,
  type WorkflowTaskMessage,
  type WorkflowTaskMessageAppendRequest,
  type WorkflowTaskMessageReadRequest,
  type WorkflowTaskMessageReadResult,
  type WorkflowTaskRecord,
  type WorkflowTaskResumeRequest,
  type WorkflowTaskSpawnRequest,
} from "./contracts.js";
import { immutableTaskJson } from "./json.js";
import {
  isTerminalTaskStatus,
  validateIdentifier,
  validateTaskHandle,
  type WorkflowTaskClaimStore,
  type WorkflowTaskMessageStore,
  type WorkflowTaskStore,
} from "./stores.js";

export const MAX_WORKFLOW_TASK_AWAIT_HANDLES = 1_000;

export interface WorkflowTaskHeartbeatHandle {
  cancel(): void;
}

export interface WorkflowTaskDurableExecutionConfig {
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  /** Hosts should provide a globally unique ID when workers survive restarts. */
  createLeaseId?: (handle: WorkflowTaskHandle) => string;
  /** Injectable so hosts and tests can control the heartbeat lifecycle. */
  scheduleHeartbeat?: (
    heartbeat: () => Promise<void>,
    intervalMs: number,
  ) => WorkflowTaskHeartbeatHandle;
}

export interface WorkflowTaskControllerConfig {
  store: WorkflowTaskStore;
  messageStore: WorkflowTaskMessageStore;
  driver: WorkflowTaskDriver;
  /** Opt-in durable execution. Omitting this preserves local legacy behavior. */
  durable?: WorkflowTaskDurableExecutionConfig;
  now?: () => number;
  onBackgroundError?: (error: unknown, handle: WorkflowTaskHandle) => void;
}

interface ActiveTask {
  abort: AbortController;
  token: object;
  task: Promise<void>;
  claimSettled: Promise<void>;
  settleClaim(): void;
  durable?: DurableAttempt;
}

interface DurableAttempt {
  guard: WorkflowTaskClaimGuard;
  record: WorkflowTaskRecord;
  heartbeat?: WorkflowTaskHeartbeatHandle;
  tail: Promise<void>;
  lost: boolean;
  lossReason?: unknown;
}

interface NormalizedDurableExecutionConfig {
  workerId: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  createLeaseId(handle: WorkflowTaskHandle): string;
  scheduleHeartbeat(
    heartbeat: () => Promise<void>,
    intervalMs: number,
  ): WorkflowTaskHeartbeatHandle;
}

/** Durable task and mailbox coordinator suitable for a thin JSON/MCP adapter. */
export class WorkflowTaskController {
  readonly #store: WorkflowTaskStore;
  readonly #messageStore: WorkflowTaskMessageStore;
  readonly #driver: WorkflowTaskDriver;
  readonly #claimStore: WorkflowTaskClaimStore | undefined;
  readonly #durable: NormalizedDurableExecutionConfig | undefined;
  readonly #now: () => number;
  readonly #onBackgroundError:
    | ((error: unknown, handle: WorkflowTaskHandle) => void)
    | undefined;
  readonly #active = new Map<string, ActiveTask>();
  #leaseSequence = 0;

  constructor(config: WorkflowTaskControllerConfig) {
    this.#store = config.store;
    this.#messageStore = config.messageStore;
    this.#driver = config.driver;
    this.#now = config.now ?? Date.now;
    this.#onBackgroundError = config.onBackgroundError;
    if (config.durable !== undefined) {
      if (!isWorkflowTaskClaimStore(config.store)) {
        throw new TypeError(
          "Durable workflow task execution requires a WorkflowTaskClaimStore",
        );
      }
      this.#claimStore = config.store;
      this.#durable = normalizeDurableConfig(config.durable, () => {
        this.#leaseSequence++;
        return `lease:${this.#leaseSequence}`;
      });
    }
  }

  async spawn(request: WorkflowTaskSpawnRequest): Promise<WorkflowTaskHandle> {
    const normalized = normalizeSpawnRequest(request);
    if (normalized.parentTaskId !== undefined) {
      await this.#required({
        executionId: normalized.executionId,
        taskId: normalized.parentTaskId,
      });
    }
    const now = this.#timestamp();
    const record = await this.#store.create(
      immutableTaskJson({
        ...normalized,
        status: "queued",
        revision: 1,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies WorkflowTaskRecord),
    );
    this.#launch(record, false);
    return taskHandle(record);
  }

  /** Alias for hosts that expose a start-oriented control API. */
  async start(request: WorkflowTaskSpawnRequest): Promise<WorkflowTaskHandle> {
    return await this.spawn(request);
  }

  async resume(
    request: WorkflowTaskResumeRequest,
  ): Promise<WorkflowTaskHandle> {
    validateResumeRequest(request);
    const key = taskKey(request);
    if (this.#active.has(key)) {
      invalidTransition(
        request,
        "A locally active workflow task cannot be resumed",
      );
    }
    const current = await this.#required(request);
    if (current.status !== "failed" && current.status !== "cancelled") {
      invalidTransition(
        request,
        `Workflow task cannot resume from ${current.status}`,
      );
    }
    const {
      cancelRequestedAt: _cancelRequestedAt,
      completedAt: _completedAt,
      error: _error,
      output: _output,
      startedAt: _startedAt,
      ...durable
    } = current;
    const queued = await this.#store.compareAndSet(
      immutableTaskJson({
        ...durable,
        status: "queued",
        revision: current.revision + 1,
        attempt: current.attempt + 1,
        updatedAt: this.#timestamp(),
      } satisfies WorkflowTaskRecord),
      current.revision,
    );
    this.#launch(queued, true);
    return taskHandle(queued);
  }

  async status(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord> {
    return await this.#required(handle);
  }

  /**
   * Requeues one expired running attempt and starts a new fenced attempt.
   *
   * Recovery is intentionally explicit and at-least-once. A previous driver
   * may have produced effects before its lease expired, so drivers must make
   * externally visible effects idempotent.
   */
  async recoverExpired(
    handle: WorkflowTaskHandle,
  ): Promise<WorkflowTaskHandle> {
    validateExactHandle(handle);
    const claimStore = this.#requiredClaimStore();
    const current = await this.#required(handle);
    if (current.status === "cancelling") {
      invalidTransition(
        handle,
        "Expired cancelling tasks are not recoverable by the configured claim store",
      );
    }
    if (current.status !== "running" || current.claim === undefined) {
      invalidTransition(
        handle,
        `Workflow task cannot recover from ${current.status}`,
      );
    }
    const queued = await claimStore.requeueExpired({
      ...handle,
      expectedRevision: current.revision,
    });
    const previous = this.#active.get(taskKey(handle));
    if (previous?.durable) {
      this.#loseClaim(
        previous,
        new WorkflowTaskControlError(
          "WORKFLOW_TASK_LEASE_EXPIRED",
          `Workflow task claim was recovered after expiry: ${handle.taskId}`,
          taskDetails(handle),
        ),
      );
    }
    this.#launch(queued, true);
    return taskHandle(queued);
  }

  async list(
    request: WorkflowTaskListRequest,
  ): Promise<WorkflowTaskListResult> {
    return await this.#store.list(request);
  }

  async cancel(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord> {
    validateExactHandle(handle);
    const key = taskKey(handle);
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(handle);
      if (isTerminalTaskStatus(current.status)) return current;
      const active = this.#active.get(key);
      if (active?.durable && !active.durable.lost) {
        return await this.#cancelDurable(handle, active);
      }
      if (current.claim !== undefined) {
        if (!active || active.durable?.lost) notOwned(handle);
        // claim() may publish remotely before its response installs the local
        // guard. Wait for that response rather than attempting unfenced CAS.
        await active.claimSettled;
        continue;
      }
      if (current.status === "cancelling") {
        if (!active) {
          const latest = await this.#required(handle);
          if (isTerminalTaskStatus(latest.status)) return latest;
          notOwned(handle);
        }
        active.abort.abort(cancellationError());
        return current;
      }
      if (current.status === "running" && !active) {
        const latest = await this.#required(handle);
        if (isTerminalTaskStatus(latest.status)) return latest;
        notOwned(handle);
      }
      const now = this.#timestamp();
      const targetStatus = active ? "cancelling" : "cancelled";
      const candidate = immutableTaskJson({
        ...current,
        status: targetStatus,
        revision: current.revision + 1,
        updatedAt: now,
        cancelRequestedAt: now,
        ...(targetStatus === "cancelled"
          ? { completedAt: now, error: cancellationError() }
          : {}),
      } satisfies WorkflowTaskRecord);
      try {
        const saved = await this.#store.compareAndSet(
          candidate,
          current.revision,
        );
        active?.abort.abort(cancellationError());
        return saved;
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new WorkflowTaskControlError(
      "WORKFLOW_TASK_CONFLICT",
      `Workflow task cancellation remained contended: ${handle.taskId}`,
      taskDetails(handle),
    );
  }

  async send(
    request: WorkflowTaskMessageAppendRequest,
  ): Promise<WorkflowTaskMessage> {
    validateSendRequest(request);
    await this.#required(request);
    if (request.senderTaskId !== undefined) {
      await this.#required({
        executionId: request.executionId,
        taskId: request.senderTaskId,
      });
    }
    return await this.#messageStore.append(
      immutableTaskJson({ ...request, sentAt: this.#timestamp() }),
    );
  }

  async readMailbox(
    request: WorkflowTaskMessageReadRequest,
  ): Promise<WorkflowTaskMessageReadResult> {
    await this.#required(request);
    return await this.#messageStore.read(request);
  }

  async waitForMessages(
    request: WorkflowTaskMessageReadRequest,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskMessageReadResult> {
    await this.#required(request);
    return await this.#messageStore.wait(request, signal);
  }

  /** Joins a terminal task or one currently owned by this controller. */
  async join(
    handle: WorkflowTaskHandle,
    signal?: AbortSignal,
  ): Promise<WorkflowTaskRecord> {
    validateExactHandle(handle);
    const current = await this.#required(handle);
    if (isTerminalTaskStatus(current.status)) return current;
    const active = this.#active.get(taskKey(handle));
    if (!active) {
      const latest = await this.#required(handle);
      if (isTerminalTaskStatus(latest.status)) return latest;
      notOwned(handle);
    }
    await waitForTask(active.task, signal, handle);
    const settled = await this.#required(handle);
    if (!isTerminalTaskStatus(settled.status)) notOwned(handle);
    return settled;
  }

  /**
   * Waits for any local task, then chooses the first terminal handle in input
   * order. This makes simultaneous completion deterministic.
   */
  async awaitAny(
    handles: readonly WorkflowTaskHandle[],
    signal?: AbortSignal,
  ): Promise<WorkflowTaskAwaitAnyResult> {
    const normalized = normalizeHandles(handles);
    const terminal = await this.#firstTerminal(normalized);
    if (terminal) return terminal;
    const activeTasks: Promise<void>[] = [];
    let missing: WorkflowTaskHandle | undefined;
    for (const handle of normalized) {
      const active = this.#active.get(taskKey(handle));
      if (active) activeTasks.push(active.task);
      else missing ??= handle;
    }
    if (missing) {
      const rescanned = await this.#firstTerminal(normalized);
      if (rescanned) return rescanned;
      notOwned(missing);
    }
    await waitForTask(Promise.race(activeTasks), signal, normalized[0]);
    const settled = await this.#firstTerminal(normalized);
    if (settled) return settled;
    // A local infrastructure failure may settle without changing durable state.
    notOwned(normalized[0] as WorkflowTaskHandle);
  }

  async waitForIdle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all(
        [...this.#active.values()].map((active) => active.task),
      );
    }
  }

  #launch(record: WorkflowTaskRecord, resumed: boolean): void {
    const abort = new AbortController();
    const token = {};
    const key = taskKey(record);
    let settleClaim!: () => void;
    const claimSettled = new Promise<void>((resolve) => {
      settleClaim = resolve;
    });
    const active: ActiveTask = {
      abort,
      token,
      task: Promise.resolve(),
      claimSettled,
      settleClaim,
    };
    this.#active.set(key, active);
    active.task = Promise.resolve()
      .then(() => this.#run(taskHandle(record), active, resumed))
      .catch((error: unknown) => {
        try {
          this.#onBackgroundError?.(error, taskHandle(record));
        } catch {
          // Observer failures must not create an unhandled rejection.
        }
      })
      .finally(() => {
        active.durable?.heartbeat?.cancel();
        if (this.#active.get(key)?.token === token) this.#active.delete(key);
      });
  }

  async #run(
    handle: WorkflowTaskHandle,
    active: ActiveTask,
    resumed: boolean,
  ): Promise<void> {
    const { signal } = active.abort;
    let current: WorkflowTaskRecord | undefined;
    try {
      current = await this.#claim(handle, active);
    } finally {
      active.settleClaim();
    }
    if (!current) return;
    if (signal.aborted) {
      if (!active.durable?.lost) {
        await this.#finishCancelled(await this.#required(handle), active);
      }
      return;
    }
    try {
      const result = await this.#driver.execute({
        task: current,
        signal,
        resumed,
        spawn: async (request) => {
          await this.#assertDriverActive(handle, active);
          return await this.spawn({
            ...request,
            executionId: handle.executionId,
            parentTaskId: handle.taskId,
          });
        },
        send: async (request) => {
          await this.#assertDriverActive(handle, active);
          return await this.send({
            executionId: handle.executionId,
            taskId: request.taskId,
            senderTaskId: handle.taskId,
            payload: request.payload,
          });
        },
        readMailbox: async (request = {}) => {
          await this.#assertDriverOwned(handle, active);
          return await this.readMailbox({ ...request, ...handle });
        },
        waitForMailbox: async (request = {}) => {
          await this.#assertDriverOwned(handle, active);
          return await this.waitForMessages({ ...request, ...handle }, signal);
        },
        join: async (child) => {
          await this.#assertDriverActive(handle, active);
          assertSameExecution(handle, child);
          return await this.join(child, signal);
        },
        awaitAny: async (children) => {
          await this.#assertDriverActive(handle, active);
          for (const child of children) assertSameExecution(handle, child);
          return await this.awaitAny(children, signal);
        },
        cancel: async (child) => {
          await this.#assertDriverActive(handle, active);
          assertSameExecution(handle, child);
          return await this.cancel(child);
        },
      });
      const output =
        result.output === undefined
          ? undefined
          : immutableTaskJson(result.output);
      if (active.durable?.lost) throw active.durable.lossReason;
      if (signal.aborted) {
        await this.#finishCancelled(await this.#required(handle), active);
      } else {
        await this.#finish(
          handle,
          "completed",
          {
            ...(output === undefined ? {} : { output }),
          },
          active,
        );
      }
    } catch (error) {
      if (active.durable?.lost) throw active.durable.lossReason ?? error;
      if (signal.aborted) {
        await this.#finishCancelled(await this.#required(handle), active);
      } else {
        await this.#finish(
          handle,
          "failed",
          { error: normalizeError(error) },
          active,
        );
      }
    }
  }

  async #claim(
    handle: WorkflowTaskHandle,
    active: ActiveTask,
  ): Promise<WorkflowTaskRecord | undefined> {
    const { signal } = active.abort;
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(handle);
      if (signal.aborted || current.status === "cancelling") {
        await this.#finishCancelled(current, active);
        return undefined;
      }
      if (
        isTerminalTaskStatus(current.status) ||
        current.status === "running"
      ) {
        return undefined;
      }
      if (current.status !== "queued") return undefined;
      try {
        if (this.#claimStore && this.#durable) {
          const leaseId = this.#durable.createLeaseId(handle);
          validateIdentifier(leaseId, "claim.leaseId");
          const claimed = await this.#claimStore.claim({
            ...handle,
            workerId: this.#durable.workerId,
            leaseId,
            leaseDurationMs: this.#durable.leaseDurationMs,
            expectedRevision: current.revision,
          });
          const claim = claimed.claim;
          if (!claim) {
            throw new WorkflowTaskControlError(
              "WORKFLOW_TASK_CLAIM_CONFLICT",
              `Workflow task claim store returned no claim: ${handle.taskId}`,
              taskDetails(handle),
            );
          }
          active.durable = {
            record: claimed,
            guard: immutableTaskJson({
              ...handle,
              workerId: claim.workerId,
              leaseId: claim.leaseId,
              fencingToken: claim.fencingToken,
            }),
            tail: Promise.resolve(),
            lost: false,
          };
          this.#startHeartbeat(active);
          return claimed;
        }
        const now = this.#timestamp();
        return await this.#store.compareAndSet(
          immutableTaskJson({
            ...current,
            status: "running",
            revision: current.revision + 1,
            updatedAt: now,
            startedAt: now,
          } satisfies WorkflowTaskRecord),
          current.revision,
        );
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new WorkflowTaskControlError(
      "WORKFLOW_TASK_CONFLICT",
      `Workflow task claim remained contended: ${handle.taskId}`,
      taskDetails(handle),
    );
  }

  async #finishCancelled(
    current: WorkflowTaskRecord,
    active?: ActiveTask,
  ): Promise<void> {
    if (isTerminalTaskStatus(current.status)) return;
    await this.#finish(
      taskHandle(current),
      "cancelled",
      {
        error: cancellationError(),
      },
      active,
    );
  }

  async #finish(
    handle: WorkflowTaskHandle,
    status: "completed" | "failed" | "cancelled",
    fields: { output?: WorkflowTaskJsonValue; error?: WorkflowTaskError },
    active?: ActiveTask,
  ): Promise<WorkflowTaskRecord> {
    if (active?.durable) {
      return await this.#finishDurable(handle, status, fields, active);
    }
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(handle);
      if (isTerminalTaskStatus(current.status)) return current;
      const now = this.#timestamp();
      const candidate = immutableTaskJson({
        ...current,
        ...fields,
        status,
        revision: current.revision + 1,
        updatedAt: now,
        completedAt: now,
        ...(status === "cancelled" && current.cancelRequestedAt === undefined
          ? { cancelRequestedAt: now }
          : {}),
      } satisfies WorkflowTaskRecord);
      try {
        return await this.#store.compareAndSet(candidate, current.revision);
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new WorkflowTaskControlError(
      "WORKFLOW_TASK_CONFLICT",
      `Workflow task completion remained contended: ${handle.taskId}`,
      taskDetails(handle),
    );
  }

  async #finishDurable(
    handle: WorkflowTaskHandle,
    status: "completed" | "failed" | "cancelled",
    fields: { output?: WorkflowTaskJsonValue; error?: WorkflowTaskError },
    active: ActiveTask,
  ): Promise<WorkflowTaskRecord> {
    active.durable?.heartbeat?.cancel();
    return await this.#withAttempt(active, async (attempt) => {
      const claimStore = this.#requiredClaimStore();
      const current = await this.#required(handle);
      this.#assertAttemptOwns(attempt, current);
      const now = this.#timestamp();
      const { claim: _claim, ...unclaimed } = current;
      const candidate = immutableTaskJson({
        ...unclaimed,
        ...fields,
        status,
        revision: current.revision + 1,
        updatedAt: now,
        completedAt: now,
        ...(status === "cancelled" && current.cancelRequestedAt === undefined
          ? { cancelRequestedAt: now }
          : {}),
      } satisfies WorkflowTaskRecord);
      const saved = await claimStore.compareAndSetClaimed({
        record: candidate,
        expectedRevision: current.revision,
        claim: attempt.guard,
      });
      attempt.record = saved;
      return saved;
    });
  }

  async #cancelDurable(
    handle: WorkflowTaskHandle,
    active: ActiveTask,
  ): Promise<WorkflowTaskRecord> {
    const saved = await this.#withAttempt(active, async (attempt) => {
      const current = await this.#required(handle);
      if (isTerminalTaskStatus(current.status)) return current;
      this.#assertAttemptOwns(attempt, current);
      if (current.status === "cancelling") return current;
      if (current.status !== "running") {
        invalidTransition(
          handle,
          `Workflow task cannot be durably cancelled from ${current.status}`,
        );
      }
      const now = this.#timestamp();
      const candidate = immutableTaskJson({
        ...current,
        status: "cancelling",
        revision: current.revision + 1,
        updatedAt: now,
        cancelRequestedAt: now,
      } satisfies WorkflowTaskRecord);
      const transitioned =
        await this.#requiredClaimStore().compareAndSetClaimed({
          record: candidate,
          expectedRevision: current.revision,
          claim: attempt.guard,
        });
      attempt.record = transitioned;
      return transitioned;
    });
    active.abort.abort(cancellationError());
    return saved;
  }

  #startHeartbeat(active: ActiveTask): void {
    const attempt = active.durable;
    const durable = this.#durable;
    if (!attempt || !durable || attempt.heartbeat) return;
    attempt.heartbeat = durable.scheduleHeartbeat(
      async () => await this.#heartbeat(active),
      durable.heartbeatIntervalMs,
    );
  }

  async #heartbeat(active: ActiveTask): Promise<void> {
    try {
      await this.#withAttempt(active, async (attempt) => {
        const renewed = await this.#requiredClaimStore().renewClaim({
          ...attempt.guard,
          expectedRevision: attempt.record.revision,
          leaseDurationMs: this.#durable?.leaseDurationMs ?? 0,
        });
        attempt.record = renewed;
      });
    } catch (error) {
      this.#loseClaim(active, error);
    }
  }

  async #withAttempt<T>(
    active: ActiveTask,
    operation: (attempt: DurableAttempt) => Promise<T>,
  ): Promise<T> {
    const attempt = active.durable;
    if (!attempt) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_NOT_OWNED",
        "Workflow task has no durable local attempt",
      );
    }
    const previous = attempt.tail;
    let release!: () => void;
    attempt.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (attempt.lost) throw attempt.lossReason;
      return await operation(attempt);
    } finally {
      release();
    }
  }

  #loseClaim(active: ActiveTask, error: unknown): void {
    const attempt = active.durable;
    if (!attempt || attempt.lost) return;
    attempt.lost = true;
    attempt.lossReason = error;
    attempt.heartbeat?.cancel();
    active.abort.abort(error);
  }

  #assertAttemptOwns(
    attempt: DurableAttempt,
    current: WorkflowTaskRecord,
  ): void {
    const claim = current.claim;
    if (
      attempt.lost ||
      claim === undefined ||
      claim.workerId !== attempt.guard.workerId ||
      claim.leaseId !== attempt.guard.leaseId ||
      claim.fencingToken !== attempt.guard.fencingToken
    ) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_NOT_OWNED",
        `Workflow task is no longer owned by this worker: ${current.taskId}`,
        taskDetails(current),
      );
    }
    const now = this.#timestamp();
    if (claim.expiresAt <= now) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_LEASE_EXPIRED",
        `Workflow task claim has expired: ${current.taskId}`,
        {
          ...taskDetails(current),
          fencingToken: claim.fencingToken,
          expiresAt: claim.expiresAt,
          now,
        },
      );
    }
  }

  #requiredClaimStore(): WorkflowTaskClaimStore {
    if (!this.#claimStore || !this.#durable) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_INVALID_REQUEST",
        "Durable workflow task execution is not configured",
      );
    }
    return this.#claimStore;
  }

  async #required(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord> {
    validateTaskHandle(handle);
    const record = await this.#store.get(handle.executionId, handle.taskId);
    if (!record) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_NOT_FOUND",
        `Workflow task was not found: ${handle.taskId}`,
        taskDetails(handle),
      );
    }
    return record;
  }

  async #assertDriverOwned(
    handle: WorkflowTaskHandle,
    active: ActiveTask,
  ): Promise<void> {
    if (this.#active.get(taskKey(handle))?.token !== active.token) {
      invalidTransition(handle, "Workflow task is no longer locally owned");
    }
    const current = await this.#required(handle);
    if (isTerminalTaskStatus(current.status)) {
      invalidTransition(handle, `Workflow task is already ${current.status}`);
    }
    if (active.durable) {
      try {
        this.#assertAttemptOwns(active.durable, current);
      } catch (error) {
        this.#loseClaim(active, error);
        throw error;
      }
    }
  }

  async #assertDriverActive(
    handle: WorkflowTaskHandle,
    active: ActiveTask,
  ): Promise<void> {
    await this.#assertDriverOwned(handle, active);
    if (active.abort.signal.aborted) {
      invalidTransition(handle, "Workflow task is cancelling");
    }
    const current = await this.#required(handle);
    if (current.status !== "running") {
      invalidTransition(
        handle,
        `Workflow task cannot act while ${current.status}`,
      );
    }
  }

  async #firstTerminal(
    handles: readonly WorkflowTaskHandle[],
  ): Promise<WorkflowTaskAwaitAnyResult | undefined> {
    for (const handle of handles) {
      const record = await this.#required(handle);
      if (isTerminalTaskStatus(record.status)) {
        return immutableTaskJson({ handle, record });
      }
    }
    return undefined;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      throw new WorkflowTaskControlError(
        "WORKFLOW_TASK_INVALID_REQUEST",
        "Workflow task clock returned an invalid timestamp",
      );
    }
    return value;
  }
}

function normalizeSpawnRequest(
  request: WorkflowTaskSpawnRequest,
): WorkflowTaskSpawnRequest {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        key !== "executionId" &&
        key !== "taskId" &&
        key !== "parentTaskId" &&
        key !== "agentId" &&
        key !== "input",
    )
  ) {
    invalid("Workflow task spawn request is invalid");
  }
  validateTaskHandle(request);
  validateIdentifier(request.agentId, "agentId");
  if (request.parentTaskId !== undefined) {
    validateIdentifier(request.parentTaskId, "parentTaskId");
    if (request.parentTaskId === request.taskId) {
      invalid("A workflow task cannot be its own parent");
    }
  }
  return immutableTaskJson(request);
}

function validateResumeRequest(request: WorkflowTaskResumeRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => key !== "executionId" && key !== "taskId" && key !== "strategy",
    )
  ) {
    invalid("Workflow task resume request is invalid");
  }
  validateTaskHandle(request);
  if (request.strategy !== "checkpoint") {
    invalid("Workflow task resume strategy must be checkpoint");
  }
}

function validateExactHandle(handle: WorkflowTaskHandle): void {
  validateTaskHandle(handle);
  if (
    Object.keys(handle).some((key) => key !== "executionId" && key !== "taskId")
  ) {
    invalid("Workflow task handle contains unknown fields");
  }
}

function validateSendRequest(request: WorkflowTaskMessageAppendRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        key !== "executionId" &&
        key !== "taskId" &&
        key !== "senderTaskId" &&
        key !== "payload",
    ) ||
    !("payload" in request)
  ) {
    invalid("Workflow task message request is invalid");
  }
  validateTaskHandle(request);
  if (request.senderTaskId !== undefined) {
    validateIdentifier(request.senderTaskId, "senderTaskId");
  }
  immutableTaskJson(request.payload);
}

function normalizeHandles(
  handles: readonly WorkflowTaskHandle[],
): readonly WorkflowTaskHandle[] {
  if (
    !Array.isArray(handles) ||
    handles.length === 0 ||
    handles.length > MAX_WORKFLOW_TASK_AWAIT_HANDLES
  ) {
    invalid(
      `Workflow task await handles must contain between 1 and ${MAX_WORKFLOW_TASK_AWAIT_HANDLES} entries`,
    );
  }
  const seen = new Set<string>();
  return Object.freeze(
    handles.map((handle) => {
      validateExactHandle(handle);
      const key = taskKey(handle);
      if (seen.has(key)) invalid("Workflow task await handles must be unique");
      seen.add(key);
      return immutableTaskJson(handle);
    }),
  );
}

function normalizeError(error: unknown): WorkflowTaskError {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    const code = safeErrorString(
      candidate.code,
      "WORKFLOW_TASK_DRIVER_FAILED",
      256,
    );
    const message = safeErrorString(
      candidate.message,
      "Workflow task driver failed",
      65_536,
    );
    let details: Readonly<Record<string, WorkflowTaskJsonValue>> | undefined;
    if (candidate.details !== undefined) {
      try {
        const normalized = immutableTaskJson(candidate.details);
        if (
          normalized &&
          typeof normalized === "object" &&
          !Array.isArray(normalized)
        ) {
          details = normalized as Readonly<
            Record<string, WorkflowTaskJsonValue>
          >;
        }
      } catch {
        // Invalid provider details are omitted from durable state.
      }
    }
    return immutableTaskJson({
      code,
      message,
      ...(details ? { details } : {}),
    });
  }
  return immutableTaskJson({
    code: "WORKFLOW_TASK_DRIVER_FAILED",
    message: safeErrorString(error, "Workflow task driver failed", 65_536),
  });
}

function safeErrorString(
  value: unknown,
  fallback: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.slice(0, maximumLength);
}

function cancellationError(): WorkflowTaskError {
  return Object.freeze({
    code: "WORKFLOW_TASK_CANCELLED",
    message: "Workflow task was cancelled",
  });
}

function taskHandle(handle: WorkflowTaskHandle): WorkflowTaskHandle {
  return immutableTaskJson({
    executionId: handle.executionId,
    taskId: handle.taskId,
  });
}

function taskKey(handle: WorkflowTaskHandle): string {
  return `${handle.executionId}\u0000${handle.taskId}`;
}

function assertSameExecution(
  owner: WorkflowTaskHandle,
  target: WorkflowTaskHandle,
): void {
  validateExactHandle(target);
  if (owner.executionId !== target.executionId) {
    invalid("Workflow task capability cannot cross execution boundaries");
  }
}

async function waitForTask(
  task: Promise<void>,
  signal: AbortSignal | undefined,
  handle: WorkflowTaskHandle | undefined,
): Promise<void> {
  if (!signal) return await task;
  if (signal.aborted) throw waitAborted(handle);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(waitAborted(handle));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    task.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function waitAborted(
  handle: WorkflowTaskHandle | undefined,
): WorkflowTaskControlError {
  return new WorkflowTaskControlError(
    "WORKFLOW_TASK_WAIT_ABORTED",
    `Workflow task wait was aborted${handle ? `: ${handle.taskId}` : ""}`,
    handle ? taskDetails(handle) : undefined,
  );
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowTaskControlError &&
    error.code === "WORKFLOW_TASK_CONFLICT"
  );
}

function isWorkflowTaskClaimStore(
  store: WorkflowTaskStore,
): store is WorkflowTaskClaimStore {
  const candidate = store as Partial<WorkflowTaskClaimStore>;
  return (
    typeof candidate.claim === "function" &&
    typeof candidate.renewClaim === "function" &&
    typeof candidate.compareAndSetClaimed === "function" &&
    typeof candidate.requeueExpired === "function"
  );
}

function normalizeDurableConfig(
  config: WorkflowTaskDurableExecutionConfig,
  defaultCreateLeaseId: (handle: WorkflowTaskHandle) => string,
): NormalizedDurableExecutionConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Workflow task durable execution config is invalid");
  }
  validateIdentifier(config.workerId, "durable.workerId");
  for (const [name, value] of [
    ["leaseDurationMs", config.leaseDurationMs],
    ["heartbeatIntervalMs", config.heartbeatIntervalMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Workflow task durable ${name} must be positive`);
    }
  }
  if (config.heartbeatIntervalMs >= config.leaseDurationMs) {
    throw new TypeError(
      "Workflow task durable heartbeatIntervalMs must be less than leaseDurationMs",
    );
  }
  if (
    config.createLeaseId !== undefined &&
    typeof config.createLeaseId !== "function"
  ) {
    throw new TypeError(
      "Workflow task durable createLeaseId must be a function",
    );
  }
  if (
    config.scheduleHeartbeat !== undefined &&
    typeof config.scheduleHeartbeat !== "function"
  ) {
    throw new TypeError(
      "Workflow task durable scheduleHeartbeat must be a function",
    );
  }
  return {
    workerId: config.workerId,
    leaseDurationMs: config.leaseDurationMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    createLeaseId: config.createLeaseId ?? defaultCreateLeaseId,
    scheduleHeartbeat: config.scheduleHeartbeat ?? defaultScheduleHeartbeat,
  };
}

function defaultScheduleHeartbeat(
  heartbeat: () => Promise<void>,
  intervalMs: number,
): WorkflowTaskHeartbeatHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    timer = setTimeout(async () => {
      timer = undefined;
      await heartbeat();
      if (!cancelled) schedule();
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return Object.freeze({
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  });
}

function notOwned(handle: WorkflowTaskHandle): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_NOT_OWNED",
    `Workflow task is active but not owned by this controller: ${handle.taskId}`,
    taskDetails(handle),
  );
}

function invalidTransition(handle: WorkflowTaskHandle, message: string): never {
  throw new WorkflowTaskControlError(
    "WORKFLOW_TASK_INVALID_TRANSITION",
    message,
    taskDetails(handle),
  );
}

function invalid(message: string): never {
  throw new WorkflowTaskControlError("WORKFLOW_TASK_INVALID_REQUEST", message);
}

function taskDetails(
  handle: WorkflowTaskHandle,
): Readonly<Record<string, WorkflowTaskJsonValue>> {
  return Object.freeze({
    executionId: handle.executionId,
    taskId: handle.taskId,
  });
}
