/** JSON primitive allowed in task inputs, outputs and message payloads. */
export type WorkflowTaskJsonPrimitive = string | number | boolean | null;
/** JSON-serializable value stored in durable task records and mailboxes. */
export type WorkflowTaskJsonValue =
  | WorkflowTaskJsonPrimitive
  | { readonly [key: string]: WorkflowTaskJsonValue }
  | readonly WorkflowTaskJsonValue[];

/**
 * Lifecycle state of a durable task.
 *
 * @remarks
 * `queued` and `running` are active, `cancelling` means a cancellation was
 * requested while a worker may still own the attempt, and `completed`,
 * `failed` and `cancelled` are terminal.
 */
export type WorkflowTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

/** Serializable durable reference. It intentionally contains no Promise or closure. */
export interface WorkflowTaskHandle {
  /** Id of the workflow execution the task belongs to. */
  executionId: string;
  /** Id of the task, unique within its execution. */
  taskId: string;
}

/**
 * Codes the task controller and dispatcher themselves record or report.
 *
 * @remarks
 * - `WORKFLOW_TASK_DRIVER_FAILED`: the task driver threw an error whose `code`
 *   is missing, blank or not a string (longer codes are cut to 256
 *   characters, not replaced).
 * - `WORKFLOW_TASK_CANCELLED`: the task was cancelled.
 * - `WORKFLOW_TASK_DISPATCH_FAILED`: a sweep could not dispatch a task and
 *   the error had no usable string `code` (reported in the sweep result).
 *
 * Any other recorded code is the `code` of the error that was thrown.
 */
export type WorkflowTaskRecordErrorCode =
  | "WORKFLOW_TASK_DRIVER_FAILED"
  | "WORKFLOW_TASK_CANCELLED"
  | "WORKFLOW_TASK_DISPATCH_FAILED";

/** Serializable error recorded on a failed task. */
export interface WorkflowTaskError {
  /**
   * A {@link WorkflowTaskRecordErrorCode}, or the `code` of the error that
   * was thrown.
   */
  code: string;
  /** Human-readable description of the failure. */
  message: string;
  /** JSON-safe context for the failure, such as ids or limits. */
  details?: Readonly<Record<string, WorkflowTaskJsonValue>>;
}

/**
 * Durable ownership of one running task attempt.
 *
 * Claims provide fencing for at-least-once execution. They do not make agent
 * effects exactly-once: drivers must keep externally visible effects
 * idempotent because an expired attempt may have executed before recovery.
 */
export interface WorkflowTaskClaim {
  /** Id of the worker that owns the attempt. */
  workerId: string;
  /** Id of the lease; with `fencingToken` it identifies this claim. */
  leaseId: string;
  /**
   * Per-task counter that increases on every claim; rejects writes from a replaced worker.
   */
  fencingToken: number;
  /** Epoch milliseconds at which the claim was taken. */
  claimedAt: number;
  /** Epoch milliseconds of the last lease renewal. */
  heartbeatAt: number;
  /**
   * Epoch milliseconds after which the lease may be recovered by another worker.
   */
  expiresAt: number;
}

/** Serializable ownership authority captured when a task is spawned. */
export interface WorkflowTaskOrchestrationGrant {
  /** Id of the ownership grant that authorized the task. */
  readonly grantId: string;
  /** Fencing token of the grant at the moment the task was spawned. */
  readonly fencingToken: number;
}

/**
 * Immutable link from a task to the plan revision and ownership grants that
 * authorized it. Runtime agent or host handles intentionally do not belong
 * here.
 */
export interface WorkflowTaskOrchestrationBinding {
  /** Revision of the plan that authorized the task. */
  readonly planRevision: number;
  /** Ownership grants captured when the task was spawned. */
  readonly ownership: readonly WorkflowTaskOrchestrationGrant[];
  /** Lifetime child budget derived from the active plan, never from agent JSON. */
  readonly maxChildren?: number;
}

/**
 * Durable record of one task in a workflow execution.
 *
 * @remarks
 * `revision` increases on every store write and is the compare-and-set token
 * used by transitions. `attempt` counts claims of the task.
 */
export interface WorkflowTaskRecord extends WorkflowTaskHandle {
  /** Id of the parent task, absent for a root task. */
  parentTaskId?: string;
  /** Id of the agent that runs the task. */
  agentId: string;
  /** Current lifecycle state. */
  status: WorkflowTaskStatus;
  /** Compare-and-set token; starts at 1 and increases on every store write. */
  revision: number;
  /**
   * Attempt number; starts at 1 and increases when an expired lease is
   * requeued or the task is resumed.
   */
  attempt: number;
  /** Epoch milliseconds at which the task was created. */
  createdAt: number;
  /** Epoch milliseconds of the last write. */
  updatedAt: number;
  /** Epoch milliseconds at which the current attempt was claimed or started. */
  startedAt?: number;
  /** Epoch milliseconds at which the task reached a terminal state. */
  completedAt?: number;
  /** Epoch milliseconds at which cancellation was requested. */
  cancelRequestedAt?: number;
  /** Present only while a durable worker owns the running attempt. */
  claim?: WorkflowTaskClaim;
  /**
   * Authority binding derived at spawn by an orchestrated controller. Without
   * an authority port, it is the caller's unverified hint, or absent.
   */
  orchestration?: WorkflowTaskOrchestrationBinding;
  /** JSON input handed to the driver. */
  input?: WorkflowTaskJsonValue;
  /** JSON output produced by the driver, set on completion. */
  output?: WorkflowTaskJsonValue;
  /** Failure recorded when the task fails or is cancelled. */
  error?: WorkflowTaskError;
}

/**
 * Request to create a task.
 *
 * @remarks
 * With an orchestrated controller, `operationId` is the idempotency key for
 * the root spawn, and `orchestration` is only a hint: the authority port
 * derives the real binding.
 */
export interface WorkflowTaskSpawnRequest extends WorkflowTaskHandle {
  /** Idempotency key for the spawn; repeating it returns the original task. */
  operationId?: string;
  /** Id of the parent task, absent for a root task. */
  parentTaskId?: string;
  /** Id of the agent that runs the task. */
  agentId: string;
  /** Untrusted hint; an orchestrated controller derives the real binding. */
  orchestration?: WorkflowTaskOrchestrationBinding;
  /** JSON input handed to the driver. */
  input?: WorkflowTaskJsonValue;
}

/** Request to resume a task from its durable checkpoint. */
export interface WorkflowTaskResumeRequest extends WorkflowTaskHandle {
  /** Explicit acknowledgement that the driver resumes from durable state. */
  strategy: "checkpoint";
}

/** Filter and pagination options for listing the tasks of one execution. */
export interface WorkflowTaskListRequest {
  /** Execution whose tasks are listed. */
  executionId: string;
  /** Only tasks with this parent. */
  parentTaskId?: string;
  /** Only tasks run by this agent. */
  agentId?: string;
  /** Only tasks in this state. */
  status?: WorkflowTaskStatus;
  /** Opaque cursor returned as `nextCursor` by a previous page. */
  cursor?: string;
  /**
   * Page size.
   *
   * @defaultValue 50, at most 500
   */
  limit?: number;
}

/** One page of task records and the cursor for the next page. */
export interface WorkflowTaskListResult {
  /** Records of the page, in creation order. */
  records: readonly WorkflowTaskRecord[];
  /** Cursor for the next page; absent on the last page. */
  nextCursor?: string;
}

/** Request by a worker to claim a queued task for a lease period. */
export interface WorkflowTaskClaimRequest extends WorkflowTaskHandle {
  /** Id of the claiming worker. */
  workerId: string;
  /** Id of the new lease. */
  leaseId: string;
  /** Lease length in milliseconds, counted from the claim time. */
  leaseDurationMs: number;
  /** Optional read revision used to reject a stale dispatcher. */
  expectedRevision?: number;
}

/**
 * Identity of a claim, checked by every write made on behalf of the worker.
 *
 * @remarks
 * The `fencingToken` rejects writes from a worker whose lease was replaced.
 */
export interface WorkflowTaskClaimGuard extends WorkflowTaskHandle {
  /** Id of the worker that owns the claim. */
  workerId: string;
  /** Id of the lease being used. */
  leaseId: string;
  /** Fencing token of the claim. */
  fencingToken: number;
}

/** Request to extend the lease of a running claim. */
export interface WorkflowTaskRenewClaimRequest extends WorkflowTaskClaimGuard {
  /** Revision the caller last read; a different stored revision is rejected. */
  expectedRevision: number;
  /** New lease length in milliseconds, counted from the renewal time. */
  leaseDurationMs: number;
}

/**
 * Terminal or intermediate transition written by the claim owner.
 *
 * @remarks
 * The store applies `record` only if `expectedRevision` and `claim` still match.
 */
export interface WorkflowTaskClaimedTransitionRequest {
  /** Replacement record; its revision must be `expectedRevision + 1`. */
  record: WorkflowTaskRecord;
  /** Revision the caller last read; a different stored revision is rejected. */
  expectedRevision: number;
  /** Claim identity that must still own the task. */
  claim: WorkflowTaskClaimGuard;
}

/** Request to return a task with an expired lease to the queue. */
export interface WorkflowTaskRequeueExpiredRequest extends WorkflowTaskHandle {
  /** Revision the caller last read; a different stored revision is rejected. */
  expectedRevision: number;
}

/** Administrative cancellation intent; it never transfers worker ownership. */
export interface WorkflowTaskCancellationRequest extends WorkflowTaskHandle {
  /** Idempotency key for the cancellation request. */
  operationId?: string;
  /** Revision the caller last read; a different stored revision is rejected. */
  expectedRevision: number;
}

/** Store-authoritative recovery of an expired cancelling attempt. */
export interface WorkflowTaskCancelExpiredClaimRequest
  extends WorkflowTaskHandle {
  /** Revision the caller last read; a different stored revision is rejected. */
  expectedRevision: number;
}

/** Request to append a message to a task mailbox. */
export interface WorkflowTaskMessageAppendRequest extends WorkflowTaskHandle {
  /** Task that sent the message, absent for a host message. */
  senderTaskId?: string;
  /** JSON message body. */
  payload: WorkflowTaskJsonValue;
}

/** Mailbox message with the sequence number assigned by the store. */
export interface WorkflowTaskMessage extends WorkflowTaskMessageAppendRequest {
  /** Position in the mailbox; starts at 1 and increases by one per message. */
  sequence: number;
  /** Epoch milliseconds at which the message was appended. */
  sentAt: number;
}

/**
 * Read position in a task mailbox; messages after `afterSequence` are unread.
 */
export interface WorkflowTaskMessageCursor extends WorkflowTaskHandle {
  /** Sequence of the last message already read; 0 means none. */
  afterSequence: number;
}

/** Request to read a page of mailbox messages after a cursor. */
export interface WorkflowTaskMessageReadRequest extends WorkflowTaskHandle {
  /** Where to resume; omitted reads from the start of the mailbox. */
  cursor?: WorkflowTaskMessageCursor;
  /**
   * Page size.
   *
   * @defaultValue 100, at most 1000
   */
  limit?: number;
}

/** Mailbox page, the cursor to continue from and whether more messages exist. */
export interface WorkflowTaskMessageReadResult {
  /** Messages of the page, in sequence order. */
  messages: readonly WorkflowTaskMessage[];
  /** Cursor positioned after the last returned message. */
  cursor: WorkflowTaskMessageCursor;
  /** Whether more messages exist after `cursor`. */
  hasMore: boolean;
}

/** Child task requested by a running driver through `spawn`. */
export interface WorkflowTaskDriverChildRequest {
  /** Idempotency key for the child spawn. */
  operationId?: string;
  /** Id of the child task. */
  taskId: string;
  /** Id of the agent that runs the child. */
  agentId: string;
  /** JSON input handed to the child. */
  input?: WorkflowTaskJsonValue;
}

/** Mailbox message requested by a running driver through `send`. */
export interface WorkflowTaskDriverSendRequest {
  /** Idempotency key for the send. */
  operationId?: string;
  /** Id of the recipient task, in the sender's execution. */
  taskId: string;
  /** JSON message body. */
  payload: WorkflowTaskJsonValue;
}

/**
 * Input and control surface handed to a {@link WorkflowTaskDriver}.
 *
 * @remarks
 * Every operation runs under the driver's claim, so the task controller can
 * fence it against the live parent authority.
 */
export interface WorkflowTaskDriverRequest {
  /** Record of the attempt being run. */
  task: WorkflowTaskRecord;
  /** Aborts when the attempt is cancelled or loses its claim. */
  signal: AbortSignal;
  /** Whether the attempt resumes a task that already ran. */
  resumed: boolean;
  /** Spawns a child task under this task. */
  spawn(request: WorkflowTaskDriverChildRequest): Promise<WorkflowTaskHandle>;
  /** Appends a message to another task's mailbox. */
  send(request: WorkflowTaskDriverSendRequest): Promise<WorkflowTaskMessage>;
  /** Reads this task's mailbox without waiting. */
  readMailbox(
    request?: Pick<WorkflowTaskMessageReadRequest, "cursor" | "limit">,
  ): Promise<WorkflowTaskMessageReadResult>;
  /** Cancelable long-poll bound to this driver's AbortSignal. */
  waitForMailbox(
    request?: Pick<WorkflowTaskMessageReadRequest, "cursor" | "limit">,
  ): Promise<WorkflowTaskMessageReadResult>;
  /** Waits until the task is terminal and returns its record. */
  join(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord>;
  /** Waits until any of the tasks is terminal and returns it. */
  awaitAny(
    handles: readonly WorkflowTaskHandle[],
  ): Promise<WorkflowTaskAwaitAnyResult>;
  /** Requests cancellation of a task and returns its record. */
  cancel(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord>;
}

/** Result of a driver run; `output` becomes the task output. */
export interface WorkflowTaskDriverResult {
  /** JSON output stored on the task; omitted stores none. */
  output?: WorkflowTaskJsonValue;
}

/** Host-injected task executor. Provider delivery is intentionally out of scope. */
export interface WorkflowTaskDriver {
  /** Runs the task to completion, honoring `request.signal`. */
  execute(
    request: WorkflowTaskDriverRequest,
  ): Promise<WorkflowTaskDriverResult>;
}

/** The first task of a set that reached a terminal state. */
export interface WorkflowTaskAwaitAnyResult {
  /** Handle of the task that finished first. */
  handle: WorkflowTaskHandle;
  /** Terminal record of that task. */
  record: WorkflowTaskRecord;
}

/**
 * Store command that atomically creates a root task with its derived authority.
 */
export interface WorkflowTaskCreateRootCommand {
  /** Idempotency key for the command. */
  operationId: string;
  /** Spawn request as submitted by the host. */
  request: WorkflowTaskSpawnRequest;
  /** Binding derived by WorkflowTaskAuthorityPort, never copied from a hint. */
  authority: WorkflowTaskOrchestrationBinding;
}

/** Store command that creates a child task fenced by the claimed parent. */
export interface WorkflowTaskCreateChildCommand {
  /** Idempotency key for the command. */
  operationId: string;
  /** Claim of the parent task that issues the command. */
  parentClaim: WorkflowTaskClaimGuard;
  /** Product stores must fence this against live parent authority atomically. */
  expectedParentAuthority: WorkflowTaskOrchestrationBinding;
  /** Child to create. */
  request: WorkflowTaskDriverChildRequest;
  /** Binding derived by WorkflowTaskAuthorityPort from the claimed parent. */
  authority: WorkflowTaskOrchestrationBinding;
}

/** Store command that appends a message fenced by the claimed parent. */
export interface WorkflowTaskAppendFromClaimCommand {
  /** Idempotency key for the command. */
  operationId: string;
  /** Claim of the sending task. */
  parentClaim: WorkflowTaskClaimGuard;
  /** Product stores must fence this against live parent authority atomically. */
  expectedParentAuthority: WorkflowTaskOrchestrationBinding;
  /** Message to append. */
  request: WorkflowTaskDriverSendRequest;
}

/** Store command that cancels a target task fenced by the claimed parent. */
export interface WorkflowTaskCancelFromClaimCommand {
  /** Idempotency key for the command. */
  operationId: string;
  /** Claim of the cancelling task. */
  parentClaim: WorkflowTaskClaimGuard;
  /** Product stores must fence this against live parent authority atomically. */
  expectedParentAuthority: WorkflowTaskOrchestrationBinding;
  /** Task to cancel; must belong to the parent's execution. */
  target: WorkflowTaskHandle;
}

/** Error codes thrown by the task controller and stores. */
export type WorkflowTaskControlErrorCode =
  | "WORKFLOW_TASK_INVALID_REQUEST"
  | "WORKFLOW_TASK_NOT_FOUND"
  | "WORKFLOW_TASK_DUPLICATE"
  | "WORKFLOW_TASK_CONFLICT"
  | "WORKFLOW_TASK_CLAIM_CONFLICT"
  | "WORKFLOW_TASK_LEASE_EXPIRED"
  | "WORKFLOW_TASK_INVALID_TRANSITION"
  | "WORKFLOW_TASK_NOT_OWNED"
  | "WORKFLOW_TASK_MAILBOX_FULL"
  | "WORKFLOW_TASK_DELEGATION_LIMIT"
  | "WORKFLOW_TASK_WAIT_ABORTED";

/**
 * Error thrown by the task controller and stores.
 *
 * @remarks
 * Branch on `code`; `details` holds JSON-safe context such as the task id.
 */
export class WorkflowTaskControlError extends Error {
  /** Machine-readable error code. */
  readonly code: WorkflowTaskControlErrorCode;
  /** JSON-safe context such as execution and task ids. */
  readonly details?: Readonly<Record<string, WorkflowTaskJsonValue>>;

  constructor(
    code: WorkflowTaskControlErrorCode,
    message: string,
    details?: Readonly<Record<string, WorkflowTaskJsonValue>>,
  ) {
    super(message);
    this.name = "WorkflowTaskControlError";
    this.code = code;
    this.details = details;
  }
}
