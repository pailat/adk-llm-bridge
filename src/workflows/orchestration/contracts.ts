import { freezeJson } from "../internal/immutable-json.js";
/** Protocol identifier carried by every {@link WorkflowPlan}. */
export const WORKFLOW_PLAN_PROTOCOL = "adk-llm-bridge/workflow-plan" as const;
/** Schema version of {@link WorkflowPlan}. */
export const WORKFLOW_PLAN_VERSION = 1 as const;
/** Protocol identifier carried by every {@link WorkflowOrchestrationState}. */
export const WORKFLOW_ORCHESTRATION_STATE_PROTOCOL =
  "adk-llm-bridge/workflow-orchestration-state" as const;
/** Schema version of {@link WorkflowOrchestrationState}. */
export const WORKFLOW_ORCHESTRATION_STATE_VERSION = 1 as const;

/** JSON primitive allowed in plans and orchestration state. */
export type WorkflowOrchestrationJsonPrimitive =
  | string
  | number
  | boolean
  | null;
/** JSON-serializable value stored in plans and orchestration state. */
export type WorkflowOrchestrationJsonValue =
  | WorkflowOrchestrationJsonPrimitive
  | { readonly [key: string]: WorkflowOrchestrationJsonValue }
  | readonly WorkflowOrchestrationJsonValue[];

/**
 * Role of a plan agent; each role is limited to the permissions its policy lists.
 */
export type WorkflowActorRole =
  | "architect"
  | "worker"
  | "integration"
  | "critic";

/**
 * Permission an agent policy may grant.
 *
 * @remarks
 * Controllers check these before plan activation, task, ownership and
 * integration operations.
 */
export type WorkflowActorPermission =
  | "plan:read"
  | "plan:activate"
  | "task:spawn"
  | "task:mailbox:send"
  | "task:read"
  | "task:cancel"
  | "task:manage"
  | "ownership:claim"
  | "ownership:propose"
  | "ownership:approve"
  | "ownership:transfer"
  | "ownership:release"
  | "changes:validate"
  | "integration:publish";

/** Declarative authorization only. Runtime/provider identities stay host-owned. */
export interface WorkflowActorPolicy {
  /** Role the agent plays in the plan. */
  role: WorkflowActorRole;
  /** Permissions the agent holds; operations outside this list are denied. */
  permissions: readonly WorkflowActorPermission[];
  /** Whether the agent may spawn child tasks. */
  canDelegate: boolean;
  /** Roles of the child lanes this agent may delegate to; delegation to any other role is denied. */
  allowedDelegateRoles?: readonly WorkflowActorRole[];
  /** Maximum number of child tasks the agent may spawn. */
  maxChildren?: number;
}

/** A logical agent definition; it intentionally has no provider or host handle. */
export interface WorkflowPlanAgent {
  /** Stable identifier lanes use to reference this agent. */
  agentId: string;
  /** Authorization policy the agent runs under. */
  policy: WorkflowActorPolicy;
  /** Optional JSON-safe annotations; they carry no authority. */
  metadata?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>;
}

/**
 * Repository-relative path claimed by a lane or grant.
 *
 * @remarks
 * `subtree` also covers every descendant path of `path`.
 */
export interface WorkflowPathClaim {
  /** Repository-relative path being claimed. */
  path: string;
  /** Whether the claim covers only `path` or also every descendant. */
  scope: "exact" | "subtree";
}

/** Rule the plan states must hold, with the component that enforces it. */
export interface WorkflowPlanInvariant {
  /** Stable identifier of the invariant within the plan. */
  invariantId: string;
  /** Human-readable statement of the rule. */
  description: string;
  /** Area of the workflow the rule constrains. */
  appliesTo: "workflow" | "ownership" | "changes" | "integration";
  /** Component responsible for enforcing the rule. */
  enforcedBy: "control-plane" | "driver" | "host";
}

/**
 * One unit of planned work, owned by one agent.
 *
 * @remarks
 * `ownedPaths` are claimed exclusively, `mayCreateUnder` lists directories where
 * the lane may create new files, and `dependsOn` lists the lanes this lane
 * depends on. Ordering is not enforced by the control plane: the host's
 * dispatcher decides when lanes run.
 */
export interface WorkflowPlanLane {
  /** Identifier of the task this lane describes. */
  taskId: string;
  /** Plan agent that owns the lane. */
  agentId: string;
  /** Role the owning agent plays in this lane. */
  role: WorkflowActorRole;
  /** Paths the lane claims exclusively. */
  ownedPaths: readonly WorkflowPathClaim[];
  /** Directories under which the lane may create new files. */
  mayCreateUnder: readonly string[];
  /**
   * Lanes this lane depends on; each must sit in an earlier wave, and a
   * delegating parent must be listed here. Ordering is not enforced: the
   * host's dispatcher decides when lanes run.
   */
  dependsOn: readonly string[];
  /**
   * Acceptance criteria for the lane's result, as text; recorded for agents
   * and hosts, not evaluated by the control plane.
   */
  acceptance: readonly string[];
}

/** Group of lane task ids in one step of the plan's dependency order. */
export interface WorkflowPlanWave {
  /** Identifier of the wave within the plan. */
  waveId: string;
  /** Lane task ids in this wave. */
  taskIds: readonly string[];
}

/**
 * Immutable, JSON-neutral architecture and ownership plan. A new revision is a
 * new record; activation belongs to WorkflowOrchestrationState.
 */
export interface WorkflowPlan {
  /** Protocol identifier; always {@link WORKFLOW_PLAN_PROTOCOL}. */
  protocol: typeof WORKFLOW_PLAN_PROTOCOL;
  /** Schema version; always {@link WORKFLOW_PLAN_VERSION}. */
  version: typeof WORKFLOW_PLAN_VERSION;
  /** Execution the plan belongs to. */
  executionId: string;
  /** Positive revision number; each revision is a separate immutable record. */
  planRevision: number;
  /** Repository revision the plan was made against. */
  baseRevision: string;
  /** What the plan is meant to achieve. */
  objective: string;
  /** Whether the plan is still a draft or ready to activate. */
  status: "draft" | "ready";
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Agents the plan defines. */
  agents: readonly WorkflowPlanAgent[];
  /** Lanes of work, one per task. */
  lanes: readonly WorkflowPlanLane[];
  /** Groups of lanes in dependency order; a lane's dependencies sit in earlier waves. */
  waves: readonly WorkflowPlanWave[];
  /** Rules that must hold while the plan runs. */
  invariants: readonly WorkflowPlanInvariant[];
  /** Paths reserved for integration lanes; any other lane that overlaps them is rejected. */
  reservedPaths: readonly WorkflowPathClaim[];
}

/**
 * Live exclusive ownership of paths by one task.
 *
 * @remarks
 * `fencingToken` increases with each grant; authority checks compare it to
 * reject stale holders.
 */
export interface WorkflowOwnershipGrant {
  /** Unique identifier of the grant. */
  grantId: string;
  /** Task that holds the grant. */
  taskId: string;
  /** Agent that runs the holding task. */
  agentId: string;
  /** Plan revision the grant was issued under. */
  planRevision: number;
  /** Monotonic token issued with the grant; a holder presenting an older token is stale. */
  fencingToken: number;
  /** Paths the grant covers. */
  claims: readonly WorkflowPathClaim[];
  /** Time the grant was issued, in epoch milliseconds. */
  grantedAt: number;
}

/** Kind of ownership change a proposal requests. */
export type WorkflowOwnershipProposalKind = "claim" | "transfer" | "release";
/** Decision state of an ownership proposal. */
export type WorkflowOwnershipProposalStatus =
  | "pending"
  | "approved"
  | "rejected";

/** Request to claim, transfer or release path ownership, pending a decision. */
export interface WorkflowOwnershipProposal {
  /** Unique identifier of the proposal. */
  proposalId: string;
  /** Change the proposal requests. */
  kind: WorkflowOwnershipProposalKind;
  /** Task that submitted the proposal. */
  requestedByTaskId: string;
  /** Task that would receive the paths, for a transfer. */
  targetTaskId?: string;
  /** Grant that would be transferred or released. */
  sourceGrantId?: string;
  /** Plan revision the proposal applies to. */
  planRevision: number;
  /** Paths the proposal concerns. */
  claims: readonly WorkflowPathClaim[];
  /** Decision state of the proposal. */
  status: WorkflowOwnershipProposalStatus;
  /** Submission time in epoch milliseconds. */
  createdAt: number;
  /** Decision time in epoch milliseconds; set once the proposal is decided. */
  decidedAt?: number;
  /** Task that approved or rejected the proposal. */
  decidedByTaskId?: string;
  /** Optional explanation recorded with the decision. */
  reason?: string;
}

/** Host mutation step a reservation authorizes. */
export type WorkflowMutationReservationPhase = "commit" | "integration";
/** Lifecycle state of a mutation reservation. */
export type WorkflowMutationReservationStatus =
  | "reserved"
  | "completed"
  | "released"
  | "expired";

/** Ownership grant and fencing token a reservation depends on. */
export interface WorkflowMutationReservationGrant {
  /** Identifier of the ownership grant relied on. */
  grantId: string;
  /** Fencing token the grant had when the reservation was made. */
  fencingToken: number;
}

/**
 * Durable CAS authority for a single host mutation. Receipts remain evidence;
 * this record is the right to consume that evidence once at a fenced state
 * revision. Host workspace/repository handles intentionally never appear here.
 */
export interface WorkflowMutationReservation {
  /** Unique identifier of the reservation. */
  reservationId: string;
  /** Change receipt this reservation consumes. */
  receiptId: string;
  /** Host mutation step the reservation authorizes. */
  phase: WorkflowMutationReservationPhase;
  /** Task that holds the reservation. */
  taskId: string;
  /** Agent that runs the holding task. */
  agentId: string;
  /** Plan revision the reservation was made under. */
  planRevision: number;
  /** Orchestration state revision the reservation was fenced at. */
  orchestrationRevision: number;
  /** Ownership grants, with their fencing tokens, the mutation depends on. */
  grants: readonly WorkflowMutationReservationGrant[];
  /** Digest of the change set the receipt covers. */
  changeSetDigest: string;
  /** Host tree identifier produced by the commit, when known. */
  treeId?: string;
  /** Host commit identifier, once the commit is recorded. */
  commitId?: string;
  /** Integration target identifier, for the integration phase. */
  targetId?: string;
  /** Revision of the integration target the mutation expects. */
  targetRevision?: string;
  /** Lifecycle state of the reservation. */
  status: WorkflowMutationReservationStatus;
  /** Creation time in epoch milliseconds. */
  createdAt: number;
  /** Time in epoch milliseconds after which the reservation is no longer usable. */
  expiresAt: number;
  /** Completion time in epoch milliseconds; set once the reservation is completed. */
  completedAt?: number;
}

/** CAS aggregate for plan activation and all live ownership authority. */
export interface WorkflowOrchestrationState {
  /** Protocol identifier; always {@link WORKFLOW_ORCHESTRATION_STATE_PROTOCOL}. */
  protocol: typeof WORKFLOW_ORCHESTRATION_STATE_PROTOCOL;
  /** Schema version; always {@link WORKFLOW_ORCHESTRATION_STATE_VERSION}. */
  version: typeof WORKFLOW_ORCHESTRATION_STATE_VERSION;
  /** Execution the state belongs to. */
  executionId: string;
  /** Compare-and-set revision; starts at 1 and increments by one on every write. */
  revision: number;
  /** Revision of the activated plan, or absent before activation. It never moves backwards. */
  activePlanRevision?: number;
  /** Fencing token the next grant receives. It never moves backwards. */
  nextFencingToken: number;
  /** Live ownership grants. */
  grants: readonly WorkflowOwnershipGrant[];
  /** Ownership proposals, pending and decided. */
  proposals: readonly WorkflowOwnershipProposal[];
  /** Optional on v1 reads; writers normalize it to an empty array. */
  reservations?: readonly WorkflowMutationReservation[];
  /** Time of the last write in epoch milliseconds. It never moves backwards. */
  updatedAt: number;
}

/** Error codes thrown by orchestration controllers and stores. */
export type WorkflowOrchestrationControlErrorCode =
  | "WORKFLOW_ORCHESTRATION_INVALID_REQUEST"
  | "WORKFLOW_ORCHESTRATION_UNAUTHORIZED"
  | "WORKFLOW_PLAN_NOT_FOUND"
  | "WORKFLOW_PLAN_DUPLICATE"
  | "WORKFLOW_PLAN_REVISION_CONFLICT"
  | "WORKFLOW_PLAN_STALE"
  | "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND"
  | "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE"
  | "WORKFLOW_OWNERSHIP_CONFLICT"
  | "WORKFLOW_OWNERSHIP_NOT_FOUND"
  | "WORKFLOW_OWNERSHIP_STALE"
  | "WORKFLOW_MUTATION_RESERVATION_ACTIVE"
  | "WORKFLOW_PATH_NOT_OWNED"
  | "WORKFLOW_RESERVED_PATH";

/**
 * Error thrown by orchestration controllers and stores.
 *
 * @remarks
 * Branch on `code`; `details` holds JSON-safe context such as the path or grant.
 */
export class WorkflowOrchestrationControlError extends Error {
  /** Machine-readable error code to branch on. */
  readonly code: WorkflowOrchestrationControlErrorCode;
  /** Deep-frozen JSON-safe context for the failure. */
  readonly details?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>;

  constructor(
    code: WorkflowOrchestrationControlErrorCode,
    message: string,
    details?: Readonly<Record<string, WorkflowOrchestrationJsonValue>>,
  ) {
    super(message);
    this.name = "WorkflowOrchestrationControlError";
    this.code = code;
    this.details = details === undefined ? undefined : frozenDetails(details);
  }
}

const DETAILS_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 20_000,
  maxStringLength: 1_048_576,
});

/** Deep-frozen copy of error details; a constructor must never throw. */
function frozenDetails(
  details: Readonly<Record<string, WorkflowOrchestrationJsonValue>>,
): Readonly<Record<string, WorkflowOrchestrationJsonValue>> {
  try {
    return freezeJson(details, DETAILS_LIMITS, (message) => {
      throw new TypeError(message);
    });
  } catch {
    return Object.freeze({ ...details });
  }
}
