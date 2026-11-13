import { isWorkflowIdentifier } from "../internal/identifiers.js";
import {
  normalizeAuthoritativeChangeReceipt,
  type WorkflowAuthoritativeChangeReceipt,
} from "../workspace/change-driver.js";
import {
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "./contracts.js";
import {
  snapshotWorkflowOrchestrationState,
  snapshotWorkflowPlan,
} from "./json.js";

/**
 * Storage for immutable workflow plans, keyed by execution and plan revision.
 */
export interface WorkflowPlanStore {
  /**
   * Stores an immutable plan revision.
   *
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_DUPLICATE`
   * when the revision already exists.
   */
  put(plan: WorkflowPlan): Promise<WorkflowPlan>;
  /** Reads a plan revision, or `undefined` when it does not exist. */
  get(
    executionId: string,
    planRevision: number,
  ): Promise<WorkflowPlan | undefined>;
  /** Lists the plan revisions of an execution in ascending order. */
  list(executionId: string): Promise<readonly WorkflowPlan[]>;
}

/**
 * Storage for the orchestration state aggregate with revision-based
 * compare-and-set.
 */
export interface WorkflowOrchestrationStateStore {
  /**
   * Stores the first state of an execution.
   *
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_ORCHESTRATION_STATE_DUPLICATE`
   * when a state already exists.
   */
  create(
    state: WorkflowOrchestrationState,
  ): Promise<WorkflowOrchestrationState>;
  /** Reads the state, or `undefined` when none exists. */
  get(executionId: string): Promise<WorkflowOrchestrationState | undefined>;
  /**
   * Replaces the state if its stored revision equals `expectedRevision`.
   *
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_REVISION_CONFLICT`
   * when the stored revision differs, or `WORKFLOW_ORCHESTRATION_STATE_NOT_FOUND`
   * when no state exists.
   */
  compareAndSet(
    state: WorkflowOrchestrationState,
    expectedRevision: number,
  ): Promise<WorkflowOrchestrationState>;
}

/** Durable evidence registry. Mutation authority accepts only issued receipts. */
export interface WorkflowChangeReceiptStore {
  /** Stores a receipt; repeating the same receipt is allowed. */
  put(
    receipt: WorkflowAuthoritativeChangeReceipt,
  ): Promise<WorkflowAuthoritativeChangeReceipt>;
  /** Reads a receipt, or `undefined` when it does not exist. */
  get(
    executionId: string,
    receiptId: string,
  ): Promise<WorkflowAuthoritativeChangeReceipt | undefined>;
}

/**
 * Single-process {@link WorkflowChangeReceiptStore}.
 *
 * @remarks
 * Putting a different receipt under an existing id is rejected.
 */
export class InMemoryWorkflowChangeReceiptStore
  implements WorkflowChangeReceiptStore
{
  readonly #receipts = new Map<string, WorkflowAuthoritativeChangeReceipt>();

  /** Stores a receipt. Repeating an identical receipt returns the stored one; a different receipt under the same id is rejected. */
  async put(
    receipt: WorkflowAuthoritativeChangeReceipt,
  ): Promise<WorkflowAuthoritativeChangeReceipt> {
    const snapshot = normalizeAuthoritativeChangeReceipt(receipt);
    const key = receiptKey(snapshot.executionId, snapshot.receiptId);
    const existing = this.#receipts.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) {
        invalid(
          "Workflow receipt identity already contains different evidence",
        );
      }
      return existing;
    }
    this.#receipts.set(key, snapshot);
    return snapshot;
  }

  /** Reads a receipt, or `undefined` when it does not exist. */
  async get(
    executionId: string,
    receiptId: string,
  ): Promise<WorkflowAuthoritativeChangeReceipt | undefined> {
    validateExecutionId(executionId);
    validateReceiptId(receiptId);
    return this.#receipts.get(receiptKey(executionId, receiptId));
  }
}

/** Immutable plan records keyed by executionId and planRevision. */
export class InMemoryWorkflowPlanStore implements WorkflowPlanStore {
  readonly #plans = new Map<string, Map<number, WorkflowPlan>>();

  /** Stores an immutable plan revision; a duplicate revision is rejected with code `WORKFLOW_PLAN_DUPLICATE`. */
  async put(value: WorkflowPlan): Promise<WorkflowPlan> {
    const plan = snapshotWorkflowPlan(value);
    const revisions =
      this.#plans.get(plan.executionId) ?? new Map<number, WorkflowPlan>();
    if (revisions.has(plan.planRevision)) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_DUPLICATE",
        `Workflow plan revision already exists: ${plan.executionId}@${plan.planRevision}`,
        { executionId: plan.executionId, planRevision: plan.planRevision },
      );
    }
    if (!this.#plans.has(plan.executionId))
      this.#plans.set(plan.executionId, revisions);
    revisions.set(plan.planRevision, plan);
    return plan;
  }

  /** Reads a plan revision, or `undefined` when it does not exist. */
  async get(
    executionId: string,
    planRevision: number,
  ): Promise<WorkflowPlan | undefined> {
    validateStoreKey(executionId, planRevision);
    return this.#plans.get(executionId)?.get(planRevision);
  }

  /** Lists the plan revisions of an execution in ascending order. */
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

  /** Stores the first state, which must be at revision 1; a second state for the same execution is rejected with code `WORKFLOW_ORCHESTRATION_STATE_DUPLICATE`. */
  async create(
    value: WorkflowOrchestrationState,
  ): Promise<WorkflowOrchestrationState> {
    const state = snapshotWorkflowOrchestrationState(value);
    if (state.revision !== 1)
      invalid("Initial orchestration state revision must be 1");
    if (this.#states.has(state.executionId)) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE",
        `Workflow orchestration state already exists: ${state.executionId}`,
        { executionId: state.executionId },
      );
    }
    this.#states.set(state.executionId, state);
    return state;
  }

  /** Reads the state, or `undefined` when none exists. */
  async get(
    executionId: string,
  ): Promise<WorkflowOrchestrationState | undefined> {
    validateExecutionId(executionId);
    return this.#states.get(executionId);
  }

  /** Replaces the state when the stored revision equals `expectedRevision` and the replacement is revision plus one; revision, active plan, fencing token and `updatedAt` never move backwards. */
  async compareAndSet(
    value: WorkflowOrchestrationState,
    expectedRevision: number,
  ): Promise<WorkflowOrchestrationState> {
    const state = snapshotWorkflowOrchestrationState(value);
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
    this.#states.set(state.executionId, state);
    return state;
  }
}

function validateStoreKey(executionId: string, planRevision: number): void {
  validateExecutionId(executionId);
  if (!Number.isSafeInteger(planRevision) || planRevision <= 0) {
    invalid("Workflow plan revision must be positive");
  }
}

function validateExecutionId(executionId: string): void {
  if (!isWorkflowIdentifier(executionId, "record")) {
    invalid("Workflow executionId is invalid");
  }
}

function validateReceiptId(receiptId: string): void {
  if (!isWorkflowIdentifier(receiptId, "opaque")) {
    invalid("Workflow receiptId is invalid");
  }
}

function receiptKey(executionId: string, receiptId: string): string {
  return `${executionId}\0${receiptId}`;
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}
