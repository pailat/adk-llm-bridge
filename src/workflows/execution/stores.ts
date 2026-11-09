import { isWorkflowEvent, type WorkflowEvent } from "../events.js";
import { isWorkflowIdentifier } from "../internal/identifiers.js";
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

/** Default page size for execution listings. */
export const DEFAULT_WORKFLOW_EXECUTION_LIST_LIMIT = 50;
/** Largest accepted page size for execution listings. */
export const MAX_WORKFLOW_EXECUTION_LIST_LIMIT = 500;
/** Default page size for event reads. */
export const DEFAULT_WORKFLOW_EVENT_READ_LIMIT = 100;
/** Largest accepted page size for event reads. */
export const MAX_WORKFLOW_EVENT_READ_LIMIT = 1_000;
/** Default maximum number of events kept per execution. */
export const DEFAULT_WORKFLOW_EVENTS_PER_EXECUTION = 10_000;
/** Default maximum number of events kept across all executions. */
export const DEFAULT_WORKFLOW_EVENTS_TOTAL = 100_000;

const EXECUTION_STATUSES = new Set<WorkflowExecutionStatus>([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

const EXECUTION_RECORD_FIELDS = new Set([
  "executionId",
  "workflowId",
  "workflowVersion",
  "input",
  "metadata",
  "status",
  "revision",
  "attempt",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "cancelRequestedAt",
  "output",
  "error",
]);

const EXECUTION_TRANSITIONS: Readonly<
  Record<WorkflowExecutionStatus, ReadonlySet<WorkflowExecutionStatus>>
> = {
  queued: new Set(["running", "cancelling", "cancelled"]),
  running: new Set(["cancelling", "completed", "failed", "cancelled"]),
  cancelling: new Set(["cancelled"]),
  completed: new Set(),
  failed: new Set(["queued"]),
  cancelled: new Set(["queued"]),
};

/** Capacity options for {@link InMemoryWorkflowExecutionEventStore}. */
export interface InMemoryWorkflowExecutionEventStoreConfig {
  /**
   * Maximum events kept per execution; a positive integer.
   *
   * @defaultValue 10000
   */
  maxEventsPerExecution?: number;
  /**
   * Maximum events kept across all executions; a positive integer.
   *
   * @defaultValue 100000
   */
  maxTotalEvents?: number;
}

/**
 * Durable execution record storage with revision-based compare-and-set.
 *
 * @remarks
 * Writers never overwrite blindly: `compareAndSet` succeeds only when the
 * stored `revision` equals the expected one.
 */
export interface WorkflowExecutionStore {
  /**
   * Stores a new record (revision 1, attempt 1).
   *
   * @throws {@link WorkflowExecutionControlError} with code `WORKFLOW_EXECUTION_DUPLICATE`
   * when the execution already exists.
   */
  create(record: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord>;
  /** Reads a record, or `undefined` when it does not exist. */
  get(executionId: string): Promise<WorkflowExecutionRecord | undefined>;
  /**
   * Replaces a record if its stored revision equals `expectedRevision`.
   *
   * @throws {@link WorkflowExecutionControlError} with code `WORKFLOW_EXECUTION_CONFLICT`
   * when the stored revision differs, or `WORKFLOW_EXECUTION_INVALID_TRANSITION`
   * when the status change is not allowed.
   */
  compareAndSet(
    record: WorkflowExecutionRecord,
    expectedRevision: number,
  ): Promise<WorkflowExecutionRecord>;
  /** Lists records in creation order, one page at a time. */
  list(
    request?: WorkflowExecutionListRequest,
  ): Promise<WorkflowExecutionListResult>;
}

/** Append-only, ordered event log per execution. */
export interface WorkflowExecutionEventStore {
  /** Appends an event and assigns the next sequence number. */
  append(
    executionId: string,
    event: WorkflowEvent,
  ): Promise<WorkflowExecutionEventRecord>;
  /** Reads events after the cursor. */
  read(
    request: WorkflowExecutionEventReadRequest,
  ): Promise<WorkflowExecutionEventReadResult>;
}

/**
 * Single-process {@link WorkflowExecutionStore}.
 *
 * @remarks
 * It validates records and status transitions but does not persist across
 * restarts.
 */
export class InMemoryWorkflowExecutionStore implements WorkflowExecutionStore {
  readonly #records = new Map<string, WorkflowExecutionRecord>();
  readonly #order: string[] = [];

  /** {@inheritDoc WorkflowExecutionStore.create} */
  async create(
    input: WorkflowExecutionRecord,
  ): Promise<WorkflowExecutionRecord> {
    const record = validatedRecordSnapshot(input);
    if (record.revision !== 1) invalid("Initial execution revision must be 1");
    if (record.attempt !== 1) invalid("Initial execution attempt must be 1");
    if (this.#records.has(record.executionId)) {
      throw new WorkflowExecutionControlError(
        "WORKFLOW_EXECUTION_DUPLICATE",
        `Workflow execution already exists: ${record.executionId}`,
        { executionId: record.executionId },
      );
    }
    this.#records.set(record.executionId, record);
    this.#order.push(record.executionId);
    return record;
  }

  /** {@inheritDoc WorkflowExecutionStore.get} */
  async get(executionId: string): Promise<WorkflowExecutionRecord | undefined> {
    validateExecutionId(executionId);
    return this.#records.get(executionId);
  }

  /** {@inheritDoc WorkflowExecutionStore.compareAndSet} */
  async compareAndSet(
    input: WorkflowExecutionRecord,
    expectedRevision: number,
  ): Promise<WorkflowExecutionRecord> {
    const record = validatedRecordSnapshot(input);
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
      record.executionId !== current.executionId ||
      record.workflowId !== current.workflowId ||
      record.workflowVersion !== current.workflowVersion ||
      record.createdAt !== current.createdAt ||
      !jsonEqual(record.input, current.input) ||
      !jsonEqual(record.metadata, current.metadata)
    ) {
      invalid("Execution request identity and payload are immutable");
    }
    if (!EXECUTION_TRANSITIONS[current.status].has(record.status)) {
      invalidTransition(
        record.executionId,
        `Workflow execution cannot transition from ${current.status} to ${record.status}`,
      );
    }
    const resumed =
      (current.status === "failed" || current.status === "cancelled") &&
      record.status === "queued";
    if (record.attempt !== current.attempt + (resumed ? 1 : 0)) {
      invalid("Execution attempt may only increment by one on resume");
    }
    if (record.updatedAt < current.updatedAt) {
      invalid("Execution updatedAt cannot move backwards");
    }
    if (!resumed) validateLifecycleTransition(current, record);
    this.#records.set(record.executionId, record);
    return record;
  }

  /** {@inheritDoc WorkflowExecutionStore.list} */
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

/**
 * Bounded single-process {@link WorkflowExecutionEventStore}.
 *
 * @remarks
 * Appends beyond the per-execution or total capacity are rejected with
 * `WORKFLOW_EXECUTION_CAPACITY_EXCEEDED`.
 */
export class InMemoryWorkflowExecutionEventStore
  implements WorkflowExecutionEventStore
{
  readonly #events = new Map<string, WorkflowExecutionEventRecord[]>();
  readonly #maxEventsPerExecution: number;
  readonly #maxTotalEvents: number;
  #totalEvents = 0;

  constructor(config: InMemoryWorkflowExecutionEventStoreConfig = {}) {
    if (
      !config ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.keys(config).some(
        (key) => key !== "maxEventsPerExecution" && key !== "maxTotalEvents",
      )
    ) {
      invalid("Workflow execution event store config is invalid");
    }
    this.#maxEventsPerExecution = capacityLimit(
      config.maxEventsPerExecution,
      DEFAULT_WORKFLOW_EVENTS_PER_EXECUTION,
      "maxEventsPerExecution",
    );
    this.#maxTotalEvents = capacityLimit(
      config.maxTotalEvents,
      DEFAULT_WORKFLOW_EVENTS_TOTAL,
      "maxTotalEvents",
    );
  }

  /** {@inheritDoc WorkflowExecutionEventStore.append} */
  async append(
    executionId: string,
    input: WorkflowEvent,
  ): Promise<WorkflowExecutionEventRecord> {
    validateExecutionId(executionId);
    // Copy once, then validate and store only the copy.
    const event = immutableJson(input);
    if (!isWorkflowEvent(event) || event.executionId !== executionId) {
      invalid("Workflow event executionId does not match its stream");
    }
    const stream = this.#events.get(executionId) ?? [];
    if (
      stream.length >= this.#maxEventsPerExecution ||
      this.#totalEvents >= this.#maxTotalEvents
    ) {
      throw new WorkflowExecutionControlError(
        "WORKFLOW_EXECUTION_CAPACITY_EXCEEDED",
        `Workflow execution event capacity was exceeded: ${executionId}`,
        { executionId },
      );
    }
    const record = immutableJson({
      executionId,
      sequence: stream.length + 1,
      event,
    } satisfies WorkflowExecutionEventRecord);
    if (!this.#events.has(executionId)) this.#events.set(executionId, stream);
    stream.push(record);
    this.#totalEvents++;
    return record;
  }

  /** {@inheritDoc WorkflowExecutionEventStore.read} */
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

function capacityLimit(
  requested: number | undefined,
  fallback: number,
  field: string,
): number {
  const limit = requested ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    invalid(`${field} must be a positive integer`);
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

/**
 * Validates an execution identifier.
 *
 * @remarks
 * Identifiers start with an alphanumeric character, then allow letters, digits
 * and `._:-`, up to 256 characters.
 *
 * @param executionId - Identifier to check.
 * @throws {@link WorkflowExecutionControlError} with code `WORKFLOW_EXECUTION_INVALID_REQUEST`
 * when the identifier is invalid.
 * @internal
 */
export function validateExecutionId(executionId: string): void {
  if (!isWorkflowIdentifier(executionId, "record")) {
    invalid("Workflow executionId is invalid");
  }
}

/**
 * Copies the caller's record once, then validates the copy, so a getter
 * cannot pass validation with one value and be stored with another.
 */
function validatedRecordSnapshot(
  record: WorkflowExecutionRecord,
): WorkflowExecutionRecord {
  const snapshot = immutableJson(record);
  validateRecord(snapshot);
  return snapshot;
}

function validateRecord(record: WorkflowExecutionRecord): void {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).some((key) => !EXECUTION_RECORD_FIELDS.has(key))
  ) {
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
    record.updatedAt < record.createdAt
  ) {
    invalid("Workflow execution record is invalid");
  }
  if (record.input !== undefined) immutableJson(record.input);
  if (
    record.metadata !== undefined &&
    (!record.metadata ||
      typeof record.metadata !== "object" ||
      Array.isArray(record.metadata))
  ) {
    invalid("Workflow execution metadata must be a JSON object");
  }
  if (record.metadata !== undefined) immutableJson(record.metadata);
  validateOptionalTimestamp(record.startedAt, record, "startedAt");
  validateOptionalTimestamp(record.completedAt, record, "completedAt");
  validateOptionalTimestamp(
    record.cancelRequestedAt,
    record,
    "cancelRequestedAt",
  );
  if (record.output !== undefined) immutableJson(record.output);
  if (record.error !== undefined) validateError(record.error);
  if (
    record.startedAt !== undefined &&
    record.cancelRequestedAt !== undefined &&
    record.startedAt > record.cancelRequestedAt
  ) {
    invalid("Workflow cancellation cannot precede execution start");
  }
  if (
    record.cancelRequestedAt !== undefined &&
    record.completedAt !== undefined &&
    record.cancelRequestedAt > record.completedAt
  ) {
    invalid("Workflow cancellation cannot follow execution completion");
  }

  switch (record.status) {
    case "queued":
      absent(
        record,
        "startedAt",
        "completedAt",
        "cancelRequestedAt",
        "output",
        "error",
      );
      break;
    case "running":
      requiredTimestamp(record.startedAt, "startedAt", record.status);
      absent(record, "completedAt", "cancelRequestedAt", "output", "error");
      break;
    case "cancelling":
      requiredTimestamp(
        record.cancelRequestedAt,
        "cancelRequestedAt",
        record.status,
      );
      absent(record, "completedAt", "output", "error");
      break;
    case "completed":
      requiredTimestamp(record.startedAt, "startedAt", record.status);
      requiredTimestamp(record.completedAt, "completedAt", record.status);
      absent(record, "cancelRequestedAt", "error");
      break;
    case "failed":
      requiredTimestamp(record.startedAt, "startedAt", record.status);
      requiredTimestamp(record.completedAt, "completedAt", record.status);
      if (record.error === undefined)
        invalid("Failed execution requires error");
      absent(record, "cancelRequestedAt", "output");
      break;
    case "cancelled":
      requiredTimestamp(
        record.cancelRequestedAt,
        "cancelRequestedAt",
        record.status,
      );
      requiredTimestamp(record.completedAt, "completedAt", record.status);
      if (record.error === undefined)
        invalid("Cancelled execution requires error");
      absent(record, "output");
      break;
  }
}

function validateOptionalTimestamp(
  value: number | undefined,
  record: WorkflowExecutionRecord,
  field: string,
): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) ||
      value < record.createdAt ||
      value > record.updatedAt)
  ) {
    invalid(`Workflow execution ${field} is invalid`);
  }
}

function requiredTimestamp(
  value: number | undefined,
  field: string,
  status: WorkflowExecutionStatus,
): void {
  if (value === undefined) {
    invalid(`Workflow execution ${status} requires ${field}`);
  }
}

function absent(
  record: WorkflowExecutionRecord,
  ...fields: (keyof WorkflowExecutionRecord)[]
): void {
  if (fields.some((field) => record[field] !== undefined)) {
    invalid(`Workflow execution ${record.status} has incompatible fields`);
  }
}

function validateError(error: WorkflowExecutionRecord["error"]): void {
  if (
    !error ||
    typeof error !== "object" ||
    Array.isArray(error) ||
    Object.keys(error).some(
      (key) => key !== "code" && key !== "message" && key !== "details",
    ) ||
    typeof error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code) ||
    typeof error.message !== "string" ||
    !error.message ||
    error.message.length > 4_096 ||
    (error.details !== undefined &&
      (!error.details ||
        typeof error.details !== "object" ||
        Array.isArray(error.details)))
  ) {
    invalid("Workflow execution error is invalid");
  }
  if (error.details !== undefined) immutableJson(error.details);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function validateLifecycleTransition(
  current: WorkflowExecutionRecord,
  replacement: WorkflowExecutionRecord,
): void {
  if (
    (current.startedAt !== undefined &&
      replacement.startedAt !== current.startedAt) ||
    (current.startedAt === undefined &&
      replacement.startedAt !== undefined &&
      replacement.status !== "running") ||
    (current.cancelRequestedAt !== undefined &&
      replacement.cancelRequestedAt !== current.cancelRequestedAt) ||
    (current.cancelRequestedAt === undefined &&
      replacement.cancelRequestedAt !== undefined &&
      replacement.status !== "cancelling" &&
      replacement.status !== "cancelled") ||
    (current.completedAt !== undefined &&
      replacement.completedAt !== current.completedAt)
  ) {
    invalid("Execution lifecycle timestamps cannot be rewritten");
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

function invalidTransition(executionId: string, message: string): never {
  throw new WorkflowExecutionControlError(
    "WORKFLOW_EXECUTION_INVALID_TRANSITION",
    message,
    { executionId },
  );
}
