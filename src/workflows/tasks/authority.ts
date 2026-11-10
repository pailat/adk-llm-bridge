import type {
  WorkflowTaskClaim,
  WorkflowTaskClaimGuard,
  WorkflowTaskDriverChildRequest,
  WorkflowTaskOrchestrationBinding,
  WorkflowTaskRecord,
  WorkflowTaskSpawnRequest,
} from "./contracts.js";

/** Input to {@link WorkflowTaskAuthorityPort.resolveRoot}. */
export interface WorkflowTaskRootAuthorityRequest<TCapability = unknown> {
  /** Opaque authenticated host capability; never serialize it into a task. */
  capability: TCapability;
  /** orchestration is an untrusted client hint at this boundary. */
  request: WorkflowTaskSpawnRequest;
}

/**
 * Input to {@link WorkflowTaskAuthorityPort.deriveChild}, taken from the claimed parent.
 */
export interface WorkflowTaskChildAuthorityRequest {
  /** Running parent task that holds the claim. */
  parent: WorkflowTaskRecord & { readonly claim: WorkflowTaskClaim };
  /** Claim identity of the parent. */
  parentClaim: WorkflowTaskClaimGuard;
  /** Child the parent asks to create. */
  request: WorkflowTaskDriverChildRequest;
}

/**
 * Input to {@link WorkflowTaskAuthorityPort.validateAttempt}: the claimed attempt to check.
 */
export interface WorkflowTaskAttemptAuthorityRequest {
  /** Task whose attempt is checked. */
  task: WorkflowTaskRecord;
  /** Claim identity of the attempt. */
  claim: WorkflowTaskClaimGuard;
}

/** Input to {@link WorkflowTaskAuthorityPort.validateAuthenticatedSender}. */
export interface WorkflowTaskSenderAuthorityRequest<TActor = unknown> {
  /** Opaque authenticated host actor; never serialize it into a task. */
  actor: TActor;
  /** Task record of the claimed sender. */
  sender: WorkflowTaskRecord;
}

/**
 * Control-plane operation names passed to {@link WorkflowTaskControlAccessPort}.
 */
export type WorkflowTaskControlOperation =
  | "task.spawn"
  | "task.mailbox.send"
  | "task.status"
  | "task.join"
  | "task.awaitAny"
  | "task.mailbox.read"
  | "task.mailbox.wait"
  | "task.cancel"
  | "task.resume"
  | "task.dispatch"
  | "task.recover"
  | "task.sweep"
  | "task.list";

/**
 * Access class an operation needs.
 *
 * @remarks
 * `self-*` values require the actor to be the task itself, `self-or-manager`
 * also accepts a manager, and `manager` requires management authority.
 */
export type WorkflowTaskControlAccess =
  | "self-spawn"
  | "self-send"
  | "self-read"
  | "self-or-manager"
  | "manager";

/** Authorization query for one control-plane operation on a set of tasks. */
export interface WorkflowTaskControlAuthorityRequest<TActor = unknown> {
  /** Opaque host-authenticated actor; never accepted from JSON. */
  actor: TActor;
  /** Operation being authorized. */
  operation: WorkflowTaskControlOperation;
  /** Access class the operation needs. */
  access: WorkflowTaskControlAccess;
  /** Execution that owns the tasks. */
  executionId: string;
  /** Ids of the tasks the operation touches. */
  taskIds: readonly string[];
}

/** Authorization port for JSON/control-plane task reads and host mutations. */
export interface WorkflowTaskControlAccessPort<TActor = unknown> {
  /**
   * Rejects when the actor may not perform the operation on the tasks.
   *
   * @throws Rejects with the host's authorization error when access is denied.
   */
  authorizeControl(
    request: WorkflowTaskControlAuthorityRequest<TActor>,
  ): Promise<void>;
}

/** Host-neutral authority boundary. It derives authority instead of trusting hints. */
export interface WorkflowTaskAuthorityPort<
  TCapability = unknown,
  TActor = unknown,
> {
  /** Derives the binding for a root task from the host capability. */
  resolveRoot(
    request: WorkflowTaskRootAuthorityRequest<TCapability>,
  ): Promise<WorkflowTaskOrchestrationBinding>;
  /** Derives a child binding from the claimed parent's live authority. */
  deriveChild(
    request: WorkflowTaskChildAuthorityRequest,
  ): Promise<WorkflowTaskOrchestrationBinding>;
  /** Rejects when the claimed attempt no longer holds live authority. */
  validateAttempt(request: WorkflowTaskAttemptAuthorityRequest): Promise<void>;
  /** Rejects when the actor is not the running sender task. */
  validateAuthenticatedSender(
    request: WorkflowTaskSenderAuthorityRequest<TActor>,
  ): Promise<void>;
}
