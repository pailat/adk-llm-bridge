/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  WorkflowExecutionEventReadRequest,
  WorkflowExecutionListRequest,
  WorkflowExecutionRequest,
  WorkflowExecutionResumeRequest,
} from "../execution/contracts.js";
import type { WorkflowExecutionController } from "../execution/controller.js";
import { WorkflowActorContext } from "../orchestration/authorization.js";
import type {
  WorkflowOwnershipChangeSetValidationRequest,
  WorkflowOwnershipChangeSetValidator,
} from "../orchestration/change-set-validator.js";
import type { WorkflowPlan } from "../orchestration/contracts.js";
import type {
  WorkflowOwnershipClaimRequest,
  WorkflowOwnershipController,
  WorkflowOwnershipDecisionRequest,
  WorkflowOwnershipProposalRequest,
  WorkflowOwnershipReleaseRequest,
  WorkflowOwnershipScope,
  WorkflowOwnershipTransferRequest,
} from "../orchestration/ownership-controller.js";
import type { WorkflowPlanController } from "../orchestration/plan-controller.js";
import type {
  IntegrationGate,
  IntegrationGateRequest,
} from "../resources/integration-gate.js";
import type {
  WorkflowArtifactInput,
  WorkflowArtifactListInput,
  WorkflowArtifactStore,
} from "../resources/workflow-artifact-store.js";
import type {
  WorkflowTaskHandle,
  WorkflowTaskJsonValue,
  WorkflowTaskListRequest,
  WorkflowTaskMessageReadRequest,
  WorkflowTaskResumeRequest,
} from "../tasks/contracts.js";
import type { WorkflowTaskController } from "../tasks/controller.js";
import type {
  WorkflowTaskDispatcher,
  WorkflowTaskSweepRequest,
} from "../tasks/dispatcher.js";

export const WORKFLOW_CONTROL_PROTOCOL =
  "adk-llm-bridge/workflow-control" as const;
export const WORKFLOW_CONTROL_PROTOCOL_VERSION = 1 as const;

export interface WorkflowControlPlaneEnvelope {
  protocol: typeof WORKFLOW_CONTROL_PROTOCOL;
  version: typeof WORKFLOW_CONTROL_PROTOCOL_VERSION;
}

export interface WorkflowControlTaskSpawnPayload extends WorkflowTaskHandle {
  agentId: string;
  input?: WorkflowTaskJsonValue;
  operationId: string;
}

export interface WorkflowControlTaskMailboxSendPayload
  extends WorkflowTaskHandle {
  payload: WorkflowTaskJsonValue;
  operationId: string;
}

export type WorkflowControlPlaneRequest = WorkflowControlPlaneEnvelope &
  (
    | { operation: "execution.start"; payload: WorkflowExecutionRequest }
    | { operation: "execution.resume"; payload: WorkflowExecutionResumeRequest }
    | { operation: "execution.status"; payload: { executionId: string } }
    | { operation: "execution.cancel"; payload: { executionId: string } }
    | { operation: "execution.list"; payload: WorkflowExecutionListRequest }
    | {
        operation: "execution.events";
        payload: WorkflowExecutionEventReadRequest;
      }
    | { operation: "task.spawn"; payload: WorkflowControlTaskSpawnPayload }
    | { operation: "task.resume"; payload: WorkflowTaskResumeRequest }
    | { operation: "task.dispatch"; payload: WorkflowTaskHandle }
    | { operation: "task.recover"; payload: WorkflowTaskHandle }
    | { operation: "task.sweep"; payload: WorkflowTaskSweepRequest }
    | { operation: "task.status"; payload: WorkflowTaskHandle }
    | { operation: "task.cancel"; payload: WorkflowTaskHandle }
    | { operation: "task.list"; payload: WorkflowTaskListRequest }
    | { operation: "task.join"; payload: WorkflowTaskHandle }
    | {
        operation: "task.awaitAny";
        payload: { handles: readonly WorkflowTaskHandle[] };
      }
    | {
        operation: "task.mailbox.send";
        payload: WorkflowControlTaskMailboxSendPayload;
      }
    | {
        operation: "task.mailbox.read";
        payload: WorkflowTaskMessageReadRequest;
      }
    | {
        operation: "task.mailbox.wait";
        payload: WorkflowTaskMessageReadRequest;
      }
    | { operation: "artifact.put"; payload: WorkflowArtifactInput }
    | { operation: "artifact.get"; payload: { artifactId: string } }
    | {
        operation: "artifact.list";
        payload: Omit<WorkflowArtifactListInput, "signal">;
      }
    | { operation: "integration.validate"; payload: IntegrationGateRequest }
    | { operation: "plan.put"; payload: WorkflowPlan }
    | {
        operation: "plan.get" | "plan.activate";
        payload: { executionId: string; planRevision: number };
      }
    | { operation: "plan.list"; payload: { executionId: string } }
    | { operation: "ownership.claim"; payload: WorkflowOwnershipClaimRequest }
    | {
        operation: "ownership.propose";
        payload: WorkflowOwnershipProposalRequest;
      }
    | {
        operation: "ownership.approve" | "ownership.reject";
        payload: WorkflowOwnershipDecisionRequest;
      }
    | {
        operation: "ownership.transfer";
        payload: WorkflowOwnershipTransferRequest;
      }
    | {
        operation: "ownership.release";
        payload: WorkflowOwnershipReleaseRequest;
      }
    | { operation: "ownership.list"; payload: WorkflowOwnershipScope }
    | {
        operation: "ownership.validate";
        payload: WorkflowOwnershipChangeSetValidationRequest;
      }
  );

export interface WorkflowControlPlaneConfig {
  executions: WorkflowExecutionController;
  tasks: WorkflowTaskController;
  artifacts: WorkflowArtifactStore;
  integration: IntegrationGate;
  plans?: WorkflowPlanController;
  ownership?: WorkflowOwnershipController;
  changeValidation?: WorkflowOwnershipChangeSetValidator;
  dispatcher?: WorkflowTaskDispatcher;
}

export interface WorkflowControlPlaneDispatchOptions {
  /** Host-only cancellation for long-poll operations. Never serialized. */
  signal?: AbortSignal;
  /** Host-authenticated orchestration identity. Never accepted from JSON. */
  actor?: WorkflowActorContext;
}

export type WorkflowControlPlaneErrorCode =
  | "WORKFLOW_CONTROL_INVALID_REQUEST"
  | "WORKFLOW_CONTROL_UNKNOWN_OPERATION"
  | "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE";

export class WorkflowControlPlaneError extends Error {
  readonly code: WorkflowControlPlaneErrorCode;

  constructor(code: WorkflowControlPlaneErrorCode, message: string) {
    super(message);
    this.name = "WorkflowControlPlaneError";
    this.code = code;
  }
}

/**
 * JSON-only facade for HTTP, RPC, or MCP transports.
 *
 * It intentionally owns no socket, process, credential, or provider handle;
 * transport adapters only need to forward one request object to `dispatch`.
 */
export class WorkflowControlPlane {
  readonly #executions: WorkflowExecutionController;
  readonly #tasks: WorkflowTaskController;
  readonly #artifacts: WorkflowArtifactStore;
  readonly #integration: IntegrationGate;
  readonly #plans: WorkflowPlanController | undefined;
  readonly #ownership: WorkflowOwnershipController | undefined;
  readonly #changeValidation: WorkflowOwnershipChangeSetValidator | undefined;
  readonly #dispatcher: WorkflowTaskDispatcher | undefined;

  constructor(config: WorkflowControlPlaneConfig) {
    if (
      !config?.executions ||
      !config.tasks ||
      !config.artifacts ||
      !config.integration
    ) {
      throw new WorkflowControlPlaneError(
        "WORKFLOW_CONTROL_INVALID_REQUEST",
        "Workflow control plane requires execution, task, artifact, and integration services",
      );
    }
    this.#executions = config.executions;
    this.#tasks = config.tasks;
    this.#artifacts = config.artifacts;
    this.#integration = config.integration;
    this.#plans = config.plans;
    this.#ownership = config.ownership;
    this.#changeValidation = config.changeValidation;
    this.#dispatcher = config.dispatcher;
  }

  async dispatch(
    request: WorkflowControlPlaneRequest,
    options: WorkflowControlPlaneDispatchOptions = {},
  ): Promise<unknown> {
    const normalized = controlRequest(request);
    switch (normalized.operation) {
      case "execution.start":
        return await this.#executions.start(normalized.payload);
      case "execution.resume":
        return await this.#executions.resume(normalized.payload);
      case "execution.status":
        return await this.#executions.status(
          executionIdPayload(normalized.payload),
        );
      case "execution.cancel":
        return await this.#executions.cancel(
          executionIdPayload(normalized.payload),
        );
      case "execution.list":
        return await this.#executions.list(normalized.payload);
      case "execution.events":
        return await this.#executions.events(normalized.payload);
      case "task.spawn": {
        const payload = taskSpawnPayload(normalized.payload);
        const actor = requiredTaskSpawnActor(options.actor, payload);
        return await this.#tasks.spawn(
          {
            executionId: payload.executionId,
            taskId: payload.taskId,
            agentId: payload.agentId,
            ...(payload.input === undefined ? {} : { input: payload.input }),
          },
          { capability: actor, operationId: payload.operationId },
        );
      }
      case "task.resume":
        return await this.#tasks.resume(normalized.payload);
      case "task.dispatch":
        return await this.#tasks.dispatch(
          taskHandlePayload(normalized.payload),
        );
      case "task.recover":
        return await this.#tasks.recoverExpired(
          taskHandlePayload(normalized.payload),
        );
      case "task.sweep": {
        const payload = taskSweepPayload(normalized.payload);
        return await requiredCapability(this.#dispatcher, "task.sweep").sweep(
          payload,
        );
      }
      case "task.status":
        return await this.#tasks.status(taskHandlePayload(normalized.payload));
      case "task.cancel":
        return await this.#tasks.cancel(normalized.payload);
      case "task.list":
        return await this.#tasks.list(normalized.payload);
      case "task.join":
        return await this.#tasks.join(normalized.payload, options.signal);
      case "task.awaitAny":
        return await this.#tasks.awaitAny(
          awaitAnyPayload(normalized.payload),
          options.signal,
        );
      case "task.mailbox.send": {
        const payload = taskMailboxSendPayload(normalized.payload);
        const actor = requiredMailboxSender(options.actor, payload.executionId);
        return await this.#tasks.send(
          {
            executionId: payload.executionId,
            taskId: payload.taskId,
            senderTaskId: actor.identity.taskId,
            payload: payload.payload,
          },
          { actor, operationId: payload.operationId },
        );
      }
      case "task.mailbox.read":
        return await this.#tasks.readMailbox(normalized.payload);
      case "task.mailbox.wait":
        return await this.#tasks.waitForMessages(
          normalized.payload,
          options.signal,
        );
      case "artifact.put":
        return await this.#artifacts.put(
          artifactPutPayload(normalized.payload),
          {
            signal: options.signal,
          },
        );
      case "artifact.get":
        return await this.#artifacts.get({
          artifactId: artifactIdPayload(normalized.payload),
          signal: options.signal,
        });
      case "artifact.list":
        return await this.#artifacts.list({
          ...artifactListPayload(normalized.payload),
          signal: options.signal,
        });
      case "integration.validate":
        return await this.#integration.validate(
          integrationPayload(normalized.payload),
          {
            signal: options.signal,
          },
        );
      case "plan.put": {
        const payload = planPutPayload(normalized.payload);
        return await requiredCapability(this.#plans, "plan.put").put(
          payload,
          requiredActor(options.actor),
        );
      }
      case "plan.get": {
        const payload = planRevisionPayload(normalized.payload, "plan get");
        return await requiredCapability(this.#plans, "plan.get").get(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "plan.list": {
        const executionId = executionIdPayload(normalized.payload);
        return await requiredCapability(this.#plans, "plan.list").list(
          executionId,
          requiredActor(options.actor),
        );
      }
      case "plan.activate": {
        const payload = planRevisionPayload(
          normalized.payload,
          "plan activate",
        );
        return await requiredCapability(this.#plans, "plan.activate").activate(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "ownership.claim": {
        const payload = ownershipClaimPayload(normalized.payload);
        return await requiredCapability(
          this.#ownership,
          "ownership.claim",
        ).claim(payload, requiredActor(options.actor));
      }
      case "ownership.propose": {
        const payload = ownershipProposalPayload(normalized.payload);
        return await requiredCapability(
          this.#ownership,
          "ownership.propose",
        ).propose(payload, requiredActor(options.actor));
      }
      case "ownership.approve":
      case "ownership.reject": {
        const payload = ownershipDecisionPayload(normalized.payload);
        const controller = requiredCapability(
          this.#ownership,
          normalized.operation,
        );
        const actor = requiredActor(options.actor);
        return normalized.operation === "ownership.approve"
          ? await controller.approve(payload, actor)
          : await controller.reject(payload, actor);
      }
      case "ownership.transfer": {
        const payload = ownershipTransferPayload(normalized.payload);
        return await requiredCapability(
          this.#ownership,
          "ownership.transfer",
        ).transfer(payload, requiredActor(options.actor));
      }
      case "ownership.release": {
        const payload = ownershipReleasePayload(normalized.payload);
        return await requiredCapability(
          this.#ownership,
          "ownership.release",
        ).release(payload, requiredActor(options.actor));
      }
      case "ownership.list": {
        const payload = ownershipScopePayload(normalized.payload);
        return await requiredCapability(this.#ownership, "ownership.list").list(
          payload,
          requiredActor(options.actor),
        );
      }
      case "ownership.validate": {
        const payload = ownershipValidationPayload(normalized.payload);
        return await requiredCapability(
          this.#changeValidation,
          "ownership.validate",
        ).validate(payload, requiredActor(options.actor));
      }
      default:
        return unknownOperation(normalized);
    }
  }
}

function controlRequest(request: unknown): WorkflowControlPlaneRequest {
  if (
    !isRecord(request) ||
    Object.keys(request).some(
      (key) =>
        key !== "protocol" &&
        key !== "version" &&
        key !== "operation" &&
        key !== "payload",
    ) ||
    request.protocol !== WORKFLOW_CONTROL_PROTOCOL ||
    request.version !== WORKFLOW_CONTROL_PROTOCOL_VERSION ||
    typeof request.operation !== "string" ||
    !Object.hasOwn(request, "payload") ||
    !isRecord(request.payload)
  ) {
    invalid(
      "Workflow control request has an invalid protocol, version, operation, or payload",
    );
  }
  return request as unknown as WorkflowControlPlaneRequest;
}

function executionIdPayload(payload: unknown): string {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== "executionId") ||
    typeof payload.executionId !== "string"
  ) {
    invalid("Workflow execution identity payload is invalid");
  }
  return payload.executionId;
}

function awaitAnyPayload(payload: unknown): readonly WorkflowTaskHandle[] {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== "handles") ||
    !Array.isArray(payload.handles)
  ) {
    invalid("Workflow task awaitAny payload is invalid");
  }
  return payload.handles as readonly WorkflowTaskHandle[];
}

function taskHandlePayload(payload: unknown): WorkflowTaskHandle {
  exactPayload(payload, ["executionId", "taskId"], "task handle");
  return payload as unknown as WorkflowTaskHandle;
}

function taskSpawnPayload(payload: unknown): WorkflowControlTaskSpawnPayload {
  exactPayload(
    payload,
    ["executionId", "taskId", "agentId", "input", "operationId"],
    "task spawn",
  );
  requiredString(payload.executionId, "task spawn executionId");
  requiredString(payload.taskId, "task spawn taskId");
  requiredString(payload.agentId, "task spawn agentId");
  requiredString(payload.operationId, "task spawn operationId");
  return payload as unknown as WorkflowControlTaskSpawnPayload;
}

function taskMailboxSendPayload(
  payload: unknown,
): WorkflowControlTaskMailboxSendPayload {
  exactPayload(
    payload,
    ["executionId", "taskId", "payload", "operationId"],
    "task mailbox send",
  );
  requiredString(payload.executionId, "task mailbox send executionId");
  requiredString(payload.taskId, "task mailbox send taskId");
  requiredString(payload.operationId, "task mailbox send operationId");
  if (!Object.hasOwn(payload, "payload")) {
    invalid("Workflow control task mailbox send payload is invalid");
  }
  return payload as unknown as WorkflowControlTaskMailboxSendPayload;
}

function artifactPutPayload(payload: unknown): WorkflowArtifactInput {
  exactPayload(
    payload,
    ["artifactId", "executionId", "taskId", "type", "content", "metadata"],
    "artifact put",
  );
  return payload as unknown as WorkflowArtifactInput;
}

function artifactListPayload(
  payload: unknown,
): Omit<WorkflowArtifactListInput, "signal"> {
  exactPayload(
    payload,
    ["executionId", "taskId", "type", "cursor", "limit"],
    "artifact list",
  );
  return payload as Omit<WorkflowArtifactListInput, "signal">;
}

function integrationPayload(payload: unknown): IntegrationGateRequest {
  exactPayload(
    payload,
    ["gateId", "executionId", "taskId", "artifacts", "context"],
    "integration gate",
  );
  return payload as unknown as IntegrationGateRequest;
}

function taskSweepPayload(payload: unknown): WorkflowTaskSweepRequest {
  exactPayload(payload, ["executionId", "limit", "cursor"], "task sweep");
  requiredString(payload.executionId, "task sweep executionId");
  if (payload.cursor !== undefined && typeof payload.cursor !== "string") {
    invalid("Workflow control task sweep cursor is invalid");
  }
  if (
    payload.limit !== undefined &&
    (!Number.isSafeInteger(payload.limit) || (payload.limit as number) <= 0)
  ) {
    invalid("Workflow control task sweep limit is invalid");
  }
  return payload as unknown as WorkflowTaskSweepRequest;
}

function planPutPayload(payload: unknown): WorkflowPlan {
  exactPayload(
    payload,
    [
      "protocol",
      "version",
      "executionId",
      "planRevision",
      "baseRevision",
      "objective",
      "status",
      "createdAt",
      "agents",
      "lanes",
      "waves",
      "invariants",
      "reservedPaths",
    ],
    "plan put",
  );
  for (const field of [
    "agents",
    "lanes",
    "waves",
    "invariants",
    "reservedPaths",
  ])
    requiredArray(payload[field], `plan ${field}`);
  for (const agent of payload.agents as unknown[]) {
    exactPayload(agent, ["agentId", "policy", "metadata"], "plan agent");
    exactPayload(
      agent.policy,
      [
        "role",
        "permissions",
        "canDelegate",
        "allowedDelegateRoles",
        "maxChildren",
      ],
      "plan agent policy",
    );
  }
  for (const lane of payload.lanes as unknown[]) {
    exactPayload(
      lane,
      [
        "taskId",
        "agentId",
        "role",
        "ownedPaths",
        "mayCreateUnder",
        "dependsOn",
        "acceptance",
      ],
      "plan lane",
    );
    validateClaims(lane.ownedPaths, "plan lane ownership", false);
  }
  for (const wave of payload.waves as unknown[])
    exactPayload(wave, ["waveId", "taskIds"], "plan wave");
  for (const invariant of payload.invariants as unknown[])
    exactPayload(
      invariant,
      ["invariantId", "description", "appliesTo", "enforcedBy"],
      "plan invariant",
    );
  validateClaims(payload.reservedPaths, "plan reserved paths", false);
  return payload as unknown as WorkflowPlan;
}

function planRevisionPayload(
  payload: unknown,
  label: string,
): { executionId: string; planRevision: number } {
  exactPayload(payload, ["executionId", "planRevision"], label);
  requiredString(payload.executionId, `${label} executionId`);
  positiveInteger(payload.planRevision, `${label} planRevision`);
  return payload as { executionId: string; planRevision: number };
}

function ownershipScopePayload(payload: unknown): WorkflowOwnershipScope {
  return planRevisionPayload(payload, "ownership scope");
}

function ownershipClaimPayload(
  payload: unknown,
): WorkflowOwnershipClaimRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "claims"],
    "ownership claim",
  );
  validateOwnershipScope(payload, "ownership claim");
  validateClaims(payload.claims, "ownership claim", true);
  return payload as unknown as WorkflowOwnershipClaimRequest;
}

function ownershipProposalPayload(
  payload: unknown,
): WorkflowOwnershipProposalRequest {
  exactPayload(
    payload,
    [
      "executionId",
      "planRevision",
      "kind",
      "targetTaskId",
      "sourceGrantId",
      "claims",
    ],
    "ownership proposal",
  );
  validateOwnershipScope(payload, "ownership proposal");
  requiredString(payload.kind, "ownership proposal kind");
  optionalString(payload.targetTaskId, "ownership proposal targetTaskId");
  optionalString(payload.sourceGrantId, "ownership proposal sourceGrantId");
  if (payload.claims !== undefined)
    validateClaims(payload.claims, "ownership proposal", false);
  return payload as unknown as WorkflowOwnershipProposalRequest;
}

function ownershipDecisionPayload(
  payload: unknown,
): WorkflowOwnershipDecisionRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "proposalId", "reason"],
    "ownership decision",
  );
  validateOwnershipScope(payload, "ownership decision");
  requiredString(payload.proposalId, "ownership decision proposalId");
  optionalString(payload.reason, "ownership decision reason");
  return payload as unknown as WorkflowOwnershipDecisionRequest;
}

function ownershipTransferPayload(
  payload: unknown,
): WorkflowOwnershipTransferRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "sourceGrantId", "targetTaskId"],
    "ownership transfer",
  );
  validateOwnershipScope(payload, "ownership transfer");
  requiredString(payload.sourceGrantId, "ownership transfer sourceGrantId");
  requiredString(payload.targetTaskId, "ownership transfer targetTaskId");
  return payload as unknown as WorkflowOwnershipTransferRequest;
}

function ownershipReleasePayload(
  payload: unknown,
): WorkflowOwnershipReleaseRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "grantId"],
    "ownership release",
  );
  validateOwnershipScope(payload, "ownership release");
  requiredString(payload.grantId, "ownership release grantId");
  return payload as unknown as WorkflowOwnershipReleaseRequest;
}

function ownershipValidationPayload(
  payload: unknown,
): WorkflowOwnershipChangeSetValidationRequest {
  exactPayload(
    payload,
    [
      "changeSet",
      "expectedBaseRevision",
      "expectedPlanRevision",
      "agentId",
      "ownership",
      "expectedTarget",
    ],
    "ownership validation",
  );
  requiredString(
    payload.expectedBaseRevision,
    "ownership validation expectedBaseRevision",
  );
  positiveInteger(
    payload.expectedPlanRevision,
    "ownership validation expectedPlanRevision",
  );
  requiredString(payload.agentId, "ownership validation agentId");
  requiredArray(payload.ownership, "ownership validation ownership");
  for (const fence of payload.ownership as unknown[]) {
    exactPayload(
      fence,
      ["grantId", "fencingToken"],
      "ownership validation fence",
    );
    requiredString(fence.grantId, "ownership validation grantId");
    positiveInteger(fence.fencingToken, "ownership validation fencingToken");
  }
  validateChangeSet(payload.changeSet);
  exactPayload(
    payload.expectedTarget,
    ["targetId", "revision"],
    "ownership validation expected target",
  );
  requiredString(
    payload.expectedTarget.targetId,
    "ownership validation targetId",
  );
  requiredString(
    payload.expectedTarget.revision,
    "ownership validation target revision",
  );
  return payload as unknown as WorkflowOwnershipChangeSetValidationRequest;
}

function validateChangeSet(value: unknown): void {
  exactPayload(
    value,
    [
      "executionId",
      "taskId",
      "planRevision",
      "workspaceRevision",
      "baseRevision",
      "entries",
      "changeSetDigest",
    ],
    "ownership validation change set",
  );
  requiredArray(value.entries, "ownership validation change set entries");
  for (const entry of value.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.kind !== "string")
      invalid("Workflow control ownership validation change entry is invalid");
    exactPayload(
      entry,
      entry.kind === "renamed"
        ? ["kind", "entryKind", "fromPath", "toPath", "contentDigest"]
        : ["kind", "entryKind", "path", "contentDigest"],
      "ownership validation change entry",
    );
  }
}

function validateOwnershipScope(
  payload: Record<string, unknown>,
  label: string,
): void {
  requiredString(payload.executionId, `${label} executionId`);
  positiveInteger(payload.planRevision, `${label} planRevision`);
}

function validateClaims(
  value: unknown,
  label: string,
  required: boolean,
): void {
  requiredArray(value, `${label} claims`);
  if (required && value.length === 0)
    invalid(`Workflow control ${label} claims are required`);
  for (const claim of value) {
    exactPayload(claim, ["path", "scope"], `${label} claim`);
    requiredString(claim.path, `${label} claim path`);
    if (claim.scope !== "exact" && claim.scope !== "subtree")
      invalid(`Workflow control ${label} claim scope is invalid`);
  }
}

function requiredArray(
  value: unknown,
  label: string,
): asserts value is unknown[] {
  if (!Array.isArray(value)) invalid(`Workflow control ${label} is invalid`);
}

function requiredString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`Workflow control ${label} is invalid`);
}

function optionalString(
  value: unknown,
  label: string,
): asserts value is string | undefined {
  if (value !== undefined) requiredString(value, label);
}

function positiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    invalid(`Workflow control ${label} is invalid`);
}

function requiredActor(actor: unknown): WorkflowActorContext {
  if (!(actor instanceof WorkflowActorContext))
    invalid("Workflow control operation requires a host-authenticated actor");
  return actor;
}

function requiredTaskSpawnActor(
  actorValue: unknown,
  payload: WorkflowControlTaskSpawnPayload,
): WorkflowActorContext {
  const actor = requiredActor(actorValue);
  const identity = actor.identity;
  if (
    identity.executionId !== payload.executionId ||
    identity.taskId !== payload.taskId ||
    identity.agentId !== payload.agentId
  ) {
    invalid("Workflow control task spawn actor does not match the target");
  }
  return actor;
}

function requiredMailboxSender(
  actorValue: unknown,
  executionId: string,
): WorkflowActorContext {
  const actor = requiredActor(actorValue);
  const identity = actor.identity;
  if (identity.executionId !== executionId || identity.taskId === undefined) {
    invalid("Workflow control mailbox actor does not match the execution");
  }
  return actor;
}

function requiredCapability<T>(
  capability: T | undefined,
  operation: string,
): T {
  if (capability === undefined) {
    throw new WorkflowControlPlaneError(
      "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE",
      `Workflow control capability is unavailable: ${operation}`,
    );
  }
  return capability;
}

function artifactIdPayload(payload: unknown): string {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== "artifactId") ||
    typeof payload.artifactId !== "string"
  ) {
    invalid("Workflow artifact identity payload is invalid");
  }
  return payload.artifactId;
}

function exactPayload(
  payload: unknown,
  allowed: readonly string[],
  label: string,
): asserts payload is Record<string, unknown> {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !allowed.includes(key))
  ) {
    invalid(`Workflow control ${label} payload is invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): never {
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_INVALID_REQUEST",
    message,
  );
}

function unknownOperation(value: never): never {
  const operation = (value as { operation?: unknown }).operation;
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
    `Unknown workflow control operation: ${String(operation)}`,
  );
}
