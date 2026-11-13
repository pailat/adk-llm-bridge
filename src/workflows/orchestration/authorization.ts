import {
  isWorkflowIdentifier,
  type WorkflowIdentifierGrammar,
} from "../internal/identifiers.js";
import {
  type WorkflowActorPermission,
  WorkflowOrchestrationControlError,
} from "./contracts.js";

/** Operation names passed to a {@link WorkflowAuthorizer}. */
export type WorkflowAuthorizationOperation =
  | "plan.put"
  | "plan.get"
  | "plan.list"
  | "plan.activate"
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
  | "task.list"
  | "ownership.claim"
  | "ownership.propose"
  | "ownership.approve"
  | "ownership.transfer"
  | "ownership.release"
  | "ownership.list"
  | "ownership.validate"
  | "changes.validate"
  | "integration.publish";

/**
 * Identity data of a host-authenticated actor.
 *
 * @remarks
 * `executionId`, and `taskId` and `planRevision` when set, bind the actor so it
 * cannot act on another execution, task or plan revision.
 */
export interface WorkflowAuthenticatedActorIdentity {
  /** Identity established by the host authentication boundary. */
  actorId: string;
  /** Logical agent identity the authenticated actor is allowed to represent. */
  agentId: string;
  /** Execution the actor is bound to. */
  executionId: string;
  /** Task the actor is bound to; when unset, the binding does not limit it to one task. */
  taskId?: string;
  /** Plan revision the actor is bound to; a positive integer. */
  planRevision?: number;
}

/**
 * Host-only capability. It is deliberately a class rather than a JSON shape so
 * transport payloads cannot manufacture an authenticated workflow actor.
 */
export class WorkflowActorContext {
  readonly #identity: Readonly<WorkflowAuthenticatedActorIdentity>;

  /**
   * Creates the capability from a host-authenticated identity.
   *
   * @param identity - Identity established by the host authentication boundary.
   * @throws {@link WorkflowOrchestrationControlError} with code
   * `WORKFLOW_ORCHESTRATION_INVALID_REQUEST` when an identifier is malformed or
   * `planRevision` is not a positive safe integer.
   */
  constructor(identity: WorkflowAuthenticatedActorIdentity) {
    validateIdentifier(identity?.actorId, "actorId", "principal");
    validateIdentifier(identity?.agentId, "agentId");
    validateIdentifier(identity?.executionId, "executionId");
    if (identity.taskId !== undefined)
      validateIdentifier(identity.taskId, "taskId");
    if (
      identity.planRevision !== undefined &&
      (!Number.isSafeInteger(identity.planRevision) ||
        identity.planRevision <= 0)
    ) {
      invalid("Workflow actor planRevision must be positive");
    }
    this.#identity = Object.freeze({ ...identity });
    Object.freeze(this);
  }

  /** Frozen copy of the identity this capability was created with. */
  get identity(): Readonly<WorkflowAuthenticatedActorIdentity> {
    return this.#identity;
  }

  /**
   * Refuses serialization so the capability never leaves the host process.
   *
   * @throws {@link WorkflowOrchestrationControlError} with code
   * `WORKFLOW_ORCHESTRATION_INVALID_REQUEST`, always.
   */
  toJSON(): never {
    invalid("Workflow actor context is host-only and cannot be serialized");
  }
}

/** Question asked of a {@link WorkflowAuthorizer} for one operation. */
export interface WorkflowAuthorizationRequest {
  /** Opaque host capability, allowing policies to verify issued instances. */
  actor: WorkflowActorContext;
  /** Operation being attempted. */
  operation: WorkflowAuthorizationOperation;
  /** Permission the operation requires. */
  permission: WorkflowActorPermission;
  /** Host principal of the actor, copied from its identity. */
  actorId: string;
  /** Agent the actor represents, copied from its identity. */
  agentId: string;
  /** Execution the operation targets. */
  executionId: string;
  /** Task the operation targets, or the one the actor is bound to. */
  taskId?: string;
  /** Plan revision the operation targets, or the one the actor is bound to. */
  planRevision?: number;
}

/** A host policy maps authenticated principals to their workflow authority. */
export interface WorkflowAuthorizer {
  /**
   * Decides whether the actor may perform the operation.
   *
   * Only a result of exactly `true` grants access.
   */
  authorize(
    request: Readonly<WorkflowAuthorizationRequest>,
  ): boolean | Promise<boolean>;
}

/**
 * Authorizer that denies every request.
 *
 * @remarks
 * Controllers fall back to it when no authorizer is configured, so a missing
 * policy fails closed.
 */
export const DENY_ALL_WORKFLOW_AUTHORIZER: WorkflowAuthorizer = Object.freeze({
  authorize: () => false,
});

/**
 * Narrows a value to a host-issued {@link WorkflowActorContext}.
 *
 * @param value - Candidate capability.
 * @returns The same value as a {@link WorkflowActorContext}.
 * @throws {@link WorkflowOrchestrationControlError} with code
 * `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` (and `details.reason` set to
 * `unauthorized`) when `value` is not an instance created by the host.
 * @internal
 */
export function requireWorkflowActorContext(
  value: unknown,
): WorkflowActorContext {
  if (!(value instanceof WorkflowActorContext)) {
    unauthorized("A host-authenticated workflow actor context is required");
  }
  return value;
}

/**
 * What the caller of {@link authorizeWorkflowActor} knows about the
 * execution, used to tell a stale actor from an out-of-scope one.
 */
export interface WorkflowActorAuthorizationContext {
  /** The execution's active plan revision, when the caller has read it. */
  activePlanRevision?: number;
}

/**
 * Checks that an actor may perform an operation and returns its context.
 *
 * @remarks
 * Fails closed: the actor must be bound to the same execution (and plan
 * revision or task when both sides set one), and the authorizer must return
 * exactly `true`. Any other result denies; an error thrown by the
 * authorizer propagates to the caller.
 *
 * @param authorizer - Host policy.
 * @param actorValue - Opaque actor capability from the caller.
 * @param request - Operation, permission and target to authorize.
 * @param context - The active plan revision, when known.
 * @returns The validated {@link WorkflowActorContext}.
 * @throws {@link WorkflowOrchestrationControlError} with code
 * `WORKFLOW_ORCHESTRATION_UNAUTHORIZED` (and `details.reason` set to
 * `unauthorized`) when the actor is not a {@link WorkflowActorContext}, is
 * bound to another execution or task, or is denied.
 * @throws {@link WorkflowOrchestrationControlError} with code
 * `WORKFLOW_PLAN_STALE` when the actor is bound to another plan revision than
 * the request and that revision is older than `activePlanRevision`. A binding
 * to any other revision (an older one the request reads, or one that is not
 * active yet) is a scope denial: `WORKFLOW_ORCHESTRATION_UNAUTHORIZED`.
 */
export async function authorizeWorkflowActor(
  authorizer: WorkflowAuthorizer,
  actorValue: unknown,
  request: Omit<WorkflowAuthorizationRequest, "actor" | "actorId" | "agentId">,
  context: WorkflowActorAuthorizationContext = {},
): Promise<WorkflowActorContext> {
  const actor = requireWorkflowActorContext(actorValue);
  const identity = actor.identity;
  if (identity.executionId !== request.executionId) {
    unauthorized("Workflow actor is bound to a different execution");
  }
  if (
    identity.planRevision !== undefined &&
    request.planRevision !== undefined &&
    identity.planRevision !== request.planRevision
  ) {
    // Only an actor left behind by a newer active plan is stale; refreshing
    // its binding is the fix. Any other mismatch is outside its scope.
    if (
      context.activePlanRevision !== undefined &&
      identity.planRevision < context.activePlanRevision
    ) {
      throw new WorkflowOrchestrationControlError(
        "WORKFLOW_PLAN_STALE",
        "Workflow actor is bound to a plan revision that is no longer active",
        {
          executionId: request.executionId,
          planRevision: request.planRevision,
          actorPlanRevision: identity.planRevision,
          activePlanRevision: context.activePlanRevision,
        },
      );
    }
    unauthorized("Workflow actor is bound to a different plan revision");
  }
  if (
    identity.taskId !== undefined &&
    request.taskId !== undefined &&
    identity.taskId !== request.taskId
  ) {
    unauthorized("Workflow actor is bound to a different task");
  }
  const authorized = await authorizer.authorize(
    Object.freeze({
      ...request,
      actor,
      actorId: identity.actorId,
      agentId: identity.agentId,
      ...(identity.taskId === undefined ? {} : { taskId: identity.taskId }),
      ...(identity.planRevision === undefined
        ? {}
        : { planRevision: identity.planRevision }),
    }),
  );
  if (authorized !== true) unauthorized("Workflow operation is not authorized");
  return actor;
}

// The actor id names a host principal; every other id must match the stores
// it is checked against, so an actor cannot be valid for a task it can never
// own.
function validateIdentifier(
  value: string,
  field: string,
  grammar: WorkflowIdentifierGrammar = "record",
): void {
  if (!isWorkflowIdentifier(value, grammar)) {
    invalid(`Workflow actor ${field} is invalid`);
  }
}

function invalid(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    message,
  );
}

/**
 * Throws the orchestration authorization error.
 *
 * @remarks
 * Internal to the orchestration controllers, not exported from the package.
 * The error carries `details.reason: "unauthorized"`, which hosts can match to
 * tell an authorization failure from a malformed request.
 *
 * @param message - Human-readable reason.
 * @throws {@link WorkflowOrchestrationControlError} with code
 * `WORKFLOW_ORCHESTRATION_UNAUTHORIZED`, always.
 * @internal
 */
export function unauthorized(message: string): never {
  throw new WorkflowOrchestrationControlError(
    "WORKFLOW_ORCHESTRATION_UNAUTHORIZED",
    message,
    { reason: "unauthorized" },
  );
}
