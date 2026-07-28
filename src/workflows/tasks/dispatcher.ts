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
}

export interface WorkflowTaskSweepResult {
  inspected: number;
  outcomes: readonly WorkflowTaskDispatchOutcome[];
  failures: readonly WorkflowTaskDispatchFailure[];
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
    const records = await this.#candidates(request.executionId, limit);
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
    });
  }

  async #candidates(
    executionId: string,
    limit: number,
  ): Promise<readonly WorkflowTaskRecord[]> {
    const records: WorkflowTaskRecord[] = [];
    for (const status of ["queued", "running", "cancelling"] as const) {
      const remaining = limit - records.length;
      if (remaining === 0) break;
      const listed = await this.#controller.list({
        executionId,
        status,
        limit: remaining,
      });
      records.push(...listed.records);
    }
    return records;
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
    Object.keys(request).some((key) => key !== "executionId" && key !== "limit")
  ) {
    throw new TypeError("Workflow task sweep request is invalid");
  }
  validateIdentifier(request.executionId, "executionId");
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
