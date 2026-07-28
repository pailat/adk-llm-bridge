/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type WorkflowActorPermission,
  WorkflowOrchestrationControlError,
} from "./contracts.js";

export type WorkflowAuthorizationOperation =
  | "plan.put"
  | "plan.get"
  | "plan.list"
  | "plan.activate";

export interface WorkflowAuthenticatedActorIdentity {
  /** Identity established by the host authentication boundary. */
  actorId: string;
  /** Logical agent identity the authenticated actor is allowed to represent. */
  agentId: string;
  executionId: string;
  taskId?: string;
  planRevision?: number;
}

/**
 * Host-only capability. It is deliberately a class rather than a JSON shape so
 * transport payloads cannot manufacture an authenticated workflow actor.
 */
export class WorkflowActorContext {
  readonly #identity: Readonly<WorkflowAuthenticatedActorIdentity>;

  constructor(identity: WorkflowAuthenticatedActorIdentity) {
    validateIdentifier(identity?.actorId, "actorId");
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

  get identity(): Readonly<WorkflowAuthenticatedActorIdentity> {
    return this.#identity;
  }

  toJSON(): never {
    invalid("Workflow actor context is host-only and cannot be serialized");
  }
}

export interface WorkflowAuthorizationRequest {
  /** Opaque host capability, allowing policies to verify issued instances. */
  actor: WorkflowActorContext;
  operation: WorkflowAuthorizationOperation;
  permission: WorkflowActorPermission;
  actorId: string;
  agentId: string;
  executionId: string;
  taskId?: string;
  planRevision?: number;
}

/** A host policy maps authenticated principals to their workflow authority. */
export interface WorkflowAuthorizer {
  authorize(
    request: Readonly<WorkflowAuthorizationRequest>,
  ): boolean | Promise<boolean>;
}

export const DENY_ALL_WORKFLOW_AUTHORIZER: WorkflowAuthorizer = Object.freeze({
  authorize: () => false,
});

export function requireWorkflowActorContext(
  value: unknown,
): WorkflowActorContext {
  if (!(value instanceof WorkflowActorContext)) {
    unauthorized("A host-authenticated workflow actor context is required");
  }
  return value;
}

export async function authorizeWorkflowActor(
  authorizer: WorkflowAuthorizer,
  actorValue: unknown,
  request: Omit<WorkflowAuthorizationRequest, "actor" | "actorId" | "agentId">,
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

function validateIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)
  ) {
    invalid(`Workflow actor ${field} is invalid`);
  }
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
