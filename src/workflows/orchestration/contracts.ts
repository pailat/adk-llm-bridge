/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export const WORKFLOW_PLAN_PROTOCOL = "adk-llm-bridge/workflow-plan" as const;
export const WORKFLOW_PLAN_VERSION = 1 as const;
export const WORKFLOW_ORCHESTRATION_STATE_PROTOCOL =
  "adk-llm-bridge/workflow-orchestration-state" as const;
export const WORKFLOW_ORCHESTRATION_STATE_VERSION = 1 as const;

export type WorkflowOrchestrationJsonPrimitive =
  | string
  | number
  | boolean
  | null;
export type WorkflowOrchestrationJsonValue =
  | WorkflowOrchestrationJsonPrimitive
  | { readonly [key: string]: WorkflowOrchestrationJsonValue }
  | readonly WorkflowOrchestrationJsonValue[];

export type WorkflowActorRole =
  | "architect"
  | "worker"
  | "integration"
  | "critic";

export type WorkflowActorPermission =
  | "plan:read"
  | "plan:activate"
  | "ownership:claim"
  | "ownership:propose"
  | "ownership:approve"
  | "ownership:transfer"
  | "ownership:release"
  | "changes:validate"
  | "integration:publish";

/** Declarative authorization only. Runtime/provider identities stay host-owned. */
export interface WorkflowActorPolicy {
  role: WorkflowActorRole;
  permissions: readonly WorkflowActorPermission[];
  canDelegate: boolean;
  allowedDelegateRoles?: readonly WorkflowActorRole[];
  maxChildren?: number;
}

/** A logical agent definition; it intentionally has no provider or host handle. */
export interface WorkflowPlanAgent {
  agentId: string;
  policy: WorkflowActorPolicy;
  metadata?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>;
}

export interface WorkflowPathClaim {
  path: string;
  scope: "exact" | "subtree";
}

export interface WorkflowPlanInvariant {
  invariantId: string;
  description: string;
  appliesTo: "workflow" | "ownership" | "changes" | "integration";
  enforcedBy: "control-plane" | "driver" | "host";
}

export interface WorkflowPlanLane {
  taskId: string;
  agentId: string;
  role: WorkflowActorRole;
  ownedPaths: readonly WorkflowPathClaim[];
  mayCreateUnder: readonly string[];
  dependsOn: readonly string[];
  acceptance: readonly string[];
}

export interface WorkflowPlanWave {
  waveId: string;
  taskIds: readonly string[];
}

/**
 * Immutable, JSON-neutral architecture and ownership plan. A new revision is a
 * new record; activation belongs to WorkflowOrchestrationState.
 */
export interface WorkflowPlan {
  protocol: typeof WORKFLOW_PLAN_PROTOCOL;
  version: typeof WORKFLOW_PLAN_VERSION;
  executionId: string;
  planRevision: number;
  baseRevision: string;
  objective: string;
  status: "draft" | "ready";
  createdAt: number;
  agents: readonly WorkflowPlanAgent[];
  lanes: readonly WorkflowPlanLane[];
  waves: readonly WorkflowPlanWave[];
  invariants: readonly WorkflowPlanInvariant[];
  reservedPaths: readonly WorkflowPathClaim[];
}

export interface WorkflowOwnershipGrant {
  grantId: string;
  taskId: string;
  agentId: string;
  planRevision: number;
  fencingToken: number;
  claims: readonly WorkflowPathClaim[];
  grantedAt: number;
}

export type WorkflowOwnershipProposalKind = "claim" | "transfer" | "release";
export type WorkflowOwnershipProposalStatus =
  | "pending"
  | "approved"
  | "rejected";

export interface WorkflowOwnershipProposal {
  proposalId: string;
  kind: WorkflowOwnershipProposalKind;
  requestedByTaskId: string;
  targetTaskId?: string;
  sourceGrantId?: string;
  planRevision: number;
  claims: readonly WorkflowPathClaim[];
  status: WorkflowOwnershipProposalStatus;
  createdAt: number;
  decidedAt?: number;
  decidedByTaskId?: string;
  reason?: string;
}

/** CAS aggregate for plan activation and all live ownership authority. */
export interface WorkflowOrchestrationState {
  protocol: typeof WORKFLOW_ORCHESTRATION_STATE_PROTOCOL;
  version: typeof WORKFLOW_ORCHESTRATION_STATE_VERSION;
  executionId: string;
  revision: number;
  activePlanRevision?: number;
  nextFencingToken: number;
  grants: readonly WorkflowOwnershipGrant[];
  proposals: readonly WorkflowOwnershipProposal[];
  updatedAt: number;
}

export type WorkflowOrchestrationControlErrorCode =
  | "WORKFLOW_ORCHESTRATION_INVALID_REQUEST"
  | "WORKFLOW_PLAN_NOT_FOUND"
  | "WORKFLOW_PLAN_DUPLICATE"
  | "WORKFLOW_PLAN_REVISION_CONFLICT"
  | "WORKFLOW_PLAN_STALE"
  | "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND"
  | "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE"
  | "WORKFLOW_OWNERSHIP_CONFLICT"
  | "WORKFLOW_OWNERSHIP_NOT_FOUND"
  | "WORKFLOW_OWNERSHIP_STALE"
  | "WORKFLOW_PATH_NOT_OWNED"
  | "WORKFLOW_RESERVED_PATH";

export class WorkflowOrchestrationControlError extends Error {
  readonly code: WorkflowOrchestrationControlErrorCode;
  readonly details?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>;

  constructor(
    code: WorkflowOrchestrationControlErrorCode,
    message: string,
    details?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>,
  ) {
    super(message);
    this.name = "WorkflowOrchestrationControlError";
    this.code = code;
    this.details = details;
  }
}
