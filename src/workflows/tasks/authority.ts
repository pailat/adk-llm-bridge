/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  WorkflowTaskClaim,
  WorkflowTaskClaimGuard,
  WorkflowTaskDriverChildRequest,
  WorkflowTaskOrchestrationBinding,
  WorkflowTaskRecord,
  WorkflowTaskSpawnRequest,
} from "./contracts.js";

export interface WorkflowTaskRootAuthorityRequest<TCapability = unknown> {
  /** Opaque authenticated host capability; never serialize it into a task. */
  capability: TCapability;
  /** orchestration is an untrusted client hint at this boundary. */
  request: WorkflowTaskSpawnRequest;
}

export interface WorkflowTaskChildAuthorityRequest {
  parent: WorkflowTaskRecord & { readonly claim: WorkflowTaskClaim };
  parentClaim: WorkflowTaskClaimGuard;
  request: WorkflowTaskDriverChildRequest;
}

export interface WorkflowTaskAttemptAuthorityRequest {
  task: WorkflowTaskRecord;
  claim: WorkflowTaskClaimGuard;
}

export interface WorkflowTaskSenderAuthorityRequest<TActor = unknown> {
  /** Opaque authenticated host actor; never serialize it into a task. */
  actor: TActor;
  sender: WorkflowTaskRecord;
}

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

export type WorkflowTaskControlAccess =
  | "self-spawn"
  | "self-send"
  | "self-read"
  | "self-or-manager"
  | "manager";

export interface WorkflowTaskControlAuthorityRequest<TActor = unknown> {
  /** Opaque host-authenticated actor; never accepted from JSON. */
  actor: TActor;
  operation: WorkflowTaskControlOperation;
  access: WorkflowTaskControlAccess;
  executionId: string;
  taskIds: readonly string[];
}

/** Authorization port for JSON/control-plane task reads and host mutations. */
export interface WorkflowTaskControlAccessPort<TActor = unknown> {
  authorizeControl(
    request: WorkflowTaskControlAuthorityRequest<TActor>,
  ): Promise<void>;
}

/** Host-neutral authority boundary. It derives authority instead of trusting hints. */
export interface WorkflowTaskAuthorityPort<
  TCapability = unknown,
  TActor = unknown,
> {
  resolveRoot(
    request: WorkflowTaskRootAuthorityRequest<TCapability>,
  ): Promise<WorkflowTaskOrchestrationBinding>;
  deriveChild(
    request: WorkflowTaskChildAuthorityRequest,
  ): Promise<WorkflowTaskOrchestrationBinding>;
  validateAttempt(request: WorkflowTaskAttemptAuthorityRequest): Promise<void>;
  validateAuthenticatedSender(
    request: WorkflowTaskSenderAuthorityRequest<TActor>,
  ): Promise<void>;
}
