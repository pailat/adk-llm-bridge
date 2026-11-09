import {
  authorizeWorkflowActor,
  DENY_ALL_WORKFLOW_AUTHORIZER,
  unauthorized,
  type WorkflowActorContext,
  type WorkflowAuthorizationOperation,
  type WorkflowAuthorizer,
} from "./authorization.js";
import {
  WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
  WORKFLOW_ORCHESTRATION_STATE_VERSION,
  type WorkflowActorPermission,
  type WorkflowActorRole,
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "./contracts.js";
import {
  immutableWorkflowOrchestrationJson,
  snapshotWorkflowPlan,
  workflowMutationReservations,
} from "./json.js";
import type {
  WorkflowOrchestrationStateStore,
  WorkflowPlanStore,
} from "./stores.js";

/** Dependencies and options for {@link WorkflowPlanController}. */
export interface WorkflowPlanControllerConfig {
  /** Store plan revisions are written to and read from. */
  plans: WorkflowPlanStore;
  /** Store holding the orchestration state that activation updates by compare-and-set. */
  state: WorkflowOrchestrationStateStore;
  /** Mandatory host authentication/authorization boundary for every call. */
  authorizer: WorkflowAuthorizer;
  /**
   * Additional host authority for the first plan revision and activation.
   * Omitting it denies bootstrap, preventing a candidate plan from granting
   * authority to the principal submitting that same plan.
   */
  bootstrapAuthorizer?: WorkflowAuthorizer;
  /** Clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Maximum compare-and-set attempts per mutation before it fails as contended. Must be an integer from 1 to 1000. Defaults to 16. */
  maxCasRetries?: number;
}

const PLAN_MANAGEMENT_ROLES = new Set<WorkflowActorRole>([
  "architect",
  "integration",
]);

/** Authorized lifecycle for immutable workflow plans and their active revision. */
export class WorkflowPlanController {
  readonly #plans: WorkflowPlanStore;
  readonly #state: WorkflowOrchestrationStateStore;
  readonly #authorizer: WorkflowAuthorizer;
  readonly #bootstrapAuthorizer: WorkflowAuthorizer;
  readonly #now: () => number;
  readonly #maxCasRetries: number;

  constructor(config: WorkflowPlanControllerConfig) {
    if (!config?.plans || !config.state || !config.authorizer) {
      invalid(
        "Workflow plan controller requires plan and state stores plus a host authorizer",
      );
    }
    if (
      config.maxCasRetries !== undefined &&
      (!Number.isSafeInteger(config.maxCasRetries) ||
        config.maxCasRetries < 1 ||
        config.maxCasRetries > 1_000)
    ) {
      invalid("Workflow plan controller maxCasRetries is invalid");
    }
    this.#plans = config.plans;
    this.#state = config.state;
    this.#authorizer = config.authorizer;
    this.#bootstrapAuthorizer =
      config.bootstrapAuthorizer ?? DENY_ALL_WORKFLOW_AUTHORIZER;
    this.#now = config.now ?? Date.now;
    this.#maxCasRetries = config.maxCasRetries ?? 16;
  }

  /**
   * Persists a ready plan revision.
   *
   * @remarks
   * Revision 1 needs the bootstrap authorizer. Later revisions must be exactly
   * one above the latest, keep its base revision, and be authorized by the
   * latest plan, which must already be the active one. A candidate plan thus
   * never grants authority to the principal that submits it.
   *
   * @param planValue - Plan to store; its status must be `ready`.
   * @param actor - Host-authenticated actor.
   * @returns The stored, frozen plan.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
   * when the plan is invalid or not `ready`, or
   * `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` when the actor is not authorized.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_REVISION_CONFLICT`
   * when the revision is not contiguous, the base revision changed, or the
   * latest plan is not active, and `WORKFLOW_PLAN_STALE` when the revision is
   * not above the latest.
   */
  async put(
    planValue: WorkflowPlan,
    actor: WorkflowActorContext,
  ): Promise<WorkflowPlan> {
    const plan = snapshotWorkflowPlan(planValue);
    if (plan.status !== "ready") {
      invalid("Only ready workflow plans can be persisted");
    }
    const revisions = await this.#plans.list(plan.executionId);
    const latest = revisions.at(-1);
    if (!latest) {
      if (plan.planRevision !== 1) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_PLAN_REVISION_CONFLICT",
          "The first workflow plan revision must be 1",
          { executionId: plan.executionId, planRevision: plan.planRevision },
        );
      }
      await this.#authorizeBootstrap(actor, "plan.put", plan);
      return await this.#plans.put(plan);
    }

    if (plan.planRevision <= latest.planRevision) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_STALE",
        `Workflow plan revision is stale: ${plan.executionId}@${plan.planRevision}`,
        {
          executionId: plan.executionId,
          planRevision: plan.planRevision,
          latestPlanRevision: latest.planRevision,
        },
      );
    }
    if (plan.planRevision !== latest.planRevision + 1) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_REVISION_CONFLICT",
        "Workflow plan revisions must be contiguous",
        {
          executionId: plan.executionId,
          planRevision: plan.planRevision,
          latestPlanRevision: latest.planRevision,
        },
      );
    }
    if (plan.baseRevision !== latest.baseRevision) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_REVISION_CONFLICT",
        "Workflow plan revisions must describe the same base revision",
        {
          executionId: plan.executionId,
          planRevision: plan.planRevision,
          baseRevision: plan.baseRevision,
          expectedBaseRevision: latest.baseRevision,
        },
      );
    }
    const current = await this.#state.get(plan.executionId);
    if (
      !current?.activePlanRevision ||
      current.activePlanRevision !== latest.planRevision
    ) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_REVISION_CONFLICT",
        "The latest workflow plan must be active before it can authorize a revision",
        {
          executionId: plan.executionId,
          latestPlanRevision: latest.planRevision,
          ...(current?.activePlanRevision === undefined
            ? {}
            : { activePlanRevision: current.activePlanRevision }),
        },
      );
    }
    await this.#authorizeAgainstPlan(
      actor,
      "plan.put",
      "plan:activate",
      latest,
      PLAN_MANAGEMENT_ROLES,
    );
    return await this.#plans.put(plan);
  }

  /**
   * Reads one plan revision.
   *
   * @param executionId - Execution the plan belongs to.
   * @param planRevision - Revision to read.
   * @param actor - Host-authenticated actor.
   * @returns The stored plan.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_NOT_FOUND`
   * when the revision does not exist, `WORKFLOW_ORCHESTRATION_UNAUTHORIZED`
   * when the actor may not read it, or `WORKFLOW_PLAN_STALE` when the actor
   * is bound to a revision older than the active plan.
   */
  async get(
    executionId: string,
    planRevision: number,
    actor: WorkflowActorContext,
  ): Promise<WorkflowPlan> {
    const state = await this.#state.get(executionId);
    await this.#authorizeHost(
      actor,
      "plan.get",
      "plan:read",
      executionId,
      planRevision,
      state?.activePlanRevision,
    );
    const plan = await this.#requiredPlan(executionId, planRevision);
    this.#assertPlanPolicy(actor, plan, "plan:read");
    return plan;
  }

  /**
   * Lists the plan revisions the actor is allowed to read.
   *
   * @remarks
   * An actor bound to a plan revision sees only that revision.
   *
   * @param executionId - Execution to list plans for.
   * @param actor - Host-authenticated actor.
   * @returns Readable plan revisions in ascending order.
   */
  async list(
    executionId: string,
    actor: WorkflowActorContext,
  ): Promise<readonly WorkflowPlan[]> {
    const authenticated = await this.#authorizeHost(
      actor,
      "plan.list",
      "plan:read",
      executionId,
    );
    const plans = await this.#plans.list(executionId);
    const boundRevision = authenticated.identity.planRevision;
    return Object.freeze(
      plans.filter(
        (plan) =>
          (boundRevision === undefined ||
            plan.planRevision === boundRevision) &&
          hasPlanPermission(authenticated, plan, "plan:read"),
      ),
    );
  }

  /**
   * Makes a plan revision the active one, creating the orchestration state on
   * first use.
   *
   * @remarks
   * The state update is a compare-and-set retried up to `maxCasRetries` times.
   * The first activation must be revision 1 and needs the bootstrap authorizer.
   *
   * @param executionId - Execution to activate the plan for.
   * @param planRevision - Revision to activate; its status must be `ready`.
   * @param actor - Host-authenticated actor.
   * @returns The updated orchestration state.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_NOT_FOUND`
   * when the revision does not exist.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`
   * when the plan is not `ready`, or `WORKFLOW_ORCHESTRATION_UNAUTHORIZED`
   * when the actor is not authorized.
   */
  async activate(
    executionId: string,
    planRevision: number,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOrchestrationState> {
    const plan = await this.#requiredPlan(executionId, planRevision);
    if (plan.status !== "ready") invalid("Only ready plans can be activated");

    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const current = await this.#state.get(executionId);
      if (!current) {
        if (planRevision !== 1) {
          throw new WorkflowOrchestrationControlError(
            "WORKFLOW_PLAN_REVISION_CONFLICT",
            "The first active workflow plan revision must be 1",
            { executionId, planRevision },
          );
        }
        await this.#authorizeBootstrap(actor, "plan.activate", plan);
        try {
          return await this.#state.create(
            immutableWorkflowOrchestrationJson({
              protocol: WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
              version: WORKFLOW_ORCHESTRATION_STATE_VERSION,
              executionId,
              revision: 1,
              activePlanRevision: planRevision,
              nextFencingToken: 1,
              grants: [],
              proposals: [],
              reservations: [],
              updatedAt: this.#timestamp(),
            } satisfies WorkflowOrchestrationState),
          );
        } catch (error) {
          if (hasCode(error, "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE")) {
            continue;
          }
          throw error;
        }
      }

      if (current.activePlanRevision === undefined) {
        invalid("Existing orchestration state requires an active plan");
      }
      const activePlan = await this.#requiredPlan(
        executionId,
        current.activePlanRevision,
      );
      await this.#authorizeAgainstPlan(
        actor,
        "plan.activate",
        "plan:activate",
        activePlan,
        PLAN_MANAGEMENT_ROLES,
      );
      if (current.activePlanRevision === planRevision) return current;
      if (current.activePlanRevision > planRevision) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_PLAN_STALE",
          `Cannot activate an older workflow plan: ${executionId}@${planRevision}`,
          {
            executionId,
            planRevision,
            activePlanRevision: current.activePlanRevision,
          },
        );
      }
      if (planRevision !== current.activePlanRevision + 1) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_PLAN_REVISION_CONFLICT",
          "Workflow plan activation must advance exactly one revision",
          {
            executionId,
            planRevision,
            activePlanRevision: current.activePlanRevision,
          },
        );
      }
      const latest = (await this.#plans.list(executionId)).at(-1);
      if (latest?.planRevision !== planRevision) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_PLAN_STALE",
          "Only the latest workflow plan revision can be activated",
          {
            executionId,
            planRevision,
            latestPlanRevision: latest?.planRevision ?? 0,
          },
        );
      }
      const now = this.#timestamp(current.updatedAt);
      const activeReservations = workflowMutationReservations(current).filter(
        (reservation) =>
          (reservation.status === "reserved" && reservation.expiresAt > now) ||
          (reservation.phase === "commit" &&
            reservation.status === "completed"),
      );
      if (activeReservations.length > 0) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_MUTATION_RESERVATION_ACTIVE",
          "Active mutation reservations block workflow plan activation",
          {
            executionId,
            planRevision,
            reservationIds: activeReservations.map(
              (reservation) => reservation.reservationId,
            ),
          },
        );
      }
      try {
        return await this.#state.compareAndSet(
          immutableWorkflowOrchestrationJson({
            ...current,
            revision: current.revision + 1,
            activePlanRevision: planRevision,
            grants: [],
            proposals: [],
            reservations: [],
            updatedAt: now,
          } satisfies WorkflowOrchestrationState),
          current.revision,
        );
      } catch (error) {
        if (hasCode(error, "WORKFLOW_PLAN_REVISION_CONFLICT")) continue;
        throw error;
      }
    }
    throw new WorkflowOrchestrationControlError(
      "WORKFLOW_PLAN_REVISION_CONFLICT",
      `Workflow plan activation remained contended: ${executionId}`,
      { executionId, planRevision },
    );
  }

  async #authorizeBootstrap(
    actor: WorkflowActorContext,
    operation: "plan.put" | "plan.activate",
    plan: WorkflowPlan,
  ): Promise<void> {
    await authorizeWorkflowActor(this.#authorizer, actor, {
      operation,
      permission: "plan:activate",
      executionId: plan.executionId,
      planRevision: plan.planRevision,
    });
    await authorizeWorkflowActor(this.#bootstrapAuthorizer, actor, {
      operation,
      permission: "plan:activate",
      executionId: plan.executionId,
      planRevision: plan.planRevision,
    });
  }

  async #authorizeHost(
    actor: WorkflowActorContext,
    operation: WorkflowAuthorizationOperation,
    permission: WorkflowActorPermission,
    executionId: string,
    planRevision?: number,
    activePlanRevision?: number,
  ): Promise<WorkflowActorContext> {
    return await authorizeWorkflowActor(
      this.#authorizer,
      actor,
      {
        operation,
        permission,
        executionId,
        ...(planRevision === undefined ? {} : { planRevision }),
      },
      activePlanRevision === undefined ? {} : { activePlanRevision },
    );
  }

  async #authorizeAgainstPlan(
    actor: WorkflowActorContext,
    operation: WorkflowAuthorizationOperation,
    permission: WorkflowActorPermission,
    authorityPlan: WorkflowPlan,
    roles?: ReadonlySet<WorkflowActorRole>,
  ): Promise<void> {
    await this.#authorizeHost(
      actor,
      operation,
      permission,
      authorityPlan.executionId,
      authorityPlan.planRevision,
      // Every authority plan is the active plan of its execution.
      authorityPlan.planRevision,
    );
    this.#assertPlanPolicy(actor, authorityPlan, permission, roles);
  }

  #assertPlanPolicy(
    actor: WorkflowActorContext,
    plan: WorkflowPlan,
    permission: WorkflowActorPermission,
    roles?: ReadonlySet<WorkflowActorRole>,
  ): void {
    if (!hasPlanPermission(actor, plan, permission, roles)) {
      unauthorized("Workflow plan policy does not authorize this actor");
    }
  }

  async #requiredPlan(
    executionId: string,
    planRevision: number,
  ): Promise<WorkflowPlan> {
    const plan = await this.#plans.get(executionId, planRevision);
    if (!plan) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Workflow plan was not found: ${executionId}@${planRevision}`,
        { executionId, planRevision },
      );
    }
    return plan;
  }

  #timestamp(floor = 0): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      invalid("Workflow plan controller clock returned an invalid timestamp");
    }
    return Math.max(value, floor);
  }
}

function hasPlanPermission(
  actor: WorkflowActorContext,
  plan: WorkflowPlan,
  permission: WorkflowActorPermission,
  roles?: ReadonlySet<WorkflowActorRole>,
): boolean {
  const identity = actor.identity;
  const agent = plan.agents.find(
    (candidate) => candidate.agentId === identity.agentId,
  );
  if (!agent?.policy.permissions.includes(permission)) return false;
  if (roles && !roles.has(agent.policy.role)) return false;
  if (identity.taskId === undefined) return true;
  return plan.lanes.some(
    (lane) =>
      lane.taskId === identity.taskId &&
      lane.agentId === identity.agentId &&
      lane.role === agent.policy.role,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof WorkflowOrchestrationControlError && error.code === code
  );
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
