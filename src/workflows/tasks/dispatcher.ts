import { normalizeHostError } from "../internal/error-support.js";
import {
  WorkflowTaskControlError,
  type WorkflowTaskHandle,
  type WorkflowTaskRecord,
} from "./contracts.js";
import { WorkflowTaskController } from "./controller.js";
import { validateIdentifier } from "./stores.js";

/** Default number of tasks inspected by one sweep. */
export const DEFAULT_WORKFLOW_TASK_SWEEP_LIMIT = 100;
/** Largest number of tasks one sweep may inspect. */
export const MAX_WORKFLOW_TASK_SWEEP_LIMIT = 500;

/**
 * What a sweep did with a task.
 *
 * @remarks
 * `contended` means another worker won the claim or recovery race.
 */
export type WorkflowTaskDispatchAction =
  | "dispatched"
  | "recovered"
  | "cancelled-expired"
  | "contended";

/** One task handled by a sweep. */
export interface WorkflowTaskDispatchOutcome extends WorkflowTaskHandle {
  /** What the sweep did with the task. */
  action: WorkflowTaskDispatchAction;
}

/**
 * A task a sweep could not dispatch or recover, with the error code and message.
 */
export interface WorkflowTaskDispatchFailure extends WorkflowTaskHandle {
  /**
   * Error code of the failure, or `WORKFLOW_TASK_DISPATCH_FAILED` when it had no string code.
   */
  code: string;
  /** Error message of the failure. */
  message: string;
}

/**
 * Options for {@link WorkflowTaskDispatcher.sweep}.
 *
 * @remarks
 * `limit` defaults to the smaller of
 * {@link DEFAULT_WORKFLOW_TASK_SWEEP_LIMIT} and the dispatcher's
 * `maxSweepTasks`; an explicit `limit` may not exceed `maxSweepTasks`.
 */
export interface WorkflowTaskSweepRequest {
  /** Execution to sweep. */
  executionId: string;
  /**
   * Maximum tasks to inspect.
   *
   * @defaultValue 100, capped by `maxSweepTasks`
   */
  limit?: number;
  /** Opaque continuation returned by a previous sweep of this execution. */
  cursor?: string;
}

/** Result of one sweep, with the cursor to continue the next one. */
export interface WorkflowTaskSweepResult {
  /** Number of tasks inspected. */
  inspected: number;
  /** Tasks the sweep acted on. */
  outcomes: readonly WorkflowTaskDispatchOutcome[];
  /** Tasks the sweep could not handle. */
  failures: readonly WorkflowTaskDispatchFailure[];
  /** Opaque cursor to pass to the next sweep of this execution. */
  nextCursor: string;
}

/**
 * Options for {@link WorkflowTaskDispatcher}.
 *
 * @remarks
 * `maxSweepTasks` is capped at {@link MAX_WORKFLOW_TASK_SWEEP_LIMIT}.
 */
export interface WorkflowTaskDispatcherConfig {
  /**
   * Controller used to dispatch and recover tasks; must be a `WorkflowTaskController`.
   */
  controller: WorkflowTaskController;
  /**
   * Clock returning epoch milliseconds, used to decide lease expiry.
   *
   * @defaultValue `Date.now`
   */
  now?: () => number;
  /**
   * Largest `limit` a sweep accepts.
   *
   * @defaultValue 100
   */
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

  /**
   * @param config - Controller, clock and sweep cap.
   * @throws TypeError when the config, controller, clock or `maxSweepTasks`
   * is invalid; these are host programming errors, not request errors.
   */
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
      configError,
    );
  }

  /**
   * Inspects one bounded page of live tasks and dispatches, recovers or
   * cancels each one that is due.
   *
   * @param request - Execution id, optional page size and the cursor returned
   * by the previous sweep.
   * @returns What happened to each inspected task and the next cursor.
   * @throws {@link WorkflowTaskControlError} with code
   * `WORKFLOW_TASK_INVALID_REQUEST` when the request, its execution id, its
   * limit or its cursor is invalid, or the cursor belongs to another
   * execution.
   */
  async sweep(
    request: WorkflowTaskSweepRequest,
  ): Promise<WorkflowTaskSweepResult> {
    validateSweepRequest(request);
    const limit = boundedSweepLimit(
      request.limit,
      this.#maxSweepTasks,
      "limit",
      invalidRequest,
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
        const { code, message } = normalizeHostError(error, {
          fallbackCode: "WORKFLOW_TASK_DISPATCH_FAILED",
          fallbackMessage: "Workflow task dispatch failed",
          maxCodeLength: 256,
          maxMessageLength: 65_536,
        });
        failures.push(Object.freeze({ ...handle, code, message }));
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
    throw invalidRequest("Workflow task sweep request is invalid");
  }
  validateIdentifier(request.executionId, "executionId");
  if (request.cursor !== undefined && typeof request.cursor !== "string") {
    throw invalidRequest("Workflow task sweep cursor is invalid");
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
    throw invalidRequest("Workflow task sweep cursor is invalid");
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.keys(candidate).length !== 5
  ) {
    throw invalidRequest("Workflow task sweep cursor is invalid");
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
    throw invalidRequest(
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

// A bad sweep request is the caller's input and carries the task request
// code; a bad dispatcher config is a host programming error.
function invalidRequest(message: string): WorkflowTaskControlError {
  return new WorkflowTaskControlError("WORKFLOW_TASK_INVALID_REQUEST", message);
}

function configError(message: string): TypeError {
  return new TypeError(message);
}

function boundedSweepLimit(
  value: number | undefined,
  maximum: number,
  field: string,
  error: (message: string) => Error,
): number {
  // An omitted value never exceeds the cap it is checked against, so a
  // dispatcher with a small maxSweepTasks still accepts a sweep without limit.
  const normalized =
    value ?? Math.min(DEFAULT_WORKFLOW_TASK_SWEEP_LIMIT, maximum);
  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    normalized > maximum
  ) {
    throw error(
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
  try {
    return (
      error instanceof WorkflowTaskControlError &&
      (error.code === "WORKFLOW_TASK_CONFLICT" ||
        error.code === "WORKFLOW_TASK_CLAIM_CONFLICT" ||
        error.code === "WORKFLOW_TASK_LEASE_EXPIRED" ||
        error.code === "WORKFLOW_TASK_INVALID_TRANSITION" ||
        error.code === "WORKFLOW_TASK_NOT_OWNED")
    );
  } catch {
    // A host error whose prototype or code cannot be read is not contention.
    return false;
  }
}
