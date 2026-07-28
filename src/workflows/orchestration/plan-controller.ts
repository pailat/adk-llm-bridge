/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  authorizeWorkflowActor,
  DENY_ALL_WORKFLOW_AUTHORIZER,
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
  validateWorkflowPlan,
} from "./json.js";
import type {
  WorkflowOrchestrationStateStore,
  WorkflowPlanStore,
} from "./stores.js";

export interface WorkflowPlanControllerConfig {
  plans: WorkflowPlanStore;
  state: WorkflowOrchestrationStateStore;
  /** Host policy. Omitting it intentionally denies every operation. */
  authorizer?: WorkflowAuthorizer;
  now?: () => number;
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
  readonly #now: () => number;
  readonly #maxCasRetries: number;

  constructor(config: WorkflowPlanControllerConfig) {
    if (!config?.plans || !config.state) {
      invalid("Workflow plan controller requires plan and state stores");
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
    this.#authorizer = config.authorizer ?? DENY_ALL_WORKFLOW_AUTHORIZER;
    this.#now = config.now ?? Date.now;
    this.#maxCasRetries = config.maxCasRetries ?? 16;
  }

  async put(
    planValue: WorkflowPlan,
    actor: WorkflowActorContext,
  ): Promise<WorkflowPlan> {
    validateWorkflowPlan(planValue);
    if (planValue.status !== "ready") {
      invalid("Only ready workflow plans can be persisted");
    }
    const plan = immutableWorkflowOrchestrationJson(planValue);
    await this.#authorizePlan(
      actor,
      "plan.put",
      "plan:activate",
      plan,
      PLAN_MANAGEMENT_ROLES,
    );
    const revisions = await this.#plans.list(plan.executionId);
    const latest = revisions.at(-1);
    if (latest && latest.planRevision > plan.planRevision) {
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
    return await this.#plans.put(plan);
  }

  async get(
    executionId: string,
    planRevision: number,
    actor: WorkflowActorContext,
  ): Promise<WorkflowPlan> {
    await this.#authorizeHost(
      actor,
      "plan.get",
      "plan:read",
      executionId,
      planRevision,
    );
    const plan = await this.#requiredPlan(executionId, planRevision);
    this.#assertPlanPolicy(actor, plan, "plan:read");
    return plan;
  }

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

  async activate(
    executionId: string,
    planRevision: number,
    actor: WorkflowActorContext,
  ): Promise<WorkflowOrchestrationState> {
    await this.#authorizeHost(
      actor,
      "plan.activate",
      "plan:activate",
      executionId,
      planRevision,
    );
    const plan = await this.#requiredPlan(executionId, planRevision);
    if (plan.status !== "ready") invalid("Only ready plans can be activated");
    this.#assertPlanPolicy(actor, plan, "plan:activate", PLAN_MANAGEMENT_ROLES);

    for (let retry = 0; retry < this.#maxCasRetries; retry++) {
      const current = await this.#state.get(executionId);
      if (!current) {
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

      if (current.activePlanRevision === planRevision) return current;
      if (
        current.activePlanRevision !== undefined &&
        current.activePlanRevision > planRevision
      ) {
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
      try {
        return await this.#state.compareAndSet(
          immutableWorkflowOrchestrationJson({
            ...current,
            revision: current.revision + 1,
            activePlanRevision: planRevision,
            grants: [],
            proposals: [],
            updatedAt: this.#timestamp(current.updatedAt),
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

  async #authorizeHost(
    actor: WorkflowActorContext,
    operation: WorkflowAuthorizationOperation,
    permission: WorkflowActorPermission,
    executionId: string,
    planRevision?: number,
  ): Promise<WorkflowActorContext> {
    return await authorizeWorkflowActor(this.#authorizer, actor, {
      operation,
      permission,
      executionId,
      ...(planRevision === undefined ? {} : { planRevision }),
    });
  }

  async #authorizePlan(
    actor: WorkflowActorContext,
    operation: WorkflowAuthorizationOperation,
    permission: WorkflowActorPermission,
    plan: WorkflowPlan,
    roles?: ReadonlySet<WorkflowActorRole>,
  ): Promise<void> {
    await this.#authorizeHost(
      actor,
      operation,
      permission,
      plan.executionId,
      plan.planRevision,
    );
    this.#assertPlanPolicy(actor, plan, permission, roles);
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
  if (!agent || !agent.policy.permissions.includes(permission)) return false;
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

function unauthorized(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
    { reason: "unauthorized" },
  );
}
