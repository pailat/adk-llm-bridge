/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type WorkflowTaskAwaitAnyResult,
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
  type WorkflowTaskMessageStore,
  type WorkflowTaskStore,
} from "./stores.js";

export const MAX_WORKFLOW_TASK_AWAIT_HANDLES = 1_000;

export interface WorkflowTaskControllerConfig {
  store: WorkflowTaskStore;
  messageStore: WorkflowTaskMessageStore;
  driver: WorkflowTaskDriver;
  now?: () => number;
  onBackgroundError?: (error: unknown, handle: WorkflowTaskHandle) => void;
}

interface ActiveTask {
  abort: AbortController;
  token: object;
  task: Promise<void>;
}

/** Durable task and mailbox coordinator suitable for a thin JSON/MCP adapter. */
export class WorkflowTaskController {
  readonly #store: WorkflowTaskStore;
  readonly #messageStore: WorkflowTaskMessageStore;
  readonly #driver: WorkflowTaskDriver;
  readonly #now: () => number;
  readonly #onBackgroundError:
    | ((error: unknown, handle: WorkflowTaskHandle) => void)
    | undefined;
  readonly #active = new Map<string, ActiveTask>();

  constructor(config: WorkflowTaskControllerConfig) {
    this.#store = config.store;
    this.#messageStore = config.messageStore;
    this.#driver = config.driver;
    this.#now = config.now ?? Date.now;
    this.#onBackgroundError = config.onBackgroundError;
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
  async join(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord> {
    validateExactHandle(handle);
    const current = await this.#required(handle);
    if (isTerminalTaskStatus(current.status)) return current;
    const active = this.#active.get(taskKey(handle));
    if (!active) {
      const latest = await this.#required(handle);
      if (isTerminalTaskStatus(latest.status)) return latest;
      notOwned(handle);
    }
    await active.task;
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
    await Promise.race(activeTasks);
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
    const active: ActiveTask = {
      abort,
      token,
      task: Promise.resolve(),
    };
    this.#active.set(key, active);
    active.task = Promise.resolve()
      .then(() => this.#run(taskHandle(record), token, abort.signal, resumed))
      .catch((error: unknown) => {
        try {
          this.#onBackgroundError?.(error, taskHandle(record));
        } catch {
          // Observer failures must not create an unhandled rejection.
        }
      })
      .finally(() => {
        if (this.#active.get(key)?.token === token) this.#active.delete(key);
      });
  }

  async #run(
    handle: WorkflowTaskHandle,
    token: object,
    signal: AbortSignal,
    resumed: boolean,
  ): Promise<void> {
    const current = await this.#claim(handle, signal);
    if (!current) return;
    if (signal.aborted) {
      await this.#finishCancelled(await this.#required(handle));
      return;
    }
    try {
      const result = await this.#driver.execute({
        task: current,
        signal,
        resumed,
        spawn: async (request) => {
          await this.#assertDriverActive(handle, token, signal);
          return await this.spawn({
            ...request,
            executionId: handle.executionId,
            parentTaskId: handle.taskId,
          });
        },
        send: async (request) => {
          await this.#assertDriverActive(handle, token, signal);
          return await this.send({
            executionId: handle.executionId,
            taskId: request.taskId,
            senderTaskId: handle.taskId,
            payload: request.payload,
          });
        },
        readMailbox: async (request = {}) => {
          await this.#assertDriverOwned(handle, token);
          return await this.readMailbox({ ...request, ...handle });
        },
        waitForMailbox: async (request = {}) => {
          await this.#assertDriverOwned(handle, token);
          return await this.waitForMessages({ ...request, ...handle }, signal);
        },
      });
      const output =
        result.output === undefined
          ? undefined
          : immutableTaskJson(result.output);
      if (signal.aborted) {
        await this.#finishCancelled(await this.#required(handle));
      } else {
        await this.#finish(handle, "completed", {
          ...(output === undefined ? {} : { output }),
        });
      }
    } catch (error) {
      if (signal.aborted) {
        await this.#finishCancelled(await this.#required(handle));
      } else {
        await this.#finish(handle, "failed", { error: normalizeError(error) });
      }
    }
  }

  async #claim(
    handle: WorkflowTaskHandle,
    signal: AbortSignal,
  ): Promise<WorkflowTaskRecord | undefined> {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(handle);
      if (signal.aborted || current.status === "cancelling") {
        await this.#finishCancelled(current);
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

  async #finishCancelled(current: WorkflowTaskRecord): Promise<void> {
    if (isTerminalTaskStatus(current.status)) return;
    await this.#finish(taskHandle(current), "cancelled", {
      error: cancellationError(),
    });
  }

  async #finish(
    handle: WorkflowTaskHandle,
    status: "completed" | "failed" | "cancelled",
    fields: { output?: WorkflowTaskJsonValue; error?: WorkflowTaskError },
  ): Promise<WorkflowTaskRecord> {
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
    token: object,
  ): Promise<void> {
    if (this.#active.get(taskKey(handle))?.token !== token) {
      invalidTransition(handle, "Workflow task is no longer locally owned");
    }
    const current = await this.#required(handle);
    if (isTerminalTaskStatus(current.status)) {
      invalidTransition(handle, `Workflow task is already ${current.status}`);
    }
  }

  async #assertDriverActive(
    handle: WorkflowTaskHandle,
    token: object,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#assertDriverOwned(handle, token);
    if (signal.aborted) {
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

function isConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowTaskControlError &&
    error.code === "WORKFLOW_TASK_CONFLICT"
  );
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
