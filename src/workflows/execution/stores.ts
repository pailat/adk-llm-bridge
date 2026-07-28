/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { isWorkflowEvent, type WorkflowEvent } from "../events.js";
import {
  WorkflowExecutionControlError,
  type WorkflowExecutionEventReadRequest,
  type WorkflowExecutionEventReadResult,
  type WorkflowExecutionEventRecord,
  type WorkflowExecutionListRequest,
  type WorkflowExecutionListResult,
  type WorkflowExecutionRecord,
  type WorkflowExecutionStatus,
} from "./contracts.js";
import { immutableJson } from "./json.js";

export const DEFAULT_WORKFLOW_EXECUTION_LIST_LIMIT = 50;
export const MAX_WORKFLOW_EXECUTION_LIST_LIMIT = 500;
export const DEFAULT_WORKFLOW_EVENT_READ_LIMIT = 100;
export const MAX_WORKFLOW_EVENT_READ_LIMIT = 1_000;

const EXECUTION_STATUSES = new Set<WorkflowExecutionStatus>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export interface WorkflowExecutionStore {
  create(record: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  get(executionId: string): Promise<WorkflowExecutionRecord | undefined>;
  compareAndSet(
    record: WorkflowExecutionRecord,
    expectedRevision: number,
  ): Promise<WorkflowExecutionRecord>;
  list(
    request?: WorkflowExecutionListRequest,
  ): Promise<WorkflowExecutionListResult>;
}

export interface WorkflowExecutionEventStore {
  append(
    executionId: string,
    event: WorkflowEvent,
  ): Promise<WorkflowExecutionEventRecord>;
  read(
    request: WorkflowExecutionEventReadRequest,
  ): Promise<WorkflowExecutionEventReadResult>;
}

export class InMemoryWorkflowExecutionStore implements WorkflowExecutionStore {
  readonly #records = new Map<string, WorkflowExecutionRecord>();
  readonly #order: string[] = [];

  async create(
    record: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    validateRecord(record);
    if (record.revision !== 1) invalid("Initial execution revision must be 1");
    if (this.#records.has(record.executionId)) {
      throw new WorkflowExecutionControlError(
        "WORKFLOW_EXECUTION_DUPLICATE",
        `Workflow execution already exists: ${record.executionId}`,
        { executionId: record.executionId },
      );
    }
    const snapshot = immutableJson(record);
    this.#records.set(record.executionId, snapshot);
    this.#order.push(record.executionId);
    return snapshot;
  }

  async get(executionId: string): Promise<WorkflowExecutionRecord | undefined> {
    validateExecutionId(executionId);
    return this.#records.get(executionId);
  }

  async compareAndSet(
    record: WorkflowExecutionRecord,
    expectedRevision: number,
  ): Promise<WorkflowExecutionRecord> {
    validateRecord(record);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      invalid("Expected execution revision must be a positive integer");
    }
    const current = this.#records.get(record.executionId);
    if (!current) notFound(record.executionId);
    if (current.revision !== expectedRevision) {
      throw new WorkflowExecutionControlError(
        "WORKFLOW_EXECUTION_CONFLICT",
        `Workflow execution revision conflict: ${record.executionId}`,
        {
          executionId: record.executionId,
          expectedRevision,
          actualRevision: current.revision,
        },
      );
    }
    if (record.revision !== expectedRevision + 1) {
      invalid("Replacement execution revision must increment by one");
    }
    if (
      record.workflowId !== current.workflowId ||
      record.workflowVersion !== current.workflowVersion ||
      record.createdAt !== current.createdAt
    ) {
      invalid("Execution identity fields are immutable");
    }
    const snapshot = immutableJson(record);
    this.#records.set(record.executionId, snapshot);
    return snapshot;
  }

  async list(
    request: WorkflowExecutionListRequest = {},
  ): Promise<WorkflowExecutionListResult> {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) => key !== "status" && key !== "cursor" && key !== "limit",
      ) ||
      (request.status !== undefined &&
        !EXECUTION_STATUSES.has(request.status)) ||
      (request.cursor !== undefined && typeof request.cursor !== "string")
    ) {
      invalid("Workflow execution list request is invalid");
    }
    const limit = boundedLimit(
      request.limit,
      DEFAULT_WORKFLOW_EXECUTION_LIST_LIMIT,
      MAX_WORKFLOW_EXECUTION_LIST_LIMIT,
      "execution list",
    );
    const offset = decodeListCursor(request.cursor, this.#order.length);
    const records: WorkflowExecutionRecord[] = [];
    let index = offset;
    for (; index < this.#order.length && records.length < limit; index++) {
      const record = this.#records.get(this.#order[index] as string);
      if (record && (!request.status || record.status === request.status)) {
        records.push(record);
      }
    }
    const hasMore = this.#order.slice(index).some((executionId) => {
      const record = this.#records.get(executionId);
      return Boolean(
        record && (!request.status || record.status === request.status),
      );
    });
    return Object.freeze({
      records: Object.freeze(records),
      ...(hasMore ? { nextCursor: encodeListCursor(index) } : {}),
    });
  }
}

export class InMemoryWorkflowExecutionEventStore
  implements WorkflowExecutionEventStore
{
  readonly #events = new Map<string, WorkflowExecutionEventRecord[]>();

  async append(
    executionId: string,
    event: WorkflowEvent,
  ): Promise<WorkflowExecutionEventRecord> {
    validateExecutionId(executionId);
    if (!isWorkflowEvent(event) || event.executionId !== executionId) {
      invalid("Workflow event executionId does not match its stream");
    }
    const stream = this.#events.get(executionId) ?? [];
    const record = immutableJson({
      executionId,
      sequence: stream.length + 1,
      event,
    } satisfies WorkflowExecutionEventRecord);
    if (!this.#events.has(executionId)) this.#events.set(executionId, stream);
    stream.push(record);
    return record;
  }

  async read(
    request: WorkflowExecutionEventReadRequest,
  ): Promise<WorkflowExecutionEventReadResult> {
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) => key !== "executionId" && key !== "cursor" && key !== "limit",
      )
    ) {
      invalid("Workflow event read request is invalid");
    }
    validateExecutionId(request.executionId);
    const limit = boundedLimit(
      request.limit,
      DEFAULT_WORKFLOW_EVENT_READ_LIMIT,
      MAX_WORKFLOW_EVENT_READ_LIMIT,
      "event read",
    );
    if (request.cursor) {
      if (
        typeof request.cursor !== "object" ||
        Array.isArray(request.cursor) ||
        Object.keys(request.cursor).some(
          (key) => key !== "executionId" && key !== "afterSequence",
        ) ||
        request.cursor.executionId !== request.executionId
      ) {
        invalid("Workflow event cursor belongs to a different execution");
      }
    }
    const afterSequence = request.cursor?.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      invalid("Workflow event cursor sequence must be a non-negative integer");
    }
    const stream = this.#events.get(request.executionId) ?? [];
    if (afterSequence > stream.length) {
      invalid("Workflow event cursor is beyond the end of the stream");
    }
    const events = stream.slice(afterSequence, afterSequence + limit);
    const lastSequence = events.at(-1)?.sequence ?? afterSequence;
    return Object.freeze({
      events: Object.freeze(events),
      cursor: Object.freeze({
        executionId: request.executionId,
        afterSequence: lastSequence,
      }),
      hasMore: stream.length > lastSequence,
    });
  }
}

function boundedLimit(
  requested: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const limit = requested ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) {
    invalid(`${field} limit must be between 1 and ${maximum}`);
  }
  return limit;
}

function encodeListCursor(offset: number): string {
  return `workflow-executions:v1:${offset}`;
}

function decodeListCursor(cursor: string | undefined, size: number): number {
  if (cursor === undefined) return 0;
  const match = /^workflow-executions:v1:(\d+)$/u.exec(cursor);
  const offset = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    invalid("Workflow execution list cursor is invalid");
  }
  return offset;
}

export function validateExecutionId(executionId: string): void {
  if (
    typeof executionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(executionId)
  ) {
    invalid("Workflow executionId is invalid");
  }
}

function validateRecord(record: WorkflowExecutionRecord): void {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    invalid("Workflow execution record must be an object");
  }
  validateExecutionId(record.executionId);
  if (
    typeof record.workflowId !== "string" ||
    !record.workflowId.trim() ||
    record.workflowId !== record.workflowId.trim() ||
    record.workflowId.length > 256 ||
    typeof record.workflowVersion !== "string" ||
    !record.workflowVersion.trim() ||
    record.workflowVersion !== record.workflowVersion.trim() ||
    record.workflowVersion.length > 256 ||
    !EXECUTION_STATUSES.has(record.status) ||
    !Number.isSafeInteger(record.revision) ||
    record.revision <= 0 ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt <= 0 ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt < 0 ||
    !Number.isFinite(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    invalid("Workflow execution record is invalid");
  }
}

function notFound(executionId: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_NOT_FOUND",
    `Workflow execution was not found: ${executionId}`,
    { executionId },
  );
}

function invalid(message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_REQUEST",
    message,
  );
}
