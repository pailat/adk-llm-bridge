/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export type WorkflowTaskJsonPrimitive = string | number | boolean | null;
export type WorkflowTaskJsonValue =
  | WorkflowTaskJsonPrimitive
  | { readonly [key: string]: WorkflowTaskJsonValue }
  | readonly WorkflowTaskJsonValue[];

export type WorkflowTaskStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

/** Serializable durable reference. It intentionally contains no Promise or closure. */
export interface WorkflowTaskHandle {
  executionId: string;
  taskId: string;
}

export interface WorkflowTaskError {
  code: string;
  message: string;
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
  workerId: string;
  leaseId: string;
  fencingToken: number;
  claimedAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/** Serializable ownership authority captured when a task is spawned. */
export interface WorkflowTaskOrchestrationGrant {
  readonly grantId: string;
  readonly fencingToken: number;
}

/**
 * Immutable link from a task to the plan revision and ownership grants that
 * authorized it. Runtime agent or host handles intentionally do not belong
 * here.
 */
export interface WorkflowTaskOrchestrationBinding {
  readonly planRevision: number;
  readonly ownership: readonly WorkflowTaskOrchestrationGrant[];
}

export interface WorkflowTaskRecord extends WorkflowTaskHandle {
  parentTaskId?: string;
  agentId: string;
  status: WorkflowTaskStatus;
  revision: number;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  cancelRequestedAt?: number;
  /** Present only while a durable worker owns the running attempt. */
  claim?: WorkflowTaskClaim;
  orchestration?: WorkflowTaskOrchestrationBinding;
  input?: WorkflowTaskJsonValue;
  output?: WorkflowTaskJsonValue;
  error?: WorkflowTaskError;
}

export interface WorkflowTaskSpawnRequest extends WorkflowTaskHandle {
  operationId?: string;
  parentTaskId?: string;
  agentId: string;
  orchestration?: WorkflowTaskOrchestrationBinding;
  input?: WorkflowTaskJsonValue;
}

export interface WorkflowTaskResumeRequest extends WorkflowTaskHandle {
  /** Explicit acknowledgement that the driver resumes from durable state. */
  strategy: "checkpoint";
}

export interface WorkflowTaskListRequest {
  executionId: string;
  parentTaskId?: string;
  agentId?: string;
  status?: WorkflowTaskStatus;
  cursor?: string;
  limit?: number;
}

export interface WorkflowTaskListResult {
  records: readonly WorkflowTaskRecord[];
  nextCursor?: string;
}

export interface WorkflowTaskClaimRequest extends WorkflowTaskHandle {
  workerId: string;
  leaseId: string;
  leaseDurationMs: number;
  /** Optional read revision used to reject a stale dispatcher. */
  expectedRevision?: number;
}

export interface WorkflowTaskClaimGuard extends WorkflowTaskHandle {
  workerId: string;
  leaseId: string;
  fencingToken: number;
}

export interface WorkflowTaskRenewClaimRequest extends WorkflowTaskClaimGuard {
  expectedRevision: number;
  leaseDurationMs: number;
}

export interface WorkflowTaskClaimedTransitionRequest {
  record: WorkflowTaskRecord;
  expectedRevision: number;
  claim: WorkflowTaskClaimGuard;
}

export interface WorkflowTaskRequeueExpiredRequest extends WorkflowTaskHandle {
  expectedRevision: number;
}

/** Administrative cancellation intent; it never transfers worker ownership. */
export interface WorkflowTaskCancellationRequest extends WorkflowTaskHandle {
  operationId?: string;
  expectedRevision: number;
}

/** Store-authoritative recovery of an expired cancelling attempt. */
export interface WorkflowTaskCancelExpiredClaimRequest
  extends WorkflowTaskHandle {
  expectedRevision: number;
}

export interface WorkflowTaskMessageAppendRequest extends WorkflowTaskHandle {
  senderTaskId?: string;
  payload: WorkflowTaskJsonValue;
}

export interface WorkflowTaskMessage extends WorkflowTaskMessageAppendRequest {
  sequence: number;
  sentAt: number;
}

export interface WorkflowTaskMessageCursor extends WorkflowTaskHandle {
  afterSequence: number;
}

export interface WorkflowTaskMessageReadRequest extends WorkflowTaskHandle {
  cursor?: WorkflowTaskMessageCursor;
  limit?: number;
}

export interface WorkflowTaskMessageReadResult {
  messages: readonly WorkflowTaskMessage[];
  cursor: WorkflowTaskMessageCursor;
  hasMore: boolean;
}

export interface WorkflowTaskDriverChildRequest {
  operationId?: string;
  taskId: string;
  agentId: string;
  input?: WorkflowTaskJsonValue;
}

export interface WorkflowTaskDriverSendRequest {
  operationId?: string;
  taskId: string;
  payload: WorkflowTaskJsonValue;
}

export interface WorkflowTaskDriverRequest {
  task: WorkflowTaskRecord;
  signal: AbortSignal;
  resumed: boolean;
  spawn(request: WorkflowTaskDriverChildRequest): Promise<WorkflowTaskHandle>;
  send(request: WorkflowTaskDriverSendRequest): Promise<WorkflowTaskMessage>;
  readMailbox(
    request?: Pick<WorkflowTaskMessageReadRequest, "cursor" | "limit">,
  ): Promise<WorkflowTaskMessageReadResult>;
  /** Cancelable long-poll bound to this driver's AbortSignal. */
  waitForMailbox(
    request?: Pick<WorkflowTaskMessageReadRequest, "cursor" | "limit">,
  ): Promise<WorkflowTaskMessageReadResult>;
  join(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord>;
  awaitAny(
    handles: readonly WorkflowTaskHandle[],
  ): Promise<WorkflowTaskAwaitAnyResult>;
  cancel(handle: WorkflowTaskHandle): Promise<WorkflowTaskRecord>;
}

export interface WorkflowTaskDriverResult {
  output?: WorkflowTaskJsonValue;
}

/** Host-injected task executor. Provider delivery is intentionally out of scope. */
export interface WorkflowTaskDriver {
  execute(
    request: WorkflowTaskDriverRequest,
  ): Promise<WorkflowTaskDriverResult>;
}

export interface WorkflowTaskAwaitAnyResult {
  handle: WorkflowTaskHandle;
  record: WorkflowTaskRecord;
}

export interface WorkflowTaskCreateRootCommand {
  operationId: string;
  request: WorkflowTaskSpawnRequest;
  /** Binding derived by WorkflowTaskAuthorityPort, never copied from a hint. */
  authority: WorkflowTaskOrchestrationBinding;
}

export interface WorkflowTaskCreateChildCommand {
  operationId: string;
  parentClaim: WorkflowTaskClaimGuard;
  request: WorkflowTaskDriverChildRequest;
  /** Binding derived by WorkflowTaskAuthorityPort from the claimed parent. */
  authority: WorkflowTaskOrchestrationBinding;
}

export interface WorkflowTaskAppendFromClaimCommand {
  operationId: string;
  parentClaim: WorkflowTaskClaimGuard;
  request: WorkflowTaskDriverSendRequest;
}

export interface WorkflowTaskCancelFromClaimCommand {
  operationId: string;
  parentClaim: WorkflowTaskClaimGuard;
  target: WorkflowTaskHandle;
}

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
  | "WORKFLOW_TASK_WAIT_ABORTED";

export class WorkflowTaskControlError extends Error {
  readonly code: WorkflowTaskControlErrorCode;
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
