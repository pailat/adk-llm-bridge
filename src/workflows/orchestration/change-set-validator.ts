import {
  isWorkflowIdentifier,
  type WorkflowIdentifierGrammar,
} from "../internal/identifiers.js";
import {
  normalizeAcceptedChangeReceipt,
  verifyWorkflowChangeSet,
  type WorkflowAuthoritativeChangeReceipt,
  type WorkflowChangeEntryKind,
  type WorkflowChangeSet,
  type WorkflowExpectedTarget,
  type WorkflowOwnershipFence,
} from "../workspace/change-driver.js";
import type { WorkflowActorContext } from "./authorization.js";
import {
  WorkflowOrchestrationControlError,
  type WorkflowOwnershipGrant,
  type WorkflowPathClaim,
  type WorkflowPlan,
} from "./contracts.js";
import { workflowPathClaimsOverlap } from "./json.js";
import type { WorkflowOwnershipController } from "./ownership-controller.js";
import type {
  WorkflowChangeReceiptStore,
  WorkflowPlanStore,
} from "./stores.js";

/** Error codes thrown by {@link WorkflowOwnershipChangeSetValidator}. */
export type WorkflowChangeValidationErrorCode =
  | "WORKFLOW_CHANGE_BASE_REVISION_MISMATCH"
  | "WORKFLOW_CHANGE_PLAN_REVISION_MISMATCH"
  | "WORKFLOW_CHANGE_TASK_IDENTITY_MISMATCH"
  | "WORKFLOW_CHANGE_ENTRY_KIND_DENIED";

/**
 * Error thrown when a change set does not match its plan, base revision or task.
 */
export class WorkflowChangeValidationError extends Error {
  /** Machine-readable error code to branch on. */
  readonly code: WorkflowChangeValidationErrorCode;
  /** Frozen context for the failure, such as the expected and actual values. */
  readonly details?: Readonly<Record<string, string | number>>;

  constructor(
    code: WorkflowChangeValidationErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = "WorkflowChangeValidationError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze(details);
  }
}

/**
 * Change set to validate with the base revision, plan revision and ownership it must match.
 */
export interface WorkflowOwnershipChangeSetValidationRequest {
  /** Change set the host inspected. */
  changeSet: WorkflowChangeSet;
  /** Base revision the change set must have been made against. */
  expectedBaseRevision: string;
  /** Plan revision the change set must target. */
  expectedPlanRevision: number;
  /** Agent that produced the change set. */
  agentId: string;
  /** Ownership grants, with fencing tokens, that must cover every changed path. */
  ownership: readonly WorkflowOwnershipFence[];
  /** Integration target and revision the receipt will be bound to. */
  expectedTarget: WorkflowExpectedTarget;
}

/** Dependencies and options for {@link WorkflowOwnershipChangeSetValidator}. */
export interface WorkflowOwnershipChangeSetValidatorConfig {
  /** Controller used to check grants against the live ledger. */
  ownership: WorkflowOwnershipController;
  /** Store the plan is read from. */
  plans: WorkflowPlanStore;
  /** Store issued receipts are persisted to. When omitted, receipts are issued but not stored. */
  receipts?: WorkflowChangeReceiptStore;
  /** Generates receipt ids. Defaults to a random identifier generator. */
  createReceiptId?: () => string;
  /** Clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** File and directory entries are allowed by default. */
  allowedEntryKinds?: readonly WorkflowChangeEntryKind[];
}

/**
 * Read-only policy boundary between a host inspection and commit/integration.
 * It issues JSON-only evidence; it never mutates ownership or a workspace.
 */
export class WorkflowOwnershipChangeSetValidator {
  readonly #ownership: WorkflowOwnershipController;
  readonly #plans: WorkflowPlanStore;
  readonly #receipts?: WorkflowChangeReceiptStore;
  readonly #createReceiptId: () => string;
  readonly #now: () => number;
  readonly #allowedEntryKinds: ReadonlySet<WorkflowChangeEntryKind>;

  constructor(config: WorkflowOwnershipChangeSetValidatorConfig) {
    if (!config?.ownership || !config.plans) {
      throw new TypeError(
        "Workflow change validator requires ownership and plan stores",
      );
    }
    this.#ownership = config.ownership;
    this.#plans = config.plans;
    this.#receipts = config.receipts;
    this.#createReceiptId = config.createReceiptId ?? defaultReceiptId;
    this.#now = config.now ?? Date.now;
    this.#allowedEntryKinds = normalizeAllowedEntryKinds(
      config.allowedEntryKinds ?? ["file", "directory"],
    );
  }

  /**
   * Verifies a change set against the plan, base revision and live ownership,
   * and issues an authoritative receipt.
   *
   * @remarks
   * The change set digest is verified before authorization so forged content
   * never influences ownership checks or receipt construction.
   *
   * @param request - Change set and the revisions and ownership it must match.
   * @param actor - Host-authenticated actor.
   * @returns A receipt that later commit and integration steps consume.
   * @throws {@link WorkflowChangeValidationError} when the plan or base revision,
   * task identity or entry kinds do not match.
   * @throws {@link WorkflowOrchestrationControlError} with code `WORKFLOW_PLAN_NOT_FOUND`
   * when the plan revision does not exist.
   * @throws {@link TypeError} when `request` is missing.
   */
  async validate(
    request: WorkflowOwnershipChangeSetValidationRequest,
    actor: WorkflowActorContext,
  ): Promise<WorkflowAuthoritativeChangeReceipt> {
    if (!request || typeof request !== "object") {
      throw new TypeError("Workflow change validation request is required");
    }

    // Digest verification must precede authorization so forged contents never
    // influence ownership checks or receipt construction.
    const changeSet = await verifyWorkflowChangeSet(request.changeSet);
    validateExpectedRevision(request.expectedPlanRevision);
    if (changeSet.planRevision !== request.expectedPlanRevision) {
      throw mismatch(
        "WORKFLOW_CHANGE_PLAN_REVISION_MISMATCH",
        "Change set does not use the expected workflow plan revision",
        {
          expectedPlanRevision: request.expectedPlanRevision,
          actualPlanRevision: changeSet.planRevision,
        },
      );
    }

    const plan = await this.#plans.get(
      changeSet.executionId,
      request.expectedPlanRevision,
    );
    if (!plan) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_NOT_FOUND",
        `Workflow plan was not found: ${changeSet.executionId}@${request.expectedPlanRevision}`,
        {
          executionId: changeSet.executionId,
          planRevision: request.expectedPlanRevision,
        },
      );
    }
    validateIdentity(request.agentId, "agentId", "record");
    validateBaseRevision(request.expectedBaseRevision);
    if (
      changeSet.baseRevision !== request.expectedBaseRevision ||
      plan.baseRevision !== request.expectedBaseRevision
    ) {
      throw mismatch(
        "WORKFLOW_CHANGE_BASE_REVISION_MISMATCH",
        "Change set does not use the expected immutable base revision",
        {
          expectedBaseRevision: request.expectedBaseRevision,
          changeSetBaseRevision: changeSet.baseRevision,
          planBaseRevision: plan.baseRevision,
        },
      );
    }

    const lane = plan.lanes.find((item) => item.taskId === changeSet.taskId);
    if (!lane || lane.agentId !== request.agentId) {
      throw mismatch(
        "WORKFLOW_CHANGE_TASK_IDENTITY_MISMATCH",
        "Change set task and agent are not a lane in the active plan",
        { taskId: changeSet.taskId, agentId: request.agentId },
      );
    }
    validateEntryKinds(changeSet, this.#allowedEntryKinds);

    const fences = normalizeFences(request.ownership);
    const authority = await this.#ownership.validateAuthoritySnapshot(
      {
        executionId: changeSet.executionId,
        planRevision: changeSet.planRevision,
        taskId: changeSet.taskId,
        agentId: request.agentId,
        authorities: fences,
      },
      actor,
    );
    const grants = authority.grants;
    validateAffectedPaths(changeSet, plan, lane.role, grants);

    const receipt = normalizeAcceptedChangeReceipt({
      receiptId: this.#receiptId(),
      verdict: "accepted",
      executionId: changeSet.executionId,
      taskId: changeSet.taskId,
      planRevision: changeSet.planRevision,
      workspaceRevision: changeSet.workspaceRevision,
      baseRevision: changeSet.baseRevision,
      changeSetDigest: changeSet.changeSetDigest,
      ownership: fences,
      issuedAt: this.#timestamp(),
      expectedTarget: request.expectedTarget,
      agentId: request.agentId,
      orchestrationRevision: authority.orchestrationRevision,
    }) as WorkflowAuthoritativeChangeReceipt;
    return (await this.#receipts?.put(receipt)) ?? receipt;
  }

  #receiptId(): string {
    const value = this.#createReceiptId();
    validateIdentity(value, "receiptId");
    return value;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        "Workflow change validator clock must return a non-negative safe integer",
      );
    }
    return value;
  }
}

function validateAffectedPaths(
  changeSet: WorkflowChangeSet,
  plan: WorkflowPlan,
  laneRole: string,
  grants: readonly WorkflowOwnershipGrant[],
): void {
  for (const entry of changeSet.entries) {
    const paths =
      entry.kind === "renamed" ? [entry.fromPath, entry.toPath] : [entry.path];
    for (const path of paths) {
      const coveringGrants = grants.filter((grant) =>
        grant.claims.some((claim) => pathCoveredByClaim(path, claim)),
      );
      const reserved = plan.reservedPaths.some((claim) =>
        pathCoveredByClaim(path, claim),
      );
      if (
        reserved &&
        (laneRole !== "integration" || coveringGrants.length === 0)
      ) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_RESERVED_PATH",
          `Workflow path is reserved for integration: ${path}`,
          { path, taskId: changeSet.taskId },
        );
      }
      if (coveringGrants.length === 0) {
        throw new WorkflowOrchestrationControlError(
          "WORKFLOW_PATH_NOT_OWNED",
          `Workflow change path is not covered by current ownership: ${path}`,
          { path, taskId: changeSet.taskId },
        );
      }
    }
  }
}

function pathCoveredByClaim(path: string, claim: WorkflowPathClaim): boolean {
  return workflowPathClaimsOverlap({ path, scope: "exact" }, claim);
}

function validateEntryKinds(
  changeSet: WorkflowChangeSet,
  allowed: ReadonlySet<WorkflowChangeEntryKind>,
): void {
  for (const entry of changeSet.entries) {
    if (!allowed.has(entry.entryKind)) {
      throw mismatch(
        "WORKFLOW_CHANGE_ENTRY_KIND_DENIED",
        `Workflow change entry kind is denied by host policy: ${entry.entryKind}`,
        { entryKind: entry.entryKind },
      );
    }
  }
}

function normalizeAllowedEntryKinds(
  input: readonly WorkflowChangeEntryKind[],
): ReadonlySet<WorkflowChangeEntryKind> {
  if (!Array.isArray(input)) {
    throw new TypeError("allowedEntryKinds must be an array");
  }
  const allowed = new Set<WorkflowChangeEntryKind>();
  for (const kind of input) {
    if (
      kind !== "file" &&
      kind !== "directory" &&
      kind !== "symlink" &&
      kind !== "submodule"
    ) {
      throw new TypeError("allowedEntryKinds contains an invalid entry kind");
    }
    allowed.add(kind);
  }
  return allowed;
}

function normalizeFences(
  input: readonly WorkflowOwnershipFence[],
): readonly WorkflowOwnershipFence[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(
      "Workflow change validation requires ownership evidence",
    );
  }
  const seen = new Set<string>();
  const fences = input.map((fence) => {
    if (!fence || typeof fence !== "object") {
      throw new TypeError("Workflow ownership evidence must be an object");
    }
    const keys = Object.keys(fence).sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "fencingToken" ||
      keys[1] !== "grantId"
    ) {
      throw new TypeError(
        "Workflow ownership evidence contains unknown fields",
      );
    }
    validateIdentity(fence.grantId, "grantId", "record");
    if (!Number.isSafeInteger(fence.fencingToken) || fence.fencingToken <= 0) {
      throw new TypeError("fencingToken must be a positive safe integer");
    }
    if (seen.has(fence.grantId)) {
      throw new TypeError(`Duplicate ownership grant: ${fence.grantId}`);
    }
    seen.add(fence.grantId);
    return Object.freeze({
      grantId: fence.grantId,
      fencingToken: fence.fencingToken,
    });
  });
  return Object.freeze(fences);
}

function validateExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("expectedPlanRevision must be a positive safe integer");
  }
}

function validateBaseRevision(value: string): void {
  if (!isWorkflowIdentifier(value, "revision")) {
    throw new TypeError("expectedBaseRevision must be an immutable revision");
  }
}

function validateIdentity(
  value: string,
  field: string,
  grammar: WorkflowIdentifierGrammar = "opaque",
): void {
  if (!isWorkflowIdentifier(value, grammar)) {
    throw new TypeError(`${field} must be a safe identity`);
  }
}

function mismatch(
  code: WorkflowChangeValidationErrorCode,
  message: string,
  details: Readonly<Record<string, string | number>>,
): WorkflowChangeValidationError {
  return new WorkflowChangeValidationError(code, message, details);
}

function defaultReceiptId(): string {
  return `change-receipt-${crypto.randomUUID()}`;
}
