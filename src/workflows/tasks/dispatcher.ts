/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  WorkflowTaskControlError,
  type WorkflowTaskHandle,
  type WorkflowTaskRecord,
} from "./contracts.js";
import { WorkflowTaskController } from "./controller.js";
import { validateIdentifier } from "./stores.js";

export const DEFAULT_WORKFLOW_TASK_SWEEP_LIMIT = 100;
export const MAX_WORKFLOW_TASK_SWEEP_LIMIT = 500;

export type WorkflowTaskDispatchAction =
  | "dispatched"
  | "recovered"
  | "cancelled-expired"
  | "contended";

export interface WorkflowTaskDispatchOutcome extends WorkflowTaskHandle {
  action: WorkflowTaskDispatchAction;
}

export interface WorkflowTaskDispatchFailure extends WorkflowTaskHandle {
  code: string;
  message: string;
}

export interface WorkflowTaskSweepRequest {
  executionId: string;
  limit?: number;
  /** Opaque continuation returned by a previous sweep of this execution. */
  cursor?: string;
}

export interface WorkflowTaskSweepResult {
  inspected: number;
  outcomes: readonly WorkflowTaskDispatchOutcome[];
  failures: readonly WorkflowTaskDispatchFailure[];
  nextCursor: string;
}

export interface WorkflowTaskDispatcherConfig {
  controller: WorkflowTaskController;
  now?: () => number;
  maxSweepTasks?: number;
}

/**
 * Host-neutral, bounded durable task dispatcher.
 *
 * The host decides when to call sweep(). There is deliberately no timer or
 * infinite loop here. Claims and recovery CAS make concurrent sweepers safe,
 * while task effects retain at-least-once semantics.
 */
export class WorkflowTaskDispatcher {
  readonly #controller: WorkflowTaskController;
  readonly #now: () => number;
  readonly #maxSweepTasks: number;

  constructor(config: WorkflowTaskDispatcherConfig) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError("Workflow task dispatcher config is invalid");
    }
    if (!(config.controller instanceof WorkflowTaskController)) {
      throw new TypeError("Workflow task dispatcher controller is required");
    }
    this.#controller = config.controller;
    this.#now = config.now ?? Date.now;
    this.#maxSweepTasks = boundedSweepLimit(
      config.maxSweepTasks,
      MAX_WORKFLOW_TASK_SWEEP_LIMIT,
      "maxSweepTasks",
    );
  }

  async sweep(
    request: WorkflowTaskSweepRequest,
  ): Promise<WorkflowTaskSweepResult> {
    validateSweepRequest(request);
    const limit = boundedSweepLimit(
      request.limit,
      this.#maxSweepTasks,
      "limit",
    );
    const page = await this.#candidates(
      request.executionId,
      limit,
      request.cursor,
    );
    const records = page.records;
    const outcomes: WorkflowTaskDispatchOutcome[] = [];
    const failures: WorkflowTaskDispatchFailure[] = [];
    const now = this.#timestamp();

    for (const record of records) {
      const handle = taskHandle(record);
      try {
        if (record.status === "queued") {
          await this.#controller.dispatch(handle);
          outcomes.push(Object.freeze({ ...handle, action: "dispatched" }));
        } else if (record.claim && record.claim.expiresAt <= now) {
          await this.#controller.recoverExpired(handle);
          outcomes.push(
            Object.freeze({
              ...handle,
              action:
                record.status === "cancelling"
                  ? "cancelled-expired"
                  : "recovered",
            }),
          );
        }
      } catch (error) {
        if (isContention(error)) {
          outcomes.push(Object.freeze({ ...handle, action: "contended" }));
          continue;
        }
        failures.push(
          Object.freeze({
            ...handle,
            code: errorCode(error),
            message: errorMessage(error),
          }),
        );
      }
    }

    return Object.freeze({
      inspected: records.length,
      outcomes: Object.freeze(outcomes),
      failures: Object.freeze(failures),
      nextCursor: page.nextCursor,
    });
  }

  async #candidates(
    executionId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{
    records: readonly WorkflowTaskRecord[];
    nextCursor: string;
  }> {
    const state = decodeSweepCursor(cursor, executionId);
    const records: WorkflowTaskRecord[] = [];
    const seen = new Set<string>();
    const quantum = Math.max(1, Math.ceil(limit / SWEEP_STATUSES.length));
    while (
      records.length < limit &&
      state.done.some((completed) => !completed)
    ) {
      const statusIndex = state.phase;
      if (state.done[statusIndex]) {
        state.phase = nextStatus(statusIndex);
        continue;
      }
      const remaining = limit - records.length;
      const status = SWEEP_STATUSES[statusIndex];
      const listed = await this.#controller.list({
        executionId,
        status,
        limit: Math.min(remaining, quantum),
        ...(state.cursors[statusIndex]
          ? { cursor: state.cursors[statusIndex] as string }
          : {}),
      });
      for (const record of listed.records) {
        const key = `${record.executionId}\u0000${record.taskId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      if (listed.nextCursor) {
        state.cursors[statusIndex] = listed.nextCursor;
      } else {
        state.cursors[statusIndex] = null;
        state.done[statusIndex] = true;
      }
      state.phase = nextStatus(statusIndex);
    }
    if (state.done.every(Boolean)) {
      state.phase = 0;
      state.cursors = [null, null, null];
      state.done = [false, false, false];
      state.round++;
    }
    return {
      records,
      nextCursor: encodeSweepCursor(executionId, state),
    };
  }

  #timestamp(): number {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0) {
      throw new TypeError("Workflow task dispatcher clock is invalid");
    }
    return now;
  }
}

function validateSweepRequest(request: WorkflowTaskSweepRequest): void {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) => key !== "executionId" && key !== "limit" && key !== "cursor",
    )
  ) {
    throw new TypeError("Workflow task sweep request is invalid");
  }
  validateIdentifier(request.executionId, "executionId");
  if (request.cursor !== undefined && typeof request.cursor !== "string") {
    throw new TypeError("Workflow task sweep cursor is invalid");
  }
}

const SWEEP_STATUSES = ["queued", "running", "cancelling"] as const;

interface WorkflowTaskSweepCursorState {
  phase: number;
  cursors: Array<string | null>;
  done: boolean[];
  round: number;
}

function nextStatus(status: number): number {
  return (status + 1) % SWEEP_STATUSES.length;
}

function encodeSweepCursor(
  executionId: string,
  state: WorkflowTaskSweepCursorState,
): string {
  return `workflow-task-sweep:v1:${encodeURIComponent(
    JSON.stringify({
      executionId,
      phase: state.phase,
      cursors: state.cursors,
      done: state.done,
      round: state.round,
    }),
  )}`;
}

function decodeSweepCursor(
  cursor: string | undefined,
  executionId: string,
): WorkflowTaskSweepCursorState {
  if (cursor === undefined) {
    return {
      phase: 0,
      cursors: [null, null, null],
      done: [false, false, false],
      round: 0,
    };
  }
  const match = /^workflow-task-sweep:v1:(.+)$/u.exec(cursor);
  let candidate: unknown;
  try {
    candidate = match
      ? JSON.parse(decodeURIComponent(match[1] as string))
      : undefined;
  } catch {
    throw new TypeError("Workflow task sweep cursor is invalid");
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 5
  ) {
    throw new TypeError("Workflow task sweep cursor is invalid");
  }
  const value = candidate as Record<string, unknown>;
  const cursors = value.cursors;
  const done = value.done;
  if (
    value.executionId !== executionId ||
    !Number.isSafeInteger(value.phase) ||
    (value.phase as number) < 0 ||
    (value.phase as number) >= SWEEP_STATUSES.length ||
    !Number.isSafeInteger(value.round) ||
    (value.round as number) < 0 ||
    !Array.isArray(cursors) ||
    cursors.length !== SWEEP_STATUSES.length ||
    cursors.some((item) => item !== null && typeof item !== "string") ||
    !Array.isArray(done) ||
    done.length !== SWEEP_STATUSES.length ||
    done.some((item) => typeof item !== "boolean") ||
    Object.keys(value).some(
      (key) =>
        key !== "executionId" &&
        key !== "phase" &&
        key !== "cursors" &&
        key !== "done" &&
        key !== "round",
    )
  ) {
    throw new TypeError(
      value.executionId !== executionId
        ? "Workflow task sweep cursor belongs to another execution"
        : "Workflow task sweep cursor is invalid",
    );
  }
  return {
    phase: value.phase as number,
    cursors: [...cursors] as Array<string | null>,
    done: [...done] as boolean[],
    round: value.round as number,
  };
}

function boundedSweepLimit(
  value: number | undefined,
  maximum: number,
  field: string,
): number {
  const normalized = value ?? DEFAULT_WORKFLOW_TASK_SWEEP_LIMIT;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > maximum
  ) {
    throw new TypeError(
      `Workflow task dispatcher ${field} must be between 1 and ${maximum}`,
    );
  }
  return normalized;
}

function taskHandle(record: WorkflowTaskRecord): WorkflowTaskHandle {
  return Object.freeze({
    executionId: record.executionId,
    taskId: record.taskId,
  });
}

function isContention(error: unknown): boolean {
  return (
    error instanceof WorkflowTaskControlError &&
    (error.code === "WORKFLOW_TASK_CONFLICT" ||
      error.code === "WORKFLOW_TASK_CLAIM_CONFLICT" ||
      error.code === "WORKFLOW_TASK_LEASE_EXPIRED" ||
      error.code === "WORKFLOW_TASK_INVALID_TRANSITION" ||
      error.code === "WORKFLOW_TASK_NOT_OWNED")
  );
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "WORKFLOW_TASK_DISPATCH_FAILED";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Workflow task dispatch failed";
}
