/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { isWorkflowEvent, type WorkflowEvent } from "../events.js";
import {
  WorkflowExecutionControlError,
  type WorkflowExecutionDriver,
  type WorkflowExecutionError,
  type WorkflowExecutionEventReadRequest,
  type WorkflowExecutionEventReadResult,
  type WorkflowExecutionJsonValue,
  type WorkflowExecutionListRequest,
  type WorkflowExecutionListResult,
  type WorkflowExecutionRecord,
  type WorkflowExecutionRequest,
  type WorkflowExecutionResumeRequest,
  type WorkflowExecutionStatus,
} from "./contracts.js";
import { immutableJson } from "./json.js";
import type {
  WorkflowExecutionEventStore,
  WorkflowExecutionStore,
} from "./stores.js";
import { validateExecutionId } from "./stores.js";

export interface WorkflowExecutionControllerConfig {
  store: WorkflowExecutionStore;
  eventStore: WorkflowExecutionEventStore;
  driver: WorkflowExecutionDriver;
  now?: () => number;
  onBackgroundError?: (error: unknown, executionId: string) => void;
}

interface ActiveExecution {
  abort: AbortController;
  token: object;
  task: Promise<void>;
}

const TERMINAL_STATUSES = new Set<WorkflowExecutionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** Durable, transport-neutral control plane suitable for a thin MCP adapter. */
export class WorkflowExecutionController {
  readonly #store: WorkflowExecutionStore;
  readonly #eventStore: WorkflowExecutionEventStore;
  readonly #driver: WorkflowExecutionDriver;
  readonly #now: () => number;
  readonly #onBackgroundError:
    | ((error: unknown, executionId: string) => void)
    | undefined;
  readonly #active = new Map<string, ActiveExecution>();

  constructor(config: WorkflowExecutionControllerConfig) {
    this.#store = config.store;
    this.#eventStore = config.eventStore;
    this.#driver = config.driver;
    this.#now = config.now ?? Date.now;
    this.#onBackgroundError = config.onBackgroundError;
  }

  async start(
    request: WorkflowExecutionRequest,
  ): Promise<WorkflowExecutionRecord> {
    const normalized = normalizeRequest(request);
    const now = this.#timestamp();
    const record = await this.#store.create(
      immutableJson({
        ...normalized,
        status: "queued",
        revision: 1,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
      } satisfies WorkflowExecutionRecord),
    );
    this.#launch(record, false);
    return record;
  }

  async resume(
    request: WorkflowExecutionResumeRequest,
  ): Promise<WorkflowExecutionRecord> {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) => key !== "executionId" && key !== "strategy",
      )
    ) {
      invalid("Workflow execution resume request is invalid");
    }
    validateExecutionId(request.executionId);
    if (request.strategy !== "checkpoint") {
      invalid("Workflow execution resume strategy must be checkpoint");
    }
    if (this.#active.has(request.executionId)) {
      invalidTransition(
        request.executionId,
        "A locally active workflow execution cannot be resumed",
      );
    }
    const current = await this.#required(request.executionId);
    if (current.status !== "failed" && current.status !== "cancelled") {
      invalidTransition(
        request.executionId,
        `Workflow execution cannot resume from ${current.status}`,
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
      immutableJson({
        ...durable,
        status: "queued",
        revision: current.revision + 1,
        attempt: current.attempt + 1,
        updatedAt: this.#timestamp(),
      } satisfies WorkflowExecutionRecord),
      current.revision,
    );
    this.#launch(queued, true);
    return queued;
  }

  async status(executionId: string): Promise<WorkflowExecutionRecord> {
    return await this.#required(executionId);
  }

  async cancel(executionId: string): Promise<WorkflowExecutionRecord> {
    validateExecutionId(executionId);
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(executionId);
      if (isTerminal(current.status)) return current;
      const active = this.#active.get(executionId);
      if (current.status === "cancelling") {
        if (!active) notOwned(executionId);
        active.abort.abort(cancellationError());
        return current;
      }
      if (current.status === "running" && !active) notOwned(executionId);
      const now = this.#timestamp();
      const targetStatus = active ? "cancelling" : "cancelled";
      const candidate = immutableJson({
        ...current,
        status: targetStatus,
        revision: current.revision + 1,
        updatedAt: now,
        cancelRequestedAt: now,
        ...(targetStatus === "cancelled"
          ? { completedAt: now, error: cancellationError() }
          : {}),
      } satisfies WorkflowExecutionRecord);
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
    throw new WorkflowExecutionControlError(
      "WORKFLOW_EXECUTION_CONFLICT",
      `Workflow execution cancellation remained contended: ${executionId}`,
      { executionId },
    );
  }

  async list(
    request: WorkflowExecutionListRequest = {},
  ): Promise<WorkflowExecutionListResult> {
    return await this.#store.list(request);
  }

  async events(
    request: WorkflowExecutionEventReadRequest,
  ): Promise<WorkflowExecutionEventReadResult> {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      invalid("Workflow event read request is invalid");
    }
    await this.#required(request.executionId);
    return await this.#eventStore.read(request);
  }

  /** Waits for one local run; useful for tests and graceful host shutdown. */
  async wait(executionId: string): Promise<WorkflowExecutionRecord> {
    validateExecutionId(executionId);
    await this.#active.get(executionId)?.task;
    return await this.#required(executionId);
  }

  /** Waits until every run currently owned by this controller has settled. */
  async waitForIdle(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all(
        [...this.#active.values()].map((active) => active.task),
      );
    }
  }

  #launch(record: WorkflowExecutionRecord, resumed: boolean): void {
    const abort = new AbortController();
    const token = {};
    const active: ActiveExecution = {
      abort,
      token,
      task: Promise.resolve(),
    };
    this.#active.set(record.executionId, active);
    active.task = Promise.resolve()
      .then(() => this.#run(record.executionId, token, abort.signal, resumed))
      .catch((error: unknown) => {
        try {
          this.#onBackgroundError?.(error, record.executionId);
        } catch {
          // Observer failures must never create an unhandled background rejection.
        }
      })
      .finally(() => {
        if (this.#active.get(record.executionId)?.token === token) {
          this.#active.delete(record.executionId);
        }
      });
  }

  async #run(
    executionId: string,
    token: object,
    signal: AbortSignal,
    resumed: boolean,
  ): Promise<void> {
    const current = await this.#claim(executionId, signal);
    if (!current) return;

    let output: WorkflowExecutionJsonValue | undefined;
    try {
      const result = await this.#driver.execute({
        execution: current,
        signal,
        resumed,
        emit: (event) => this.#appendEvent(executionId, token, event),
      });
      output =
        result.output === undefined ? undefined : immutableJson(result.output);
    } catch (error) {
      if (signal.aborted) {
        await this.#finishCancelled(await this.#required(executionId));
      } else {
        await this.#finish(executionId, "failed", {
          error: normalizeError(error),
        });
      }
      return;
    }
    if (signal.aborted) {
      await this.#finishCancelled(await this.#required(executionId));
      return;
    }
    await this.#finish(executionId, "completed", {
      ...(output === undefined ? {} : { output }),
    });
  }

  async #claim(
    executionId: string,
    signal: AbortSignal,
  ): Promise<WorkflowExecutionRecord | undefined> {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(executionId);
      if (signal.aborted || current.status === "cancelling") {
        await this.#finishCancelled(current);
        return undefined;
      }
      if (isTerminal(current.status) || current.status === "running") {
        return undefined;
      }
      if (current.status !== "queued") return undefined;
      try {
        return await this.#store.compareAndSet(
          immutableJson({
            ...current,
            status: "running",
            revision: current.revision + 1,
            updatedAt: this.#timestamp(),
            startedAt: this.#timestamp(),
          } satisfies WorkflowExecutionRecord),
          current.revision,
        );
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new WorkflowExecutionControlError(
      "WORKFLOW_EXECUTION_CONFLICT",
      `Workflow execution claim remained contended: ${executionId}`,
      { executionId },
    );
  }

  async #appendEvent(
    executionId: string,
    token: object,
    event: WorkflowEvent,
  ): Promise<void> {
    if (this.#active.get(executionId)?.token !== token) {
      invalidTransition(executionId, "Workflow execution is no longer active");
    }
    const current = await this.#required(executionId);
    if (current.status !== "running" && current.status !== "cancelling") {
      invalidTransition(
        executionId,
        `Workflow events cannot be appended after ${current.status}`,
      );
    }
    if (
      !isWorkflowEvent(event) ||
      event.executionId !== executionId ||
      event.workflowId !== current.workflowId ||
      event.workflowVersion !== current.workflowVersion
    ) {
      invalid("Driver emitted a malformed or mismatched WorkflowEvent");
    }
    await this.#eventStore.append(executionId, immutableJson(event));
  }

  async #finishCancelled(current: WorkflowExecutionRecord): Promise<void> {
    if (isTerminal(current.status)) return;
    await this.#finish(current.executionId, "cancelled", {
      error: cancellationError(),
    });
  }

  async #finish(
    executionId: string,
    status: "completed" | "failed" | "cancelled",
    fields: {
      output?: WorkflowExecutionJsonValue;
      error?: WorkflowExecutionError;
    },
  ): Promise<WorkflowExecutionRecord> {
    for (let retry = 0; retry < 8; retry++) {
      const current = await this.#required(executionId);
      if (isTerminal(current.status)) return current;
      const now = this.#timestamp();
      const candidate = immutableJson({
        ...current,
        ...fields,
        status,
        revision: current.revision + 1,
        updatedAt: now,
        completedAt: now,
      } satisfies WorkflowExecutionRecord);
      try {
        return await this.#store.compareAndSet(candidate, current.revision);
      } catch (error) {
        if (!isConflict(error)) throw error;
      }
    }
    throw new WorkflowExecutionControlError(
      "WORKFLOW_EXECUTION_CONFLICT",
      `Workflow execution completion remained contended: ${executionId}`,
      { executionId },
    );
  }

  async #required(executionId: string): Promise<WorkflowExecutionRecord> {
    validateExecutionId(executionId);
    const record = await this.#store.get(executionId);
    if (!record) {
      throw new WorkflowExecutionControlError(
        "WORKFLOW_EXECUTION_NOT_FOUND",
        `Workflow execution was not found: ${executionId}`,
        { executionId },
      );
    }
    return record;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      invalid("Workflow execution clock returned an invalid timestamp");
    }
    return value;
  }
}

function normalizeRequest(
  request: WorkflowExecutionRequest,
): WorkflowExecutionRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalid("Workflow execution request must be an object");
  }
  const keys = new Set([
    "executionId",
    "workflowId",
    "workflowVersion",
    "input",
    "metadata",
  ]);
  if (Object.keys(request).some((key) => !keys.has(key))) {
    invalid("Workflow execution request contains unknown fields");
  }
  validateExecutionId(request.executionId);
  validateIdentity(request.workflowId, "workflowId");
  validateIdentity(request.workflowVersion, "workflowVersion");
  if (
    request.metadata !== undefined &&
    (!request.metadata ||
      typeof request.metadata !== "object" ||
      Array.isArray(request.metadata))
  ) {
    invalid("Workflow execution metadata must be a JSON object");
  }
  return immutableJson(request);
}

function validateIdentity(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 256
  ) {
    invalid(`Workflow execution ${field} is invalid`);
  }
}

function normalizeError(error: unknown): WorkflowExecutionError {
  let code = "WORKFLOW_EXECUTION_FAILED";
  let message = "Workflow execution failed";
  if (error && typeof error === "object") {
    try {
      if (
        "code" in error &&
        typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
      ) {
        code = error.code;
      }
      if (
        "message" in error &&
        typeof error.message === "string" &&
        error.message.length > 0
      ) {
        message = error.message.slice(0, 4_096);
      }
    } catch {
      // Host error accessors are not trusted.
    }
  }
  return Object.freeze({ code, message });
}

function cancellationError(): WorkflowExecutionError {
  return Object.freeze({
    code: "WORKFLOW_EXECUTION_CANCELLED",
    message: "Workflow execution was cancelled",
  });
}

function isTerminal(status: WorkflowExecutionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowExecutionControlError &&
    error.code === "WORKFLOW_EXECUTION_CONFLICT"
  );
}

function notOwned(executionId: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_NOT_OWNED",
    `Running workflow execution is not owned by this process: ${executionId}`,
    { executionId },
  );
}

function invalidTransition(executionId: string, message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    message,
    { executionId },
  );
}

function invalid(message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_REQUEST",
    message,
  );
}
