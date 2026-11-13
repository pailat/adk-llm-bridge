import type { WorkflowEvent } from "../events.js";

/** JSON primitive allowed in execution inputs, outputs and metadata. */
export type WorkflowExecutionJsonPrimitive = string | number | boolean | null;
/** JSON-serializable value stored in durable execution records. */
export type WorkflowExecutionJsonValue =
  | WorkflowExecutionJsonPrimitive
  | { readonly [key: string]: WorkflowExecutionJsonValue }
  | readonly WorkflowExecutionJsonValue[];

/**
 * Lifecycle state of a workflow execution.
 *
 * @remarks
 * `cancelling` means cancellation was requested while a driver may still run.
 * `completed`, `failed` and `cancelled` are terminal; `failed` and `cancelled`
 * executions can be re-queued by a resume.
 */
export type WorkflowExecutionStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

/** Request to start an execution of a registered workflow version. */
export interface WorkflowExecutionRequest {
  /** Caller-chosen unique identifier of the execution (alphanumeric start, then letters, digits and `._:-`, up to 256 characters). */
  executionId: string;
  /** Identifier of the registered workflow to run (trimmed, non-empty, up to 256 characters). */
  workflowId: string;
  /** Version of the registered workflow to run (trimmed, non-empty, up to 256 characters). */
  workflowVersion: string;
  /** JSON input passed to the workflow; immutable once the execution is created. */
  input?: WorkflowExecutionJsonValue;
  /** Optional JSON object of host metadata; immutable once the execution is created. */
  metadata?: Readonly<Record<string, WorkflowExecutionJsonValue>>;
}

/**
 * Codes the execution controller itself records in
 * {@link WorkflowExecutionError.code}.
 *
 * @remarks
 * - `WORKFLOW_EXECUTION_FAILED`: the driver threw an error whose `code` is
 *   missing, not a string, longer than 128 characters, or does not match
 *   `^[A-Z][A-Z0-9_]*$`.
 * - `WORKFLOW_EXECUTION_CANCELLED`: the execution was cancelled.
 *
 * Any other recorded code is the `code` of the error the driver threw.
 */
export type WorkflowExecutionRecordErrorCode =
  | "WORKFLOW_EXECUTION_FAILED"
  | "WORKFLOW_EXECUTION_CANCELLED";

/** Serializable error recorded on a failed execution. */
export interface WorkflowExecutionError {
  /**
   * A {@link WorkflowExecutionRecordErrorCode}, or the `code` of the error
   * the driver threw.
   */
  code: string;
  /** Human-readable failure message, at most 4096 characters. */
  message: string;
  /** Optional JSON-safe context for the failure. */
  details?: Readonly<Record<string, WorkflowExecutionJsonValue>>;
}

/**
 * Durable record of one workflow execution.
 *
 * @remarks
 * `revision` increases on every store write and is the compare-and-set token.
 * `attempt` counts starts, including resumes.
 */
export interface WorkflowExecutionRecord extends WorkflowExecutionRequest {
  /** Current lifecycle state. */
  status: WorkflowExecutionStatus;
  /** Compare-and-set token; starts at 1 and increases by exactly 1 on every store write. */
  revision: number;
  /** Number of starts so far; starts at 1 and increases by 1 on each resume. */
  attempt: number;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Time of the last store write in epoch milliseconds; never moves backwards. */
  updatedAt: number;
  /** Time the current attempt started running in epoch milliseconds; unset while `queued`. */
  startedAt?: number;
  /** Time the execution reached a terminal state in epoch milliseconds. */
  completedAt?: number;
  /** Time cancellation was requested in epoch milliseconds. */
  cancelRequestedAt?: number;
  /** JSON output of a `completed` execution. */
  output?: WorkflowExecutionJsonValue;
  /** Failure recorded on a `failed` or `cancelled` execution. */
  error?: WorkflowExecutionError;
}

/** Filter and pagination options for listing executions. */
export interface WorkflowExecutionListRequest {
  /** Return only executions in this state. */
  status?: WorkflowExecutionStatus;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Page size, from 1 to 500. Defaults to 50. */
  limit?: number;
}

/** One page of execution records and the cursor for the next page. */
export interface WorkflowExecutionListResult {
  /** Records of this page in creation order. */
  records: readonly WorkflowExecutionRecord[];
  /** Cursor for the next page; absent when no further matching records exist. */
  nextCursor?: string;
}

/**
 * Read position in an execution's event log; events after `afterSequence` are unread.
 */
export interface WorkflowExecutionEventCursor {
  /** Execution whose log is read. */
  executionId: string;
  /** Sequence of the last event already read; `0` starts from the beginning. */
  afterSequence: number;
}

/** Stored workflow event with the sequence number assigned by the store. */
export interface WorkflowExecutionEventRecord {
  /** Execution the event belongs to. */
  executionId: string;
  /** Position in the execution's log, starting at 1 and increasing by 1 per event. */
  sequence: number;
  /** The stored workflow event. */
  event: WorkflowEvent;
}

/** Request to read a page of execution events after a cursor. */
export interface WorkflowExecutionEventReadRequest {
  /** Execution whose events are read. */
  executionId: string;
  /** Position to read after; omit to read from the start. Its `executionId` must match the request. */
  cursor?: WorkflowExecutionEventCursor;
  /** Page size, from 1 to 1000. Defaults to 100. */
  limit?: number;
}

/** Event page, the cursor to continue from and whether more events exist. */
export interface WorkflowExecutionEventReadResult {
  /** Events of this page in sequence order. */
  events: readonly WorkflowExecutionEventRecord[];
  /** Cursor to pass back to read the next page. */
  cursor: WorkflowExecutionEventCursor;
  /** Whether events exist beyond this page. */
  hasMore: boolean;
}

/** Request to resume a failed or cancelled execution from its checkpoints. */
export interface WorkflowExecutionResumeRequest {
  /** Execution to resume. */
  executionId: string;
  /** Explicit acknowledgement that the driver resumes from durable checkpoints. */
  strategy: "checkpoint";
}

/** Input and control surface handed to a {@link WorkflowExecutionDriver}. */
export interface WorkflowExecutionDriverRequest {
  /** Record of the execution being run, in `running` state. */
  execution: WorkflowExecutionRecord;
  /** Aborted when the execution is cancelled; the driver must stop promptly. */
  signal: AbortSignal;
  /** `true` when this run is a resume of an earlier attempt. */
  resumed: boolean;
  /**
   * Appends a workflow event to the execution's event log.
   *
   * @param event - Event for this execution, workflow id and version.
   * @throws {@link WorkflowExecutionControlError} with code `WORKFLOW_EXECUTION_INVALID_REQUEST`
   * when the event is malformed or mismatched, `WORKFLOW_EXECUTION_INVALID_TRANSITION`
   * when the run is no longer active, and `WORKFLOW_EXECUTION_CAPACITY_EXCEEDED`
   * when the event store is full.
   */
  emit(event: WorkflowEvent): Promise<void>;
}

/** Result of a driver run; `output` becomes the execution output. */
export interface WorkflowExecutionDriverResult {
  /** JSON output stored on the completed execution; omit for no output. */
  output?: WorkflowExecutionJsonValue;
}

/** Host-injected executor that runs a workflow and emits its events. */
export interface WorkflowExecutionDriver {
  /** Runs the workflow to completion, honoring `request.signal`. */
  execute(
    request: WorkflowExecutionDriverRequest,
  ): Promise<WorkflowExecutionDriverResult>;
}

/** Error codes thrown by the execution controller and stores. */
export type WorkflowExecutionControlErrorCode =
  | "WORKFLOW_EXECUTION_INVALID_REQUEST"
  | "WORKFLOW_EXECUTION_NOT_FOUND"
  | "WORKFLOW_EXECUTION_DUPLICATE"
  | "WORKFLOW_EXECUTION_CONFLICT"
  | "WORKFLOW_EXECUTION_CAPACITY_EXCEEDED"
  | "WORKFLOW_EXECUTION_INVALID_TRANSITION"
  | "WORKFLOW_EXECUTION_NOT_OWNED";

/**
 * Error thrown by the execution controller and stores.
 *
 * @remarks
 * Branch on `code`; `details` holds JSON-safe context such as the execution id.
 */
export class WorkflowExecutionControlError extends Error {
  /** Stable error code to branch on. */
  readonly code: WorkflowExecutionControlErrorCode;
  /** JSON-safe context, such as the execution id. */
  readonly details?: Readonly<Record<string, WorkflowExecutionJsonValue>>;

  constructor(
    code: WorkflowExecutionControlErrorCode,
    message: string,
    details?: Readonly<Record<string, WorkflowExecutionJsonValue>>,
  ) {
    super(message);
    this.name = "WorkflowExecutionControlError";
    this.code = code;
    this.details = details;
  }
}
