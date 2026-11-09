import { isWorkflowIdentifier } from "../internal/identifiers.js";
import {
  authorizeWorkflowActor,
  DENY_ALL_WORKFLOW_AUTHORIZER,
  unauthorized,
  type WorkflowActorContext,
  type WorkflowAuthorizationOperation,
  type WorkflowAuthorizer,
} from "./authorization.js";
import {
  type WorkflowActorPermission,
  type WorkflowActorRole,
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowOwnershipGrant,
  type WorkflowOwnershipProposal,
  type WorkflowOwnershipProposalKind,
  type WorkflowPathClaim,
  type WorkflowPlan,
  type WorkflowPlanLane,
} from "./contracts.js";
import {
  immutableWorkflowOrchestrationJson,
  validateWorkflowPath,
  workflowPathClaimsOverlap,
} from "./json.js";
import type {
  WorkflowOrchestrationStateStore,
  WorkflowPlanStore,
} from "./stores.js";

/** Dependencies and options for {@link WorkflowOwnershipController}. */
export interface WorkflowOwnershipControllerConfig {
  /** Store the active plan is read from. */
  plans: WorkflowPlanStore;
  /** Store holding the orchestration state that is updated by compare-and-set. */
  state: WorkflowOrchestrationStateStore;
  /** Host policy. Omitting it intentionally denies every operation. */
  authorizer?: WorkflowAuthorizer;
  /** Clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Generates grant and proposal ids. Defaults to a random identifier generator. */
  createId?: (kind: "grant" | "proposal") => string;
  /** Maximum compare-and-set attempts per mutation before it fails as contended. Must be an integer from 1 to 1000. Defaults to 16. */
  maxCasRetries?: number;
}

/** Execution and plan revision an ownership request applies to. */
export interface WorkflowOwnershipScope {
  /** Execution the request applies to. */
  executionId: string;
  /** Plan revision the request applies to; it must be the active revision. */
  planRevision: number;
}

/** Request to claim paths for the calling task. */
export interface WorkflowOwnershipClaimRequest extends WorkflowOwnershipScope {
  /** Paths to claim. */
  claims: readonly WorkflowPathClaim[];
}

/** Request to propose a claim, transfer or release for approval. */
export interface WorkflowOwnershipProposalRequest
  extends WorkflowOwnershipScope {
  /** Change being proposed. */
  kind: WorkflowOwnershipProposalKind;
  /** Task that would receive the paths, for a transfer. */
  targetTaskId?: string;
  /** Grant to transfer or release. */
  sourceGrantId?: string;
  /** Paths to claim, for a claim proposal. */
  claims?: readonly WorkflowPathClaim[];
}

/** Request to approve or reject a pending proposal. */
export interface WorkflowOwnershipDecisionRequest
  extends WorkflowOwnershipScope {
  /** Proposal to decide. */
  proposalId: string;
  /** Optional explanation recorded with the decision. */
  reason?: string;
}

/** Request to transfer a grant to another task. */
export interface WorkflowOwnershipTransferRequest
  extends WorkflowOwnershipScope {
  /** Grant to transfer. */
  sourceGrantId: string;
  /** Task that receives the paths. */
  targetTaskId: string;
}

/** Request to release a grant. */
export interface WorkflowOwnershipReleaseRequest
  extends WorkflowOwnershipScope {
  /** Grant to release. */
  grantId: string;
}

/**
 * Grant a task claims to hold, checked against the live ledger.
 *
 * @remarks
 * The `fencingToken` must equal the live grant's token.
 */
export interface WorkflowOwnershipAuthorityRequest
  extends WorkflowOwnershipScope {
  /** Grant the task claims to hold. */
  grantId: string;
  /** Task that must hold the grant. */
  taskId: string;
  /** Agent that must own the grant. */
  agentId: string;
  /** Fencing token the holder presents; it must equal the live grant's token. */
  fencingToken: number;
  /** Paths the grant must cover. */
  claims?: readonly WorkflowPathClaim[];
}

/** Request to validate several grants of one task in a single read. */
export interface WorkflowOwnershipAuthoritySnapshotRequest
  extends WorkflowOwnershipScope {
  /** Task that must hold every listed grant. */
  taskId: string;
  /** Agent that must own every listed grant. */
  agentId: string;
  /** Grants to validate, each with its presented fencing token and optional claims. */
  authorities: readonly Pick<
    WorkflowOwnershipAuthorityRequest,
    "grantId" | "fencingToken" | "claims"
  >[];
}

/** Validated grants and the orchestration revision they were read at. */
export interface WorkflowOwnershipAuthoritySnapshot {
  /** Orchestration state revision the grants were read at. */
  orchestrationRevision: number;
  /** Live grants that passed validation. */
  grants: readonly WorkflowOwnershipGrant[];
}

const OWNERSHIP_MANAGEMENT_ROLES = new Set<WorkflowActorRole>([
  "architect",
  "integration",
]);

/**
 * Versioned ownership authority backed by the whole orchestration-state CAS.
 * Every mutation checks the active immutable plan again before it is published.
 */
export class WorkflowOwnershipController {
  readonly #plans: WorkflowPlanStore;
  readonly #state: WorkflowOrchestrationStateStore;
  readonly #authorizer: WorkflowAuthorizer;
  readonly #now: () => number;
  readonly #createId: (kind: "grant" | "proposal") => string;
  readonly #maxCasRetries: number;

  constructor(config: WorkflowOwnershipControllerConfig) {
    if (!config?.plans || !config.state)
      invalid("Workflow ownership controller requires plan and state stores");
    if (
      config.maxCasRetries !== undefined &&
      (!Number.isSafeInteger(config.maxCasRetries) ||
        config.maxCasRetries < 1 ||
        config.maxCasRetries > 1_000)
    ) {
      invalid("Workflow ownership controller maxCasRetries is invalid");
    }
    this.#plans = config.plans;
    this.#state = config.state;
    this.#authorizer = config.authorizer ?? DENY_ALL_WORKFLOW_AUTHORIZER;
    this.#now = config.now ?? Date.now;
    this.#createId = config.createId ?? defaultId;
    this.#maxCasRetries = config.maxCasRetries ?? 16;
  }

  /**
   * Grants the calling task exclusive ownership of paths its lane may own.
   *
   * @param request - Plan scope and paths to claim.
   * @param actor - Host-authenticated actor bound to the claiming task.
   * @returns The new grant, with the next fencing token.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_OWNERSHIP_CONFLICT`
   * when a path overlaps a live grant, or `WORKFLOW_PATH_NOT_OWNED` and
   * `WORKFLOW_RESERVED_PATH` when the lane may not claim it.
   * @throws {@link WorkflowOrchestrationControlError} with code
   * `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` when the actor is not authorized,
   * or `WORKFLOW_PLAN_STALE` when the plan revision is not the active one.
   */
  async claim(
    request: WorkflowOwnershipClaimRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipGrant> {
    const claims = snapshotClaims(request.claims, true);
    const context = await this.#context(
      request,
      actor,
      "ownership.claim",
      "ownership:claim",
    );
    const lane = requiredActorLane(context.plan, actor);
    assertClaimsAllowed(context.plan, lane, claims, false);

    const grantId = this.#nextId("grant");
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const { state, plan } = await this.#active(request);
      const currentLane = requiredActorLane(plan, actor);
      assertClaimsAllowed(plan, currentLane, claims, false);
      assertAvailable(state.grants, claims);
      const grant = immutableWorkflowOrchestrationJson({
        grantId,
        taskId: currentLane.taskId,
        agentId: currentLane.agentId,
        planRevision: request.planRevision,
        fencingToken: state.nextFencingToken,
        claims,
        grantedAt: this.#timestamp(state.updatedAt),
      } satisfies WorkflowOwnershipGrant);
      try {
        await this.#replace(state, {
          grants: [...state.grants, grant],
          nextFencingToken: state.nextFencingToken + 1,
          updatedAt: grant.grantedAt,
        });
        return grant;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    return ownershipContended(request.executionId, request.planRevision);
  }

  /**
   * Creates a pending proposal to claim, transfer or release ownership.
   *
   * @param request - Plan scope, proposal kind and its targets.
   * @param actor - Host-authenticated actor.
   * @returns The pending proposal.
   */
  async propose(
    request: WorkflowOwnershipProposalRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipProposal> {
    const claims = snapshotClaims(request.claims ?? [], false);
    const context = await this.#context(
      request,
      actor,
      "ownership.propose",
      "ownership:propose",
    );
    const requester = requiredActorLane(context.plan, actor);
    validateProposalIntent(
      context.plan,
      context.state,
      requester,
      request,
      claims,
    );
    const proposalId = this.#nextId("proposal");

    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const { state, plan } = await this.#active(request);
      const currentRequester = requiredActorLane(plan, actor);
      validateProposalIntent(plan, state, currentRequester, request, claims);
      const proposal = immutableWorkflowOrchestrationJson({
        proposalId,
        kind: request.kind,
        requestedByTaskId: currentRequester.taskId,
        ...(request.targetTaskId === undefined
          ? {}
          : { targetTaskId: request.targetTaskId }),
        ...(request.sourceGrantId === undefined
          ? {}
          : { sourceGrantId: request.sourceGrantId }),
        planRevision: request.planRevision,
        claims,
        status: "pending",
        createdAt: this.#timestamp(state.updatedAt),
      } satisfies WorkflowOwnershipProposal);
      try {
        await this.#replace(state, {
          proposals: [...state.proposals, proposal],
          updatedAt: proposal.createdAt,
        });
        return proposal;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    return ownershipContended(request.executionId, request.planRevision);
  }

  /**
   * Approves a pending proposal and applies its ownership change.
   *
   * @param request - Plan scope and proposal id.
   * @param actor - Host-authenticated manager actor.
   * @returns The decided proposal.
   */
  async approve(
    request: WorkflowOwnershipDecisionRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipProposal> {
    return await this.#decide(request, actor, "approved");
  }

  /**
   * Rejects a pending proposal without changing ownership.
   *
   * @param request - Plan scope, proposal id and optional reason.
   * @param actor - Host-authenticated manager actor.
   * @returns The decided proposal.
   */
  async reject(
    request: WorkflowOwnershipDecisionRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipProposal> {
    return await this.#decide(request, actor, "rejected");
  }

  /**
   * Moves a grant to another task of the plan under a new fencing token.
   *
   * @remarks
   * The old holder's token stops validating once the transfer is published.
   *
   * @param request - Plan scope, source grant and target task.
   * @param actor - Host-authenticated manager actor.
   * @returns The new grant held by the target task.
   */
  async transfer(
    request: WorkflowOwnershipTransferRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipGrant> {
    const context = await this.#context(
      request,
      actor,
      "ownership.transfer",
      "ownership:transfer",
    );
    assertManager(context.plan, actor);

    const grantId = this.#nextId("grant");
    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const { state, plan } = await this.#active(request);
      assertManager(plan, actor);
      const source = requiredGrant(state, request.sourceGrantId);
      assertGrantNotReserved(
        state,
        source.grantId,
        this.#timestamp(state.updatedAt),
      );
      const target = requiredLane(plan, request.targetTaskId);
      assertClaimsAllowed(plan, target, source.claims, true);
      assertAvailable(state.grants, source.claims, source.grantId);
      const grant = this.#transferredGrant(
        grantId,
        source.claims,
        target,
        state,
      );
      try {
        await this.#replace(state, {
          grants: [
            ...state.grants.filter((item) => item.grantId !== source.grantId),
            grant,
          ],
          nextFencingToken: state.nextFencingToken + 1,
          updatedAt: grant.grantedAt,
        });
        return grant;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    return ownershipContended(request.executionId, request.planRevision);
  }

  /**
   * Releases a grant so its paths become available again.
   *
   * @remarks
   * A grant covered by an active mutation reservation cannot be released.
   *
   * @param request - Plan scope and grant id.
   * @param actor - Host-authenticated grant owner or manager.
   * @returns The released grant.
   */
  async release(
    request: WorkflowOwnershipReleaseRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipGrant> {
    const context = await this.#context(
      request,
      actor,
      "ownership.release",
      "ownership:release",
    );
    const initial = requiredGrant(context.state, request.grantId);
    assertGrantOwnerOrManager(context.plan, actor, initial);

    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const { state, plan } = await this.#active(request);
      const grant = requiredGrant(state, request.grantId);
      assertGrantOwnerOrManager(plan, actor, grant);
      assertGrantNotReserved(
        state,
        grant.grantId,
        this.#timestamp(state.updatedAt),
      );
      try {
        await this.#replace(state, {
          grants: state.grants.filter((item) => item.grantId !== grant.grantId),
          updatedAt: this.#timestamp(state.updatedAt),
        });
        return grant;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    return ownershipContended(request.executionId, request.planRevision);
  }

  /**
   * Reads the live orchestration state for the active plan.
   *
   * @param request - Plan scope.
   * @param actor - Host-authenticated actor with plan read permission.
   * @returns The current orchestration state.
   */
  async getCurrent(
    request: WorkflowOwnershipScope,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOrchestrationState> {
    return (await this.#context(request, actor, "ownership.list", "plan:read"))
      .state;
  }

  /**
   * Lists the live ownership grants.
   *
   * @param request - Plan scope.
   * @param actor - Host-authenticated actor with plan read permission.
   * @returns The current grants.
   */
  async list(
    request: WorkflowOwnershipScope,
    actor: WorkflowActorContext,
  ): Promise<readonly WorkflowOwnershipGrant[]> {
    return (await this.getCurrent(request, actor)).grants;
  }

  /** Validates another task's authority; the caller is still host-authenticated. */
  async validateAuthority(
    request: WorkflowOwnershipAuthorityRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipGrant> {
    const snapshot = await this.validateAuthoritySnapshot(
      {
        executionId: request.executionId,
        planRevision: request.planRevision,
        taskId: request.taskId,
        agentId: request.agentId,
        authorities: [
          {
            grantId: request.grantId,
            fencingToken: request.fencingToken,
            ...(request.claims === undefined ? {} : { claims: request.claims }),
          },
        ],
      },
      actor,
    );
    const [grant] = snapshot.grants;
    if (grant === undefined || snapshot.grants.length !== 1) {
      invalid("Workflow ownership authority snapshot must return one grant");
    }
    return grant;
  }

  /** Validates every fence against one immutable orchestration snapshot. */
  async validateAuthoritySnapshot(
    request: WorkflowOwnershipAuthoritySnapshotRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOwnershipAuthoritySnapshot> {
    if (!Array.isArray(request.authorities) || request.authorities.length === 0)
      invalid("Workflow ownership authority snapshot requires fences");
    const { state } = await this.#context(
      request,
      actor,
      "ownership.validate",
      "changes:validate",
    );
    const seen = new Set<string>();
    const grants = request.authorities.map((authority) => {
      if (seen.has(authority.grantId))
        invalid("Workflow ownership authority fences must be unique");
      seen.add(authority.grantId);
      const claims = snapshotClaims(authority.claims ?? [], false);
      const grant = requiredGrant(state, authority.grantId);
      assertAuthorityGrant(grant, request, authority.fencingToken, claims);
      return grant;
    });
    return Object.freeze({
      orchestrationRevision: state.revision,
      grants: Object.freeze(grants),
    });
  }

  async #decide(
    request: WorkflowOwnershipDecisionRequest,
    actor: WorkflowActorContext,
    status: "approved" | "rejected",
  ): Promise<WorkflowOwnershipProposal> {
    const initial = await this.#context(
      request,
      actor,
      "ownership.approve",
      "ownership:approve",
    );
    assertManager(initial.plan, actor);

    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const { state, plan } = await this.#active(request);
      assertManager(plan, actor);
      const proposal = requiredProposal(state, request.proposalId);
      if (proposal.status !== "pending") {
        if (proposal.status === status) return proposal;
        ownershipConflict(`Ownership proposal was already ${proposal.status}`);
      }
      const decidedAt = this.#timestamp(state.updatedAt);
      const decided = immutableWorkflowOrchestrationJson({
        ...proposal,
        status,
        decidedAt,
        decidedByTaskId: requiredActorLane(plan, actor).taskId,
        ...(request.reason === undefined
          ? {}
          : { reason: validReason(request.reason) }),
      } satisfies WorkflowOwnershipProposal);
      let grants = state.grants;
      let nextFencingToken = state.nextFencingToken;

      if (status === "approved") {
        const mutation = this.#applyApprovedProposal(
          plan,
          state,
          proposal,
          decidedAt,
        );
        grants = mutation.grants;
        nextFencingToken = mutation.nextFencingToken;
      }
      try {
        await this.#replace(state, {
          grants,
          proposals: state.proposals.map((item) =>
            item.proposalId === proposal.proposalId ? decided : item,
          ),
          nextFencingToken,
          updatedAt: decidedAt,
        });
        return decided;
      } catch (error) {
        if (isCasConflict(error)) continue;
        throw error;
      }
    }
    return ownershipContended(request.executionId, request.planRevision);
  }

  #applyApprovedProposal(
    plan: WorkflowPlan,
    state: WorkflowOrchestrationState,
    proposal: WorkflowOwnershipProposal,
    decidedAt: number,
  ): Pick<WorkflowOrchestrationState, "grants" | "nextFencingToken"> {
    if (proposal.kind === "release") {
      const source = requiredGrant(state, proposal.sourceGrantId as string);
      assertGrantNotReserved(state, source.grantId, decidedAt);
      return {
        grants: state.grants.filter(
          (grant) => grant.grantId !== source.grantId,
        ),
        nextFencingToken: state.nextFencingToken,
      };
    }

    const target = requiredLane(plan, proposal.targetTaskId as string);
    if (proposal.kind === "claim") {
      assertClaimsAllowed(plan, target, proposal.claims, true);
      assertAvailable(state.grants, proposal.claims);
      const grant = this.#transferredGrant(
        this.#nextId("grant"),
        proposal.claims,
        target,
        state,
        decidedAt,
      );
      return {
        grants: [...state.grants, grant],
        nextFencingToken: state.nextFencingToken + 1,
      };
    }

    const source = requiredGrant(state, proposal.sourceGrantId as string);
    assertGrantNotReserved(state, source.grantId, decidedAt);
    const claims =
      proposal.claims.length === 0 ? source.claims : proposal.claims;
    if (!sameClaims(claims, source.claims))
      invalid("Ownership transfer proposals must transfer the complete grant");
    assertClaimsAllowed(plan, target, claims, true);
    assertAvailable(state.grants, claims, source.grantId);
    const grant = this.#transferredGrant(
      this.#nextId("grant"),
      claims,
      target,
      state,
      decidedAt,
    );
    return {
      grants: [
        ...state.grants.filter((item) => item.grantId !== source.grantId),
        grant,
      ],
      nextFencingToken: state.nextFencingToken + 1,
    };
  }

  #transferredGrant(
    grantId: string,
    claims: readonly WorkflowPathClaim[],
    target: WorkflowPlanLane,
    state: WorkflowOrchestrationState,
    grantedAt = this.#timestamp(state.updatedAt),
  ): WorkflowOwnershipGrant {
    return immutableWorkflowOrchestrationJson({
      grantId,
      taskId: target.taskId,
      agentId: target.agentId,
      planRevision: state.activePlanRevision as number,
      fencingToken: state.nextFencingToken,
      claims,
      grantedAt,
    } satisfies WorkflowOwnershipGrant);
  }

  async #context(
    request: WorkflowOwnershipScope,
    actor: WorkflowActorContext,
    operation: WorkflowAuthorizationOperation,
    permission: WorkflowActorPermission,
  ): Promise<{ state: WorkflowOrchestrationState; plan: WorkflowPlan }> {
    validateScope(request);
    const activePlanRevision = (await this.#state.get(request.executionId))
      ?.activePlanRevision;
    await authorizeWorkflowActor(
      this.#authorizer,
      actor,
      {
        operation,
        permission,
        executionId: request.executionId,
        planRevision: request.planRevision,
      },
      activePlanRevision === undefined ? {} : { activePlanRevision },
    );
    const context = await this.#active(request);
    assertPlanPermission(context.plan, actor, permission);
    return context;
  }

  async #active(
    request: WorkflowOwnershipScope,
  ): Promise<{ state: WorkflowOrchestrationState; plan: WorkflowPlan }> {
    validateScope(request);
    const state = await this.#state.get(request.executionId);
    if (!state) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND",
        `Workflow orchestration state was not found: ${request.executionId}`,
        { executionId: request.executionId },
      );
    }
    if (state.activePlanRevision !== request.planRevision) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_STALE",
        `Workflow plan revision is not active: ${request.executionId}@${request.planRevision}`,
        {
          executionId: request.executionId,
          planRevision: request.planRevision,
          ...(state.activePlanRevision === undefined
            ? {}
            : { activePlanRevision: state.activePlanRevision }),
        },
      );
    }
    const plan = await this.#plans.get(
      request.executionId,
      request.planRevision,
    );
    if (!plan) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Workflow plan was not found: ${request.executionId}@${request.planRevision}`,
        {
          executionId: request.executionId,
          planRevision: request.planRevision,
        },
      );
    }
    return { state, plan };
  }

  async #replace(
    current: WorkflowOrchestrationState,
    changes: Partial<WorkflowOrchestrationState>,
  ): Promise<WorkflowOrchestrationState> {
    const updatedAt = changes.updatedAt ?? current.updatedAt;
    const reservations = (
      changes.reservations ??
      current.reservations ??
      []
    ).map((reservation) =>
      reservation.status === "reserved" && reservation.expiresAt <= updatedAt
        ? { ...reservation, status: "expired" as const }
        : reservation,
    );
    return await this.#state.compareAndSet(
      immutableWorkflowOrchestrationJson({
        ...current,
        ...changes,
        reservations,
        revision: current.revision + 1,
      }),
      current.revision,
    );
  }

  #timestamp(floor: number): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0)
      invalid(
        "Workflow ownership controller clock returned an invalid timestamp",
      );
    return Math.max(value, floor);
  }

  #nextId(kind: "grant" | "proposal"): string {
    const value = this.#createId(kind);
    identifier(value, `${kind} id`);
    return value;
  }
}

function validateScope(request: WorkflowOwnershipScope): void {
  if (!request || typeof request !== "object")
    invalid("Workflow ownership request is required");
  identifier(request.executionId, "executionId");
  if (!Number.isSafeInteger(request.planRevision) || request.planRevision <= 0)
    invalid("Workflow ownership planRevision must be positive");
}

function snapshotClaims(
  value: readonly WorkflowPathClaim[],
  requireClaims: boolean,
): readonly WorkflowPathClaim[] {
  if (!Array.isArray(value) || (requireClaims && value.length === 0))
    invalid("Workflow ownership claims are invalid");
  const claims = immutableWorkflowOrchestrationJson(value);
  for (const claim of claims) {
    if (!claim || typeof claim !== "object" || Array.isArray(claim))
      invalid("Workflow ownership claim must be an object");
    const fields = Object.keys(claim);
    if (fields.some((field) => field !== "path" && field !== "scope"))
      invalid("Workflow ownership claim contains an unknown field");
    validateWorkflowPath(claim.path);
    if (claim.scope !== "exact" && claim.scope !== "subtree")
      invalid("Workflow ownership claim scope is invalid");
  }
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      if (
        workflowPathClaimsOverlap(
          claims[left] as WorkflowPathClaim,
          claims[right] as WorkflowPathClaim,
        )
      )
        invalid("Workflow ownership request contains overlapping claims");
    }
  }
  return claims;
}

function validateProposalIntent(
  plan: WorkflowPlan,
  state: WorkflowOrchestrationState,
  requester: WorkflowPlanLane,
  request: WorkflowOwnershipProposalRequest,
  claims: readonly WorkflowPathClaim[],
): void {
  if (!(["claim", "transfer", "release"] as const).includes(request.kind))
    invalid("Workflow ownership proposal kind is invalid");
  if (request.kind === "claim") {
    if (!request.targetTaskId || request.sourceGrantId || claims.length === 0)
      invalid("Ownership claim proposals require only targetTaskId and claims");
    requiredLane(plan, request.targetTaskId);
    return;
  }
  if (
    !request.sourceGrantId ||
    (request.targetTaskId === undefined) === (request.kind === "transfer")
  ) {
    invalid(`Ownership ${request.kind} proposal fields are invalid`);
  }
  const source = requiredGrant(state, request.sourceGrantId);
  if (
    source.taskId !== requester.taskId ||
    source.agentId !== requester.agentId
  )
    unauthorized(
      "Only the current grant owner can propose its transfer or release",
    );
  if (request.kind === "transfer") {
    requiredLane(plan, request.targetTaskId as string);
    if (claims.length > 0 && !sameClaims(claims, source.claims))
      invalid("Ownership transfer proposals must transfer the complete grant");
  } else if (claims.length > 0) {
    invalid("Ownership release proposals cannot include claims");
  }
}

function assertClaimsAllowed(
  plan: WorkflowPlan,
  lane: WorkflowPlanLane,
  claims: readonly WorkflowPathClaim[],
  managerApproved: boolean,
): void {
  for (const claim of claims) {
    const reserved = plan.reservedPaths.some((item) =>
      workflowPathClaimsOverlap(item, claim),
    );
    if (reserved && !(managerApproved && lane.role === "integration")) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_RESERVED_PATH",
        `Workflow path is reserved for integration: ${claim.path}`,
        { path: claim.path, taskId: lane.taskId },
      );
    }
    // A manager-approved proposal/transfer is the explicit escape hatch for
    // dynamic ownership. Direct claims remain bounded by the immutable lane.
    if (managerApproved) continue;
    const declared = [
      ...lane.ownedPaths,
      ...lane.mayCreateUnder.map((path) => ({
        path,
        scope: "subtree" as const,
      })),
    ];
    if (!declared.some((owner) => claimContainedBy(claim, owner))) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PATH_NOT_OWNED",
        `Workflow path is outside lane ownership: ${claim.path}`,
        { path: claim.path, taskId: lane.taskId },
      );
    }
  }
}

function claimContainedBy(
  claim: WorkflowPathClaim,
  owner: WorkflowPathClaim,
): boolean {
  if (claim.path === owner.path)
    return owner.scope === "subtree" || claim.scope === "exact";
  return owner.scope === "subtree" && claim.path.startsWith(`${owner.path}/`);
}

function assertAvailable(
  grants: readonly WorkflowOwnershipGrant[],
  claims: readonly WorkflowPathClaim[],
  excludeGrantId?: string,
): void {
  const conflict = grants.find(
    (grant) =>
      grant.grantId !== excludeGrantId &&
      grant.claims.some((owned) =>
        claims.some((claim) => workflowPathClaimsOverlap(owned, claim)),
      ),
  );
  if (conflict)
    ownershipConflict(`Workflow ownership overlaps grant: ${conflict.grantId}`);
}

function assertPlanPermission(
  plan: WorkflowPlan,
  actor: WorkflowActorContext,
  permission: WorkflowActorPermission,
): void {
  const identity = actor.identity;
  const agent = plan.agents.find((item) => item.agentId === identity.agentId);
  if (!agent?.policy.permissions.includes(permission))
    unauthorized("Workflow plan policy does not authorize this actor");
  requiredActorLane(plan, actor);
}

function assertManager(plan: WorkflowPlan, actor: WorkflowActorContext): void {
  const agent = plan.agents.find(
    (item) => item.agentId === actor.identity.agentId,
  );
  if (!agent || !OWNERSHIP_MANAGEMENT_ROLES.has(agent.policy.role))
    unauthorized("Only architect and integration actors can manage ownership");
  requiredActorLane(plan, actor);
}

function assertGrantOwnerOrManager(
  plan: WorkflowPlan,
  actor: WorkflowActorContext,
  grant: WorkflowOwnershipGrant,
): void {
  const lane = requiredActorLane(plan, actor);
  const agent = plan.agents.find(
    (item) => item.agentId === actor.identity.agentId,
  );
  if (
    (grant.taskId !== lane.taskId || grant.agentId !== lane.agentId) &&
    (!agent || !OWNERSHIP_MANAGEMENT_ROLES.has(agent.policy.role))
  ) {
    unauthorized("Only the grant owner or an ownership manager can release it");
  }
}

function requiredActorLane(
  plan: WorkflowPlan,
  actor: WorkflowActorContext,
): WorkflowPlanLane {
  const identity = actor.identity;
  if (!identity.taskId)
    unauthorized("Workflow ownership operations require a task-bound actor");
  const lane = plan.lanes.find((item) => item.taskId === identity.taskId);
  if (!lane || lane.agentId !== identity.agentId)
    unauthorized("Workflow actor is not bound to the current plan lane");
  return lane;
}

function requiredLane(plan: WorkflowPlan, taskId: string): WorkflowPlanLane {
  identifier(taskId, "targetTaskId");
  const lane = plan.lanes.find((item) => item.taskId === taskId);
  if (!lane) invalid(`Workflow plan lane was not found: ${taskId}`);
  return lane;
}

function requiredGrant(
  state: WorkflowOrchestrationState,
  grantId: string,
): WorkflowOwnershipGrant {
  identifier(grantId, "grantId");
  const grant = state.grants.find((item) => item.grantId === grantId);
  if (!grant) {
    throw new WorkflowOrchestrationControlError(
      "WORKFLOW_OWNERSHIP_NOT_FOUND",
      `Workflow ownership grant was not found: ${grantId}`,
      { grantId },
    );
  }
  return grant;
}

function assertAuthorityGrant(
  grant: WorkflowOwnershipGrant,
  request: Pick<
    WorkflowOwnershipAuthoritySnapshotRequest,
    "executionId" | "planRevision" | "taskId" | "agentId"
  >,
  fencingToken: number,
  claims: readonly WorkflowPathClaim[],
): void {
  if (
    grant.planRevision !== request.planRevision ||
    grant.taskId !== request.taskId ||
    grant.agentId !== request.agentId ||
    grant.fencingToken !== fencingToken ||
    claims.some(
      (claim) => !grant.claims.some((owned) => claimContainedBy(claim, owned)),
    )
  ) {
    throw new WorkflowOrchestrationControlError(
      "WORKFLOW_OWNERSHIP_STALE",
      `Workflow ownership authority is stale: ${grant.grantId}`,
      {
        executionId: request.executionId,
        planRevision: request.planRevision,
        grantId: grant.grantId,
      },
    );
  }
}

function assertGrantNotReserved(
  state: WorkflowOrchestrationState,
  grantId: string,
  now: number,
): void {
  const reservation = (state.reservations ?? []).find(
    (candidate) =>
      ((candidate.status === "reserved" && candidate.expiresAt > now) ||
        (candidate.phase === "commit" && candidate.status === "completed")) &&
      candidate.grants.some((grant) => grant.grantId === grantId),
  );
  if (reservation) {
    throw new WorkflowOrchestrationControlError(
      "WORKFLOW_MUTATION_RESERVATION_ACTIVE",
      `Ownership grant is reserved by an active host mutation: ${grantId}`,
      { grantId, reservationId: reservation.reservationId },
    );
  }
}

function requiredProposal(
  state: WorkflowOrchestrationState,
  proposalId: string,
): WorkflowOwnershipProposal {
  identifier(proposalId, "proposalId");
  const proposal = state.proposals.find(
    (item) => item.proposalId === proposalId,
  );
  if (!proposal) {
    throw new WorkflowOrchestrationControlError(
      "WORKFLOW_OWNERSHIP_NOT_FOUND",
      `Workflow ownership proposal was not found: ${proposalId}`,
      { proposalId },
    );
  }
  return proposal;
}

function sameClaims(
  left: readonly WorkflowPathClaim[],
  right: readonly WorkflowPathClaim[],
): boolean {
  return (
    left.length === right.length &&
    left.every((claim) =>
      right.some(
        (candidate) =>
          candidate.path === claim.path && candidate.scope === claim.scope,
      ),
    )
  );
}

function validReason(reason: string): string {
  if (
    typeof reason !== "string" ||
    reason !== reason.trim() ||
    !reason ||
    reason.length > 4_096
  )
    invalid("Workflow ownership decision reason is invalid");
  return reason;
}

function identifier(value: string, field: string): void {
  if (!isWorkflowIdentifier(value, "record")) {
    invalid(`Workflow ownership ${field} is invalid`);
  }
}

function defaultId(kind: "grant" | "proposal"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

function isCasConflict(error: unknown): boolean {
  return (
    error instanceof WorkflowOrchestrationControlError &&
    error.code === "WORKFLOW_PLAN_REVISION_CONFLICT"
  );
}

function ownershipContended(executionId: string, planRevision: number): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_PLAN_REVISION_CONFLICT",
    `Workflow ownership state remained contended: ${executionId}`,
    { executionId, planRevision },
  );
}

function ownershipConflict(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_OWNERSHIP_CONFLICT",
    message,
  );
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
