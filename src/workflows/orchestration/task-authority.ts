/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  WorkflowTaskAttemptAuthorityRequest,
  WorkflowTaskAuthorityPort,
  WorkflowTaskChildAuthorityRequest,
  WorkflowTaskRootAuthorityRequest,
  WorkflowTaskSenderAuthorityRequest,
} from "../tasks/authority.js";
import type {
  WorkflowTaskClaimGuard,
  WorkflowTaskOrchestrationBinding,
  WorkflowTaskRecord,
} from "../tasks/contracts.js";
import { immutableTaskJson } from "../tasks/json.js";
import {
  authorizeWorkflowActor,
  DENY_ALL_WORKFLOW_AUTHORIZER,
  type WorkflowActorContext,
  type WorkflowAuthorizer,
} from "./authorization.js";
import {
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
  type WorkflowPlanAgent,
  type WorkflowPlanLane,
} from "./contracts.js";
import type {
  WorkflowOrchestrationStateStore,
  WorkflowPlanStore,
} from "./stores.js";

export interface WorkflowOrchestrationTaskAuthorityConfig {
  plans: WorkflowPlanStore;
  state: WorkflowOrchestrationStateStore;
  /** Host authentication/policy boundary. Omitting it denies root and sender calls. */
  authorizer?: WorkflowAuthorizer;
  now?: () => number;
}

interface ActiveOrchestration {
  state: WorkflowOrchestrationState;
  plan: WorkflowPlan;
}

/**
 * Derives durable task bindings exclusively from the active plan and live
 * ownership ledger. Caller-provided bindings are never authority.
 */
export class WorkflowOrchestrationTaskAuthorityPort
  implements
    WorkflowTaskAuthorityPort<WorkflowActorContext, WorkflowActorContext>
{
  readonly #plans: WorkflowPlanStore;
  readonly #state: WorkflowOrchestrationStateStore;
  readonly #authorizer: WorkflowAuthorizer;
  readonly #now: () => number;

  constructor(config: WorkflowOrchestrationTaskAuthorityConfig) {
    if (!config?.plans || !config.state) {
      invalid("Workflow task authority requires plan and state stores");
    }
    this.#plans = config.plans;
    this.#state = config.state;
    this.#authorizer = config.authorizer ?? DENY_ALL_WORKFLOW_AUTHORIZER;
    this.#now = config.now ?? Date.now;
  }

  async resolveRoot(
    request: WorkflowTaskRootAuthorityRequest<WorkflowActorContext>,
  ): Promise<WorkflowTaskOrchestrationBinding> {
    validateRootRequest(request);
    const target = request.request;
    const active = await this.#active(target.executionId);
    const lane = requiredLane(active.plan, target.taskId, target.agentId);
    const actor = await authorizeWorkflowActor(
      this.#authorizer,
      request.capability,
      {
        operation: "task.spawn",
        permission: "task:spawn",
        executionId: target.executionId,
        taskId: target.taskId,
        planRevision: active.plan.planRevision,
      },
    );
    assertActorTargetsLane(actor, lane, active.plan.planRevision);
    assertAgentPermission(active.plan, lane.agentId, "task:spawn");
    // target.orchestration is intentionally ignored: it is only a client hint.
    return bindingFor(active, lane);
  }

  async deriveChild(
    request: WorkflowTaskChildAuthorityRequest,
  ): Promise<WorkflowTaskOrchestrationBinding> {
    validateChildRequest(request);
    assertCurrentClaim(request.parent, request.parentClaim, this.#timestamp());
    const active = await this.#active(request.parent.executionId);
    const parentLane = requiredLane(
      active.plan,
      request.parent.taskId,
      request.parent.agentId,
    );
    assertRecordBinding(request.parent, active, parentLane);
    const parentAgent = requiredAgent(active.plan, parentLane.agentId);
    if (!parentAgent.policy.permissions.includes("task:spawn")) {
      unauthorized("Parent workflow agent cannot spawn tasks");
    }
    if (!parentAgent.policy.canDelegate) {
      unauthorized("Parent workflow agent cannot delegate");
    }

    const childLane = requiredLane(
      active.plan,
      request.request.taskId,
      request.request.agentId,
    );
    if (!childLane.dependsOn.includes(parentLane.taskId)) {
      unauthorized("Child workflow lane does not depend on the parent lane");
    }
    if (!parentAgent.policy.allowedDelegateRoles?.includes(childLane.role)) {
      unauthorized("Child workflow role is not allowed by the parent policy");
    }
    // Derive the child's own grants. Parent grants must never be inherited.
    return bindingFor(active, childLane);
  }

  async validateAttempt(
    request: WorkflowTaskAttemptAuthorityRequest,
  ): Promise<void> {
    validateAttemptRequest(request);
    assertCurrentClaim(request.task, request.claim, this.#timestamp());
    const active = await this.#active(request.task.executionId);
    const lane = requiredLane(
      active.plan,
      request.task.taskId,
      request.task.agentId,
    );
    assertRecordBinding(request.task, active, lane);
  }

  async validateAuthenticatedSender(
    request: WorkflowTaskSenderAuthorityRequest<WorkflowActorContext>,
  ): Promise<void> {
    validateSenderRequest(request);
    const sender = request.sender;
    const active = await this.#active(sender.executionId);
    const lane = requiredLane(active.plan, sender.taskId, sender.agentId);
    assertRecordBinding(sender, active, lane);
    const actor = await authorizeWorkflowActor(
      this.#authorizer,
      request.actor,
      {
        operation: "task.mailbox.send",
        permission: "task:mailbox:send",
        executionId: sender.executionId,
        taskId: sender.taskId,
        planRevision: active.plan.planRevision,
      },
    );
    assertActorTargetsLane(actor, lane, active.plan.planRevision);
    assertAgentPermission(active.plan, lane.agentId, "task:mailbox:send");
  }

  async #active(executionId: string): Promise<ActiveOrchestration> {
    identifier(executionId, "executionId");
    const state = await this.#state.get(executionId);
    if (!state) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND",
        `Workflow orchestration state was not found: ${executionId}`,
        { executionId },
      );
    }
    if (state.activePlanRevision === undefined) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_STALE",
        `Workflow execution has no active plan: ${executionId}`,
        { executionId },
      );
    }
    const plan = await this.#plans.get(executionId, state.activePlanRevision);
    if (!plan) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Active workflow plan was not found: ${executionId}@${state.activePlanRevision}`,
        { executionId, planRevision: state.activePlanRevision },
      );
    }
    return { state, plan };
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isFinite(value) || value < 0) {
      invalid("Workflow task authority clock returned an invalid timestamp");
    }
    return value;
  }
}

function bindingFor(
  active: ActiveOrchestration,
  lane: WorkflowPlanLane,
): WorkflowTaskOrchestrationBinding {
  const ownership = active.state.grants
    .filter(
      (grant) =>
        grant.planRevision === active.plan.planRevision &&
        grant.taskId === lane.taskId &&
        grant.agentId === lane.agentId,
    )
    .map((grant) => ({
      grantId: grant.grantId,
      fencingToken: grant.fencingToken,
    }))
    .sort(compareGrants);
  return immutableTaskJson({
    planRevision: active.plan.planRevision,
    ownership,
  });
}

function assertRecordBinding(
  record: WorkflowTaskRecord,
  active: ActiveOrchestration,
  lane: WorkflowPlanLane,
): void {
  const expected = bindingFor(active, lane);
  const actual = record.orchestration;
  if (
    !actual ||
    actual.planRevision !== expected.planRevision ||
    actual.ownership.length !== expected.ownership.length
  ) {
    stale(record, "Workflow task binding does not match active ownership");
  }
  const ordered = [...actual.ownership].sort(compareGrants);
  if (
    ordered.some(
      (grant, index) =>
        grant.grantId !== expected.ownership[index]?.grantId ||
        grant.fencingToken !== expected.ownership[index]?.fencingToken,
    )
  ) {
    stale(record, "Workflow task ownership fencing is stale");
  }
}

function assertCurrentClaim(
  record: WorkflowTaskRecord,
  guard: WorkflowTaskClaimGuard,
  now: number,
): void {
  const claim = record.claim;
  if (
    record.status !== "running" ||
    !claim ||
    guard.executionId !== record.executionId ||
    guard.taskId !== record.taskId ||
    guard.workerId !== claim.workerId ||
    guard.leaseId !== claim.leaseId ||
    guard.fencingToken !== claim.fencingToken ||
    claim.expiresAt <= now
  ) {
    stale(record, "Workflow task claim is not current");
  }
}

function assertActorTargetsLane(
  actor: WorkflowActorContext,
  lane: WorkflowPlanLane,
  planRevision: number,
): void {
  const identity = actor.identity;
  if (
    identity.taskId !== lane.taskId ||
    identity.agentId !== lane.agentId ||
    identity.planRevision !== planRevision
  ) {
    unauthorized("Workflow actor is not bound to the active target lane");
  }
}

function assertAgentPermission(
  plan: WorkflowPlan,
  agentId: string,
  permission: "task:spawn" | "task:mailbox:send",
): void {
  const agent = requiredAgent(plan, agentId);
  if (!agent.policy.permissions.includes(permission)) {
    unauthorized(`Workflow agent lacks ${permission} permission`);
  }
}

function requiredAgent(plan: WorkflowPlan, agentId: string): WorkflowPlanAgent {
  const agent = plan.agents.find((candidate) => candidate.agentId === agentId);
  if (!agent) invalid(`Workflow plan agent was not found: ${agentId}`);
  return agent;
}

function requiredLane(
  plan: WorkflowPlan,
  taskId: string,
  agentId: string,
): WorkflowPlanLane {
  identifier(taskId, "taskId");
  identifier(agentId, "agentId");
  const lane = plan.lanes.find((candidate) => candidate.taskId === taskId);
  if (!lane || lane.agentId !== agentId) {
    unauthorized("Workflow task does not match an active plan lane");
  }
  const agent = requiredAgent(plan, agentId);
  if (agent.policy.role !== lane.role) {
    unauthorized("Workflow lane role does not match its agent policy");
  }
  return lane;
}

function validateRootRequest(
  value: WorkflowTaskRootAuthorityRequest<WorkflowActorContext>,
): void {
  if (!value || typeof value !== "object" || !value.request) {
    invalid("Workflow root authority request is invalid");
  }
  identifier(value.request.executionId, "executionId");
  identifier(value.request.taskId, "taskId");
  identifier(value.request.agentId, "agentId");
  if (value.request.parentTaskId !== undefined) {
    invalid("Workflow root task cannot declare a parentTaskId");
  }
}

function validateChildRequest(value: WorkflowTaskChildAuthorityRequest): void {
  if (!value || typeof value !== "object" || !value.parent || !value.request) {
    invalid("Workflow child authority request is invalid");
  }
  identifier(value.parent.executionId, "executionId");
  identifier(value.parent.taskId, "parent taskId");
  identifier(value.parent.agentId, "parent agentId");
  identifier(value.request.taskId, "child taskId");
  identifier(value.request.agentId, "child agentId");
}

function validateAttemptRequest(
  value: WorkflowTaskAttemptAuthorityRequest,
): void {
  if (!value || typeof value !== "object" || !value.task || !value.claim) {
    invalid("Workflow task attempt authority request is invalid");
  }
  identifier(value.task.executionId, "executionId");
  identifier(value.task.taskId, "taskId");
  identifier(value.task.agentId, "agentId");
}

function validateSenderRequest(
  value: WorkflowTaskSenderAuthorityRequest<WorkflowActorContext>,
): void {
  if (!value || typeof value !== "object" || !value.sender) {
    invalid("Workflow task sender authority request is invalid");
  }
  identifier(value.sender.executionId, "executionId");
  identifier(value.sender.taskId, "taskId");
  identifier(value.sender.agentId, "agentId");
}

function compareGrants(
  left: { grantId: string; fencingToken: number },
  right: { grantId: string; fencingToken: number },
): number {
  return (
    left.grantId.localeCompare(right.grantId) ||
    left.fencingToken - right.fencingToken
  );
}

function identifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)
  ) {
    invalid(`Workflow task authority ${field} is invalid`);
  }
}

function stale(record: WorkflowTaskRecord, message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_OWNERSHIP_STALE",
    message,
    {
      executionId: record.executionId,
      taskId: record.taskId,
      ...(record.orchestration === undefined
        ? {}
        : { planRevision: record.orchestration.planRevision }),
    },
  );
}

function unauthorized(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
    { reason: "unauthorized" },
  );
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
