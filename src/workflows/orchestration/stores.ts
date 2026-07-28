/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "./contracts.js";
import {
  immutableWorkflowOrchestrationJson,
  validateWorkflowOrchestrationState,
  validateWorkflowPlan,
} from "./json.js";

export interface WorkflowPlanStore {
  put(plan: WorkflowPlan): Promise<WorkflowPlan>;
  get(
    executionId: string,
    planRevision: number,
  ): Promise<WorkflowPlan | undefined>;
  list(executionId: string): Promise<readonly WorkflowPlan[]>;
}

export interface WorkflowOrchestrationStateStore {
  create(
    state: WorkflowOrchestrationState,
  ): Promise<WorkflowOrchestrationState>;
  get(executionId: string): Promise<WorkflowOrchestrationState | undefined>;
  compareAndSet(
    state: WorkflowOrchestrationState,
    expectedRevision: number,
  ): Promise<WorkflowOrchestrationState>;
}

/** Immutable plan records keyed by executionId and planRevision. */
export class InMemoryWorkflowPlanStore implements WorkflowPlanStore {
  readonly #plans = new Map<string, Map<number, WorkflowPlan>>();

  async put(plan: WorkflowPlan): Promise<WorkflowPlan> {
    validateWorkflowPlan(plan);
    const revisions =
      this.#plans.get(plan.executionId) ?? new Map<number, WorkflowPlan>();
    if (revisions.has(plan.planRevision)) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_DUPLICATE",
        `Workflow plan revision already exists: ${plan.executionId}@${plan.planRevision}`,
        { executionId: plan.executionId, planRevision: plan.planRevision },
      );
    }
    const snapshot = immutableWorkflowOrchestrationJson(plan);
    if (!this.#plans.has(plan.executionId))
      this.#plans.set(plan.executionId, revisions);
    revisions.set(plan.planRevision, snapshot);
    return snapshot;
  }

  async get(
    executionId: string,
    planRevision: number,
  ): Promise<WorkflowPlan | undefined> {
    validateStoreKey(executionId, planRevision);
    return this.#plans.get(executionId)?.get(planRevision);
  }

  async list(executionId: string): Promise<readonly WorkflowPlan[]> {
    validateExecutionId(executionId);
    const plans = [...(this.#plans.get(executionId)?.values() ?? [])].sort(
      (left, right) => left.planRevision - right.planRevision,
    );
    return Object.freeze(plans);
  }
}

/** Single-process reference implementation of the orchestration CAS aggregate. */
export class InMemoryWorkflowOrchestrationStateStore
  implements WorkflowOrchestrationStateStore
{
  readonly #states = new Map<string, WorkflowOrchestrationState>();

  async create(
    state: WorkflowOrchestrationState,
  ): Promise<WorkflowOrchestrationState> {
    validateWorkflowOrchestrationState(state);
    if (state.revision !== 1)
      invalid("Initial orchestration state revision must be 1");
    if (this.#states.has(state.executionId)) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE",
        `Workflow orchestration state already exists: ${state.executionId}`,
        { executionId: state.executionId },
      );
    }
    const snapshot = immutableWorkflowOrchestrationJson(state);
    this.#states.set(state.executionId, snapshot);
    return snapshot;
  }

  async get(
    executionId: string,
  ): Promise<WorkflowOrchestrationState | undefined> {
    validateExecutionId(executionId);
    return this.#states.get(executionId);
  }

  async compareAndSet(
    state: WorkflowOrchestrationState,
    expectedRevision: number,
  ): Promise<WorkflowOrchestrationState> {
    validateWorkflowOrchestrationState(state);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0) {
      invalid("Expected orchestration state revision must be positive");
    }
    const current = this.#states.get(state.executionId);
    if (!current) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND",
        `Workflow orchestration state was not found: ${state.executionId}`,
        { executionId: state.executionId },
      );
    }
    if (current.revision !== expectedRevision) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_REVISION_CONFLICT",
        `Workflow orchestration state revision conflict: ${state.executionId}`,
        {
          executionId: state.executionId,
          expectedRevision,
          actualRevision: current.revision,
        },
      );
    }
    if (state.revision !== expectedRevision + 1) {
      invalid("Replacement orchestration state revision must increment by one");
    }
    if (state.executionId !== current.executionId) {
      invalid("Workflow orchestration state identity is immutable");
    }
    if (
      current.activePlanRevision !== undefined &&
      (state.activePlanRevision === undefined ||
        state.activePlanRevision < current.activePlanRevision)
    ) {
      invalid("Active workflow plan revision cannot move backwards");
    }
    if (state.nextFencingToken < current.nextFencingToken) {
      invalid("Workflow ownership fencing token cannot move backwards");
    }
    if (state.updatedAt < current.updatedAt) {
      invalid("Workflow orchestration updatedAt cannot move backwards");
    }
    const snapshot = immutableWorkflowOrchestrationJson(state);
    this.#states.set(state.executionId, snapshot);
    return snapshot;
  }
}

function validateStoreKey(executionId: string, planRevision: number): void {
  validateExecutionId(executionId);
  if (!Number.isSafeInteger(planRevision) || planRevision <= 0) {
    invalid("Workflow plan revision must be positive");
  }
}

function validateExecutionId(executionId: string): void {
  if (
    typeof executionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(executionId)
  ) {
    invalid("Workflow executionId is invalid");
  }
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
