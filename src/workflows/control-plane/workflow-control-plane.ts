/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type {
  WorkflowExecutionEventCursor,
  WorkflowExecutionEventReadRequest,
  WorkflowExecutionListRequest,
  WorkflowExecutionRequest,
  WorkflowExecutionResumeRequest,
  WorkflowExecutionStatus,
} from "../execution/contracts.js";
import type { WorkflowExecutionController } from "../execution/controller.js";
import { WorkflowActorContext } from "../orchestration/authorization.js";
import type {
  WorkflowOwnershipChangeSetValidationRequest,
  WorkflowOwnershipChangeSetValidator,
} from "../orchestration/change-set-validator.js";
import {
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowActorPermission,
  type WorkflowActorPolicy,
  type WorkflowActorRole,
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationJsonValue,
  type WorkflowOwnershipProposalKind,
  type WorkflowPathClaim,
  type WorkflowPlan,
  type WorkflowPlanAgent,
  type WorkflowPlanInvariant,
  type WorkflowPlanLane,
  type WorkflowPlanWave,
} from "../orchestration/contracts.js";
import { immutableWorkflowOrchestrationJson } from "../orchestration/json.js";
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
  WorkflowArtifactReference,
  WorkflowArtifactStore,
} from "../resources/workflow-artifact-store.js";
import type {
  WorkflowTaskControlAccess,
  WorkflowTaskControlAccessPort,
  WorkflowTaskControlOperation,
} from "../tasks/authority.js";
import type {
  WorkflowTaskHandle,
  WorkflowTaskJsonValue,
  WorkflowTaskListRequest,
  WorkflowTaskMessageCursor,
  WorkflowTaskMessageReadRequest,
  WorkflowTaskResumeRequest,
  WorkflowTaskStatus,
} from "../tasks/contracts.js";
import type { WorkflowTaskController } from "../tasks/controller.js";
import type {
  WorkflowTaskDispatcher,
  WorkflowTaskSweepRequest,
} from "../tasks/dispatcher.js";
import type {
  WorkflowChangeEntry,
  WorkflowChangeEntryKind,
  WorkflowChangeEntryMode,
  WorkflowChangeSet,
  WorkflowExpectedTarget,
  WorkflowOwnershipFence,
} from "../workspace/change-driver.js";

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
  /** Required for task operations unless trustedHostMode is explicitly enabled. */
  taskAccess?: WorkflowTaskControlAccessPort<WorkflowActorContext>;
  /** Explicit compatibility escape hatch for a fully trusted host transport. */
  trustedHostMode?: boolean;
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
  readonly #taskAccess:
    | WorkflowTaskControlAccessPort<WorkflowActorContext>
    | undefined;
  readonly #trustedHostMode: boolean;

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
    if (
      config.trustedHostMode !== undefined &&
      typeof config.trustedHostMode !== "boolean"
    ) {
      invalid("Workflow control trustedHostMode must be boolean");
    }
    this.#taskAccess = config.taskAccess;
    this.#trustedHostMode = config.trustedHostMode ?? false;
  }

  async dispatch(
    request: WorkflowControlPlaneRequest,
    options: WorkflowControlPlaneDispatchOptions = {},
  ): Promise<unknown> {
    const { operation, payload: raw } = controlRequest(request);
    switch (operation) {
      case "execution.start":
        return await this.#executions.start(executionStartPayload(raw));
      case "execution.resume":
        return await this.#executions.resume(executionResumePayload(raw));
      case "execution.status":
        return await this.#executions.status(executionIdPayload(raw));
      case "execution.cancel":
        return await this.#executions.cancel(executionIdPayload(raw));
      case "execution.list":
        return await this.#executions.list(executionListPayload(raw));
      case "execution.events":
        return await this.#executions.events(executionEventsPayload(raw));
      case "task.spawn": {
        const payload = taskSpawnPayload(raw);
        if (this.#trustedHostMode && options.actor === undefined) {
          return await this.#tasks.spawn({
            executionId: payload.executionId,
            taskId: payload.taskId,
            agentId: payload.agentId,
            ...(payload.input === undefined ? {} : { input: payload.input }),
          });
        }
        const actor = requiredTaskSpawnActor(options.actor, payload);
        await this.#authorizeTask(
          actor,
          "task.spawn",
          "self-spawn",
          payload.executionId,
          [payload.taskId],
        );
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
      case "task.resume": {
        const payload = taskResumePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.resume",
          "self-or-manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.resume(payload);
      }
      case "task.dispatch": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.dispatch",
          "manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.dispatch(payload);
      }
      case "task.recover": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.recover",
          "manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.recoverExpired(payload);
      }
      case "task.sweep": {
        const payload = taskSweepPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.sweep",
          "manager",
          payload.executionId,
          [],
        );
        return await requiredCapability(this.#dispatcher, "task.sweep").sweep(
          payload,
        );
      }
      case "task.status": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.status",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.status(payload);
      }
      case "task.cancel": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.cancel",
          "self-or-manager",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.cancel(payload);
      }
      case "task.list": {
        const payload = taskListPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.list",
          "manager",
          payload.executionId,
          [],
        );
        return await this.#tasks.list(payload);
      }
      case "task.join": {
        const payload = taskHandlePayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.join",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.join(payload, options.signal);
      }
      case "task.awaitAny": {
        const handles = awaitAnyPayload(raw);
        const scope = taskHandleScope(handles, "task awaitAny");
        await this.#authorizeTaskFromOptions(
          options,
          "task.awaitAny",
          "self-read",
          scope.executionId,
          scope.taskIds,
        );
        return await this.#tasks.awaitAny(handles, options.signal);
      }
      case "task.mailbox.send": {
        const payload = taskMailboxSendPayload(raw);
        if (this.#trustedHostMode && options.actor === undefined) {
          return await this.#tasks.send({
            executionId: payload.executionId,
            taskId: payload.taskId,
            payload: payload.payload,
          });
        }
        const { actor, senderTaskId } = requiredMailboxSender(
          options.actor,
          payload.executionId,
        );
        await this.#authorizeTask(
          actor,
          "task.mailbox.send",
          "self-send",
          payload.executionId,
          [senderTaskId],
        );
        return await this.#tasks.send(
          {
            executionId: payload.executionId,
            taskId: payload.taskId,
            senderTaskId,
            payload: payload.payload,
          },
          { actor, operationId: payload.operationId },
        );
      }
      case "task.mailbox.read": {
        const payload = taskMailboxReadPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.mailbox.read",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.readMailbox(payload);
      }
      case "task.mailbox.wait": {
        const payload = taskMailboxReadPayload(raw);
        await this.#authorizeTaskFromOptions(
          options,
          "task.mailbox.wait",
          "self-read",
          payload.executionId,
          [payload.taskId],
        );
        return await this.#tasks.waitForMessages(payload, options.signal);
      }
      case "artifact.put":
        return await this.#artifacts.put(artifactPutPayload(raw), {
          signal: options.signal,
        });
      case "artifact.get":
        return await this.#artifacts.get({
          artifactId: artifactIdPayload(raw),
          signal: options.signal,
        });
      case "artifact.list":
        return await this.#artifacts.list({
          ...artifactListPayload(raw),
          signal: options.signal,
        });
      case "integration.validate":
        return await this.#integration.validate(integrationPayload(raw), {
          signal: options.signal,
        });
      case "plan.put": {
        const payload = planPutPayload(raw);
        return await requiredCapability(this.#plans, "plan.put").put(
          payload,
          requiredActor(options.actor),
        );
      }
      case "plan.get": {
        const payload = planRevisionPayload(raw, "plan get");
        return await requiredCapability(this.#plans, "plan.get").get(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "plan.list": {
        const executionId = executionIdPayload(raw);
        return await requiredCapability(this.#plans, "plan.list").list(
          executionId,
          requiredActor(options.actor),
        );
      }
      case "plan.activate": {
        const payload = planRevisionPayload(raw, "plan activate");
        return await requiredCapability(this.#plans, "plan.activate").activate(
          payload.executionId,
          payload.planRevision,
          requiredActor(options.actor),
        );
      }
      case "ownership.claim": {
        const payload = ownershipClaimPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.claim",
        ).claim(payload, requiredActor(options.actor));
      }
      case "ownership.propose": {
        const payload = ownershipProposalPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.propose",
        ).propose(payload, requiredActor(options.actor));
      }
      case "ownership.approve":
      case "ownership.reject": {
        const payload = ownershipDecisionPayload(raw);
        const controller = requiredCapability(this.#ownership, operation);
        const actor = requiredActor(options.actor);
        return operation === "ownership.approve"
          ? await controller.approve(payload, actor)
          : await controller.reject(payload, actor);
      }
      case "ownership.transfer": {
        const payload = ownershipTransferPayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.transfer",
        ).transfer(payload, requiredActor(options.actor));
      }
      case "ownership.release": {
        const payload = ownershipReleasePayload(raw);
        return await requiredCapability(
          this.#ownership,
          "ownership.release",
        ).release(payload, requiredActor(options.actor));
      }
      case "ownership.list": {
        const payload = ownershipScopePayload(raw);
        return await requiredCapability(this.#ownership, "ownership.list").list(
          payload,
          requiredActor(options.actor),
        );
      }
      case "ownership.validate": {
        const payload = ownershipValidationPayload(raw);
        return await requiredCapability(
          this.#changeValidation,
          "ownership.validate",
        ).validate(payload, requiredActor(options.actor));
      }
      default:
        return unknownOperation(operation);
    }
  }

  async #authorizeTaskFromOptions(
    options: WorkflowControlPlaneDispatchOptions,
    operation: WorkflowTaskControlOperation,
    access: WorkflowTaskControlAccess,
    executionId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    if (this.#trustedHostMode) return;
    await this.#authorizeTask(
      requiredActor(options.actor),
      operation,
      access,
      executionId,
      taskIds,
    );
  }

  async #authorizeTask(
    actor: WorkflowActorContext,
    operation: WorkflowTaskControlOperation,
    access: WorkflowTaskControlAccess,
    executionId: string,
    taskIds: readonly string[],
  ): Promise<void> {
    if (this.#trustedHostMode) return;
    await requiredCapability(this.#taskAccess, operation).authorizeControl({
      actor,
      operation,
      access,
      executionId,
      taskIds,
    });
  }
}

type WorkflowControlOperation = WorkflowControlPlaneRequest["operation"];
type ControlPayload = Record<string, unknown>;
type ControlJsonObject = {
  readonly [key: string]: WorkflowOrchestrationJsonValue;
};

/** A `Record` keyed by a union stays exhaustive when the union changes. */
const CONTROL_OPERATIONS: Readonly<Record<WorkflowControlOperation, true>> = {
  "execution.start": true,
  "execution.resume": true,
  "execution.status": true,
  "execution.cancel": true,
  "execution.list": true,
  "execution.events": true,
  "task.spawn": true,
  "task.resume": true,
  "task.dispatch": true,
  "task.recover": true,
  "task.sweep": true,
  "task.status": true,
  "task.cancel": true,
  "task.list": true,
  "task.join": true,
  "task.awaitAny": true,
  "task.mailbox.send": true,
  "task.mailbox.read": true,
  "task.mailbox.wait": true,
  "artifact.put": true,
  "artifact.get": true,
  "artifact.list": true,
  "integration.validate": true,
  "plan.put": true,
  "plan.get": true,
  "plan.activate": true,
  "plan.list": true,
  "ownership.claim": true,
  "ownership.propose": true,
  "ownership.approve": true,
  "ownership.reject": true,
  "ownership.transfer": true,
  "ownership.release": true,
  "ownership.list": true,
  "ownership.validate": true,
};

const STATUSES: Readonly<
  Record<WorkflowExecutionStatus & WorkflowTaskStatus, true>
> = {
  queued: true,
  running: true,
  cancelling: true,
  completed: true,
  failed: true,
  cancelled: true,
};
const ACTOR_ROLES: Readonly<Record<WorkflowActorRole, true>> = {
  architect: true,
  worker: true,
  integration: true,
  critic: true,
};
const ACTOR_PERMISSIONS: Readonly<Record<WorkflowActorPermission, true>> = {
  "plan:read": true,
  "plan:activate": true,
  "task:spawn": true,
  "task:mailbox:send": true,
  "task:read": true,
  "task:cancel": true,
  "task:manage": true,
  "ownership:claim": true,
  "ownership:propose": true,
  "ownership:approve": true,
  "ownership:transfer": true,
  "ownership:release": true,
  "changes:validate": true,
  "integration:publish": true,
};
const PLAN_STATUSES: Readonly<Record<WorkflowPlan["status"], true>> = {
  draft: true,
  ready: true,
};
const INVARIANT_SCOPES: Readonly<
  Record<WorkflowPlanInvariant["appliesTo"], true>
> = { workflow: true, ownership: true, changes: true, integration: true };
const INVARIANT_ENFORCERS: Readonly<
  Record<WorkflowPlanInvariant["enforcedBy"], true>
> = { "control-plane": true, driver: true, host: true };
const CLAIM_SCOPES: Readonly<Record<WorkflowPathClaim["scope"], true>> = {
  exact: true,
  subtree: true,
};
const PROPOSAL_KINDS: Readonly<Record<WorkflowOwnershipProposalKind, true>> = {
  claim: true,
  transfer: true,
  release: true,
};
const PATH_CHANGE_KINDS: Readonly<
  Record<Exclude<WorkflowChangeEntry["kind"], "renamed">, true>
> = { added: true, modified: true, deleted: true };
const CHANGE_ENTRY_KINDS: Readonly<Record<WorkflowChangeEntryKind, true>> = {
  file: true,
  directory: true,
  symlink: true,
  submodule: true,
};
const CHANGE_ENTRY_MODES: Readonly<Record<WorkflowChangeEntryMode, true>> = {
  "040000": true,
  "100644": true,
  "100755": true,
  "120000": true,
  "160000": true,
};

function controlRequest(request: unknown): {
  operation: WorkflowControlOperation;
  payload: ControlPayload;
} {
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
  const operation = request.operation;
  if (!oneOf(operation, CONTROL_OPERATIONS)) {
    throw new WorkflowControlPlaneError(
      "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
      `Unknown workflow control operation: ${String(operation)}`,
    );
  }
  return { operation, payload: request.payload };
}

// --- execution ------------------------------------------------------------

function executionStartPayload(
  payload: ControlPayload,
): WorkflowExecutionRequest {
  exactPayload(
    payload,
    ["executionId", "workflowId", "workflowVersion", "input", "metadata"],
    "execution start",
  );
  const input = optionalJson(payload.input, "execution start input");
  const metadata = optionalJsonObject(
    payload.metadata,
    "execution start metadata",
  );
  return {
    executionId: requiredString(
      payload.executionId,
      "execution start executionId",
    ),
    workflowId: requiredString(
      payload.workflowId,
      "execution start workflowId",
    ),
    workflowVersion: requiredString(
      payload.workflowVersion,
      "execution start workflowVersion",
    ),
    ...(input === undefined ? {} : { input }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function executionResumePayload(
  payload: ControlPayload,
): WorkflowExecutionResumeRequest {
  exactPayload(payload, ["executionId", "strategy"], "execution resume");
  const executionId = requiredString(
    payload.executionId,
    "execution resume executionId",
  );
  if (payload.strategy !== "checkpoint") {
    invalid("Workflow control execution resume strategy is invalid");
  }
  return { executionId, strategy: payload.strategy };
}

function executionIdPayload(payload: unknown): string {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => key !== "executionId") ||
    typeof payload.executionId !== "string" ||
    payload.executionId.length === 0
  ) {
    invalid("Workflow execution identity payload is invalid");
  }
  return payload.executionId;
}

function executionListPayload(
  payload: ControlPayload,
): WorkflowExecutionListRequest {
  exactPayload(payload, ["status", "cursor", "limit"], "execution list");
  const status = optionalOneOf(
    payload.status,
    STATUSES,
    "execution list status",
  );
  const cursor = optionalOpaqueString(payload.cursor, "execution list cursor");
  const limit = optionalPositiveInteger(payload.limit, "execution list limit");
  return {
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function executionEventsPayload(
  payload: ControlPayload,
): WorkflowExecutionEventReadRequest {
  exactPayload(payload, ["executionId", "cursor", "limit"], "execution events");
  const executionId = requiredString(
    payload.executionId,
    "execution events executionId",
  );
  let cursor: WorkflowExecutionEventCursor | undefined;
  if (payload.cursor !== undefined) {
    const value = payload.cursor;
    exactPayload(
      value,
      ["executionId", "afterSequence"],
      "execution events cursor",
    );
    cursor = {
      executionId: requiredString(
        value.executionId,
        "execution events cursor executionId",
      ),
      afterSequence: nonNegativeInteger(
        value.afterSequence,
        "execution events cursor afterSequence",
      ),
    };
    if (cursor.executionId !== executionId) {
      invalid("Workflow control execution events cursor is invalid");
    }
  }
  const limit = optionalPositiveInteger(
    payload.limit,
    "execution events limit",
  );
  return {
    executionId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

// --- tasks ----------------------------------------------------------------

function awaitAnyPayload(
  payload: ControlPayload,
): readonly WorkflowTaskHandle[] {
  if (
    Object.keys(payload).some((key) => key !== "handles") ||
    !Array.isArray(payload.handles)
  ) {
    invalid("Workflow task awaitAny payload is invalid");
  }
  return payload.handles.map(taskHandlePayload);
}

function taskHandlePayload(payload: unknown): WorkflowTaskHandle {
  exactPayload(payload, ["executionId", "taskId"], "task handle");
  return {
    executionId: requiredString(payload.executionId, "task handle executionId"),
    taskId: requiredString(payload.taskId, "task handle taskId"),
  };
}

function taskHandleScope(
  handles: readonly WorkflowTaskHandle[],
  label: string,
): { executionId: string; taskIds: readonly string[] } {
  const first = handles[0];
  if (!first) invalid(`Workflow control ${label} handles are required`);
  const executionId = first.executionId;
  if (handles.some((handle) => handle.executionId !== executionId)) {
    invalid(`Workflow control ${label} handles must share an execution`);
  }
  return { executionId, taskIds: handles.map((handle) => handle.taskId) };
}

function taskResumePayload(payload: ControlPayload): WorkflowTaskResumeRequest {
  exactPayload(payload, ["executionId", "taskId", "strategy"], "task resume");
  const executionId = requiredString(
    payload.executionId,
    "task resume executionId",
  );
  const taskId = requiredString(payload.taskId, "task resume taskId");
  if (payload.strategy !== "checkpoint") {
    invalid("Workflow control task resume strategy is invalid");
  }
  return { executionId, taskId, strategy: payload.strategy };
}

function taskListPayload(payload: ControlPayload): WorkflowTaskListRequest {
  exactPayload(
    payload,
    ["executionId", "parentTaskId", "agentId", "status", "cursor", "limit"],
    "task list",
  );
  const executionId = requiredString(
    payload.executionId,
    "task list executionId",
  );
  const parentTaskId = optionalString(
    payload.parentTaskId,
    "task list parentTaskId",
  );
  const agentId = optionalString(payload.agentId, "task list agentId");
  const cursor = optionalString(payload.cursor, "task list cursor");
  const status = optionalOneOf(payload.status, STATUSES, "task list status");
  const limit = optionalPositiveInteger(payload.limit, "task list limit");
  return {
    executionId,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function taskMailboxReadPayload(
  payload: ControlPayload,
): WorkflowTaskMessageReadRequest {
  exactPayload(
    payload,
    ["executionId", "taskId", "cursor", "limit"],
    "task mailbox read",
  );
  const executionId = requiredString(
    payload.executionId,
    "task mailbox read executionId",
  );
  const taskId = requiredString(payload.taskId, "task mailbox read taskId");
  let cursor: WorkflowTaskMessageCursor | undefined;
  if (payload.cursor !== undefined) {
    const value = payload.cursor;
    exactPayload(
      value,
      ["executionId", "taskId", "afterSequence"],
      "task mailbox cursor",
    );
    cursor = {
      executionId: requiredString(
        value.executionId,
        "task mailbox cursor executionId",
      ),
      taskId: requiredString(value.taskId, "task mailbox cursor taskId"),
      afterSequence: nonNegativeInteger(
        value.afterSequence,
        "task mailbox cursor",
      ),
    };
    if (cursor.executionId !== executionId || cursor.taskId !== taskId) {
      invalid("Workflow control task mailbox cursor is invalid");
    }
  }
  const limit = optionalPositiveInteger(
    payload.limit,
    "task mailbox read limit",
  );
  return {
    executionId,
    taskId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function taskSpawnPayload(
  payload: ControlPayload,
): WorkflowControlTaskSpawnPayload {
  exactPayload(
    payload,
    ["executionId", "taskId", "agentId", "input", "operationId"],
    "task spawn",
  );
  const executionId = requiredString(
    payload.executionId,
    "task spawn executionId",
  );
  const taskId = requiredString(payload.taskId, "task spawn taskId");
  const agentId = requiredString(payload.agentId, "task spawn agentId");
  const operationId = requiredString(
    payload.operationId,
    "task spawn operationId",
  );
  const input = optionalJson(payload.input, "task spawn input");
  return {
    executionId,
    taskId,
    agentId,
    operationId,
    ...(input === undefined ? {} : { input }),
  };
}

function taskMailboxSendPayload(
  payload: ControlPayload,
): WorkflowControlTaskMailboxSendPayload {
  exactPayload(
    payload,
    ["executionId", "taskId", "payload", "operationId"],
    "task mailbox send",
  );
  const executionId = requiredString(
    payload.executionId,
    "task mailbox send executionId",
  );
  const taskId = requiredString(payload.taskId, "task mailbox send taskId");
  const operationId = requiredString(
    payload.operationId,
    "task mailbox send operationId",
  );
  if (!Object.hasOwn(payload, "payload")) {
    invalid("Workflow control task mailbox send payload is invalid");
  }
  return {
    executionId,
    taskId,
    operationId,
    payload: requiredJson(payload.payload, "task mailbox send payload"),
  };
}

function taskSweepPayload(payload: ControlPayload): WorkflowTaskSweepRequest {
  exactPayload(payload, ["executionId", "limit", "cursor"], "task sweep");
  const executionId = requiredString(
    payload.executionId,
    "task sweep executionId",
  );
  // The sweep cursor is opaque and is passed through unchanged.
  const cursor = optionalOpaqueString(payload.cursor, "task sweep cursor");
  const limit = optionalPositiveInteger(payload.limit, "task sweep limit");
  return {
    executionId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

// --- resources ------------------------------------------------------------

function artifactPutPayload(payload: ControlPayload): WorkflowArtifactInput {
  exactPayload(
    payload,
    ["artifactId", "executionId", "taskId", "type", "content", "metadata"],
    "artifact put",
  );
  const artifactId = requiredString(
    payload.artifactId,
    "artifact put artifactId",
  );
  const executionId = requiredString(
    payload.executionId,
    "artifact put executionId",
  );
  const taskId = requiredString(payload.taskId, "artifact put taskId");
  const type = requiredString(payload.type, "artifact put type");
  const content = requiredJson(payload.content, "artifact put content");
  const metadata = optionalJsonObject(
    payload.metadata,
    "artifact put metadata",
  );
  return {
    artifactId,
    executionId,
    taskId,
    type,
    content,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function artifactIdPayload(payload: ControlPayload): string {
  if (
    Object.keys(payload).some((key) => key !== "artifactId") ||
    typeof payload.artifactId !== "string" ||
    payload.artifactId.length === 0
  ) {
    invalid("Workflow artifact identity payload is invalid");
  }
  return payload.artifactId;
}

function artifactListPayload(
  payload: ControlPayload,
): Omit<WorkflowArtifactListInput, "signal"> {
  exactPayload(
    payload,
    ["executionId", "taskId", "type", "cursor", "limit"],
    "artifact list",
  );
  const executionId = optionalString(
    payload.executionId,
    "artifact list executionId",
  );
  const taskId = optionalString(payload.taskId, "artifact list taskId");
  const type = optionalString(payload.type, "artifact list type");
  const cursor = optionalOpaqueString(payload.cursor, "artifact list cursor");
  const limit = optionalPositiveInteger(payload.limit, "artifact list limit");
  return {
    ...(executionId === undefined ? {} : { executionId }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(type === undefined ? {} : { type }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function integrationPayload(payload: ControlPayload): IntegrationGateRequest {
  exactPayload(
    payload,
    ["gateId", "executionId", "taskId", "artifacts", "context"],
    "integration gate",
  );
  const gateId = requiredString(payload.gateId, "integration gate gateId");
  const executionId = requiredString(
    payload.executionId,
    "integration gate executionId",
  );
  const taskId = requiredString(payload.taskId, "integration gate taskId");
  const artifacts = requiredArray(
    payload.artifacts,
    "integration gate artifacts",
  ).map((value): WorkflowArtifactReference => {
    exactPayload(value, ["artifactId", "revision"], "integration artifact");
    return {
      artifactId: requiredString(
        value.artifactId,
        "integration artifact artifactId",
      ),
      revision: requiredString(value.revision, "integration artifact revision"),
    };
  });
  const context = optionalJsonObject(
    payload.context,
    "integration gate context",
  );
  return {
    gateId,
    executionId,
    taskId,
    artifacts,
    ...(context === undefined ? {} : { context }),
  };
}

// --- plans ----------------------------------------------------------------

/**
 * Checks the plan's shape and types. Cross-field rules (unique ids, lane
 * dependencies, waves, ownership layout) stay in `validateWorkflowPlan`, which
 * the plan controller runs.
 */
function planPutPayload(payload: ControlPayload): WorkflowPlan {
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
  if (payload.protocol !== WORKFLOW_PLAN_PROTOCOL) {
    invalid("Workflow control plan protocol is invalid");
  }
  if (payload.version !== WORKFLOW_PLAN_VERSION) {
    invalid("Workflow control plan version is invalid");
  }
  return {
    protocol: payload.protocol,
    version: payload.version,
    executionId: requiredString(payload.executionId, "plan executionId"),
    planRevision: positiveInteger(payload.planRevision, "plan planRevision"),
    baseRevision: requiredString(payload.baseRevision, "plan baseRevision"),
    objective: requiredString(payload.objective, "plan objective"),
    status: requiredOneOf(payload.status, PLAN_STATUSES, "plan status"),
    createdAt: timestamp(payload.createdAt, "plan createdAt"),
    agents: requiredArray(payload.agents, "plan agents").map(planAgent),
    lanes: requiredArray(payload.lanes, "plan lanes").map(planLane),
    waves: requiredArray(payload.waves, "plan waves").map(planWave),
    invariants: requiredArray(payload.invariants, "plan invariants").map(
      planInvariant,
    ),
    reservedPaths: claims(payload.reservedPaths, "plan reserved paths", false),
  };
}

function planAgent(value: unknown): WorkflowPlanAgent {
  exactPayload(value, ["agentId", "policy", "metadata"], "plan agent");
  const policy = value.policy;
  exactPayload(
    policy,
    [
      "role",
      "permissions",
      "canDelegate",
      "allowedDelegateRoles",
      "maxChildren",
    ],
    "plan agent policy",
  );
  if (typeof policy.canDelegate !== "boolean") {
    invalid("Workflow control plan agent policy canDelegate is invalid");
  }
  const allowedDelegateRoles =
    policy.allowedDelegateRoles === undefined
      ? undefined
      : requiredArray(
          policy.allowedDelegateRoles,
          "plan agent policy allowedDelegateRoles",
        ).map((role) =>
          requiredOneOf(role, ACTOR_ROLES, "plan agent policy delegate role"),
        );
  const maxChildren = optionalPositiveInteger(
    policy.maxChildren,
    "plan agent policy maxChildren",
  );
  const parsedPolicy: WorkflowActorPolicy = {
    role: requiredOneOf(policy.role, ACTOR_ROLES, "plan agent policy role"),
    permissions: requiredArray(
      policy.permissions,
      "plan agent policy permissions",
    ).map((permission) =>
      requiredOneOf(
        permission,
        ACTOR_PERMISSIONS,
        "plan agent policy permission",
      ),
    ),
    canDelegate: policy.canDelegate,
    ...(allowedDelegateRoles === undefined ? {} : { allowedDelegateRoles }),
    ...(maxChildren === undefined ? {} : { maxChildren }),
  };
  const metadata = optionalJsonObject(value.metadata, "plan agent metadata");
  return {
    agentId: requiredString(value.agentId, "plan agent agentId"),
    policy: parsedPolicy,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function planLane(value: unknown): WorkflowPlanLane {
  exactPayload(
    value,
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
  return {
    taskId: requiredString(value.taskId, "plan lane taskId"),
    agentId: requiredString(value.agentId, "plan lane agentId"),
    role: requiredOneOf(value.role, ACTOR_ROLES, "plan lane role"),
    ownedPaths: claims(value.ownedPaths, "plan lane ownership", false),
    mayCreateUnder: stringArray(
      value.mayCreateUnder,
      "plan lane mayCreateUnder",
    ),
    dependsOn: stringArray(value.dependsOn, "plan lane dependsOn"),
    acceptance: stringArray(value.acceptance, "plan lane acceptance"),
  };
}

function planWave(value: unknown): WorkflowPlanWave {
  exactPayload(value, ["waveId", "taskIds"], "plan wave");
  return {
    waveId: requiredString(value.waveId, "plan wave waveId"),
    taskIds: stringArray(value.taskIds, "plan wave taskIds"),
  };
}

function planInvariant(value: unknown): WorkflowPlanInvariant {
  exactPayload(
    value,
    ["invariantId", "description", "appliesTo", "enforcedBy"],
    "plan invariant",
  );
  return {
    invariantId: requiredString(
      value.invariantId,
      "plan invariant invariantId",
    ),
    description: requiredString(
      value.description,
      "plan invariant description",
    ),
    appliesTo: requiredOneOf(
      value.appliesTo,
      INVARIANT_SCOPES,
      "plan invariant appliesTo",
    ),
    enforcedBy: requiredOneOf(
      value.enforcedBy,
      INVARIANT_ENFORCERS,
      "plan invariant enforcedBy",
    ),
  };
}

function planRevisionPayload(
  payload: ControlPayload,
  label: string,
): { executionId: string; planRevision: number } {
  exactPayload(payload, ["executionId", "planRevision"], label);
  return {
    executionId: requiredString(payload.executionId, `${label} executionId`),
    planRevision: positiveInteger(
      payload.planRevision,
      `${label} planRevision`,
    ),
  };
}

// --- ownership ------------------------------------------------------------

function ownershipScopePayload(
  payload: ControlPayload,
): WorkflowOwnershipScope {
  return planRevisionPayload(payload, "ownership scope");
}

function ownershipScope(
  payload: ControlPayload,
  label: string,
): WorkflowOwnershipScope {
  return {
    executionId: requiredString(payload.executionId, `${label} executionId`),
    planRevision: positiveInteger(
      payload.planRevision,
      `${label} planRevision`,
    ),
  };
}

function ownershipClaimPayload(
  payload: ControlPayload,
): WorkflowOwnershipClaimRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "claims"],
    "ownership claim",
  );
  return {
    ...ownershipScope(payload, "ownership claim"),
    claims: claims(payload.claims, "ownership claim", true),
  };
}

function ownershipProposalPayload(
  payload: ControlPayload,
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
  const scope = ownershipScope(payload, "ownership proposal");
  const kind = requiredOneOf(
    payload.kind,
    PROPOSAL_KINDS,
    "ownership proposal kind",
  );
  const targetTaskId = optionalString(
    payload.targetTaskId,
    "ownership proposal targetTaskId",
  );
  const sourceGrantId = optionalString(
    payload.sourceGrantId,
    "ownership proposal sourceGrantId",
  );
  const proposedClaims =
    payload.claims === undefined
      ? undefined
      : claims(payload.claims, "ownership proposal", false);
  return {
    ...scope,
    kind,
    ...(targetTaskId === undefined ? {} : { targetTaskId }),
    ...(sourceGrantId === undefined ? {} : { sourceGrantId }),
    ...(proposedClaims === undefined ? {} : { claims: proposedClaims }),
  };
}

function ownershipDecisionPayload(
  payload: ControlPayload,
): WorkflowOwnershipDecisionRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "proposalId", "reason"],
    "ownership decision",
  );
  const scope = ownershipScope(payload, "ownership decision");
  const proposalId = requiredString(
    payload.proposalId,
    "ownership decision proposalId",
  );
  const reason = optionalString(payload.reason, "ownership decision reason");
  return {
    ...scope,
    proposalId,
    ...(reason === undefined ? {} : { reason }),
  };
}

function ownershipTransferPayload(
  payload: ControlPayload,
): WorkflowOwnershipTransferRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "sourceGrantId", "targetTaskId"],
    "ownership transfer",
  );
  return {
    ...ownershipScope(payload, "ownership transfer"),
    sourceGrantId: requiredString(
      payload.sourceGrantId,
      "ownership transfer sourceGrantId",
    ),
    targetTaskId: requiredString(
      payload.targetTaskId,
      "ownership transfer targetTaskId",
    ),
  };
}

function ownershipReleasePayload(
  payload: ControlPayload,
): WorkflowOwnershipReleaseRequest {
  exactPayload(
    payload,
    ["executionId", "planRevision", "grantId"],
    "ownership release",
  );
  return {
    ...ownershipScope(payload, "ownership release"),
    grantId: requiredString(payload.grantId, "ownership release grantId"),
  };
}

function ownershipValidationPayload(
  payload: ControlPayload,
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
  const expectedBaseRevision = requiredString(
    payload.expectedBaseRevision,
    "ownership validation expectedBaseRevision",
  );
  const expectedPlanRevision = positiveInteger(
    payload.expectedPlanRevision,
    "ownership validation expectedPlanRevision",
  );
  const agentId = requiredString(
    payload.agentId,
    "ownership validation agentId",
  );
  const ownership = requiredArray(
    payload.ownership,
    "ownership validation ownership",
  ).map((fence): WorkflowOwnershipFence => {
    exactPayload(
      fence,
      ["grantId", "fencingToken"],
      "ownership validation fence",
    );
    return {
      grantId: requiredString(fence.grantId, "ownership validation grantId"),
      fencingToken: positiveInteger(
        fence.fencingToken,
        "ownership validation fencingToken",
      ),
    };
  });
  const changeSet = changeSetPayload(payload.changeSet);
  const target = payload.expectedTarget;
  exactPayload(
    target,
    ["targetId", "revision"],
    "ownership validation expected target",
  );
  const expectedTarget: WorkflowExpectedTarget = {
    targetId: requiredString(target.targetId, "ownership validation targetId"),
    revision: requiredString(
      target.revision,
      "ownership validation target revision",
    ),
  };
  return {
    changeSet,
    expectedBaseRevision,
    expectedPlanRevision,
    agentId,
    ownership,
    expectedTarget,
  };
}

function changeSetPayload(value: unknown): WorkflowChangeSet {
  const label = "ownership validation change set";
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
    label,
  );
  return {
    executionId: requiredString(value.executionId, `${label} executionId`),
    taskId: requiredString(value.taskId, `${label} taskId`),
    planRevision: positiveInteger(value.planRevision, `${label} planRevision`),
    workspaceRevision: requiredString(
      value.workspaceRevision,
      `${label} workspaceRevision`,
    ),
    baseRevision: requiredString(value.baseRevision, `${label} baseRevision`),
    entries: requiredArray(value.entries, `${label} entries`).map(changeEntry),
    changeSetDigest: requiredString(
      value.changeSetDigest,
      `${label} changeSetDigest`,
    ),
  };
}

function changeEntry(value: unknown): WorkflowChangeEntry {
  const label = "ownership validation change entry";
  if (!isRecord(value) || typeof value.kind !== "string") {
    invalid(`Workflow control ${label} is invalid`);
  }
  const renamed = value.kind === "renamed";
  exactPayload(
    value,
    renamed
      ? ["kind", "entryKind", "mode", "fromPath", "toPath", "contentDigest"]
      : ["kind", "entryKind", "mode", "path", "contentDigest"],
    label,
  );
  const entryKind = requiredOneOf(
    value.entryKind,
    CHANGE_ENTRY_KINDS,
    `${label} entryKind`,
  );
  const mode = optionalOneOf(value.mode, CHANGE_ENTRY_MODES, `${label} mode`);
  const contentDigest = requiredString(
    value.contentDigest,
    `${label} contentDigest`,
  );
  const base = {
    entryKind,
    ...(mode === undefined ? {} : { mode }),
    contentDigest,
  };
  if (renamed) {
    return {
      kind: "renamed",
      ...base,
      fromPath: requiredString(value.fromPath, `${label} fromPath`),
      toPath: requiredString(value.toPath, `${label} toPath`),
    };
  }
  return {
    kind: requiredOneOf(value.kind, PATH_CHANGE_KINDS, `${label} kind`),
    ...base,
    path: requiredString(value.path, `${label} path`),
  };
}

function claims(
  value: unknown,
  label: string,
  required: boolean,
): WorkflowPathClaim[] {
  const items = requiredArray(value, `${label} claims`);
  if (required && items.length === 0)
    invalid(`Workflow control ${label} claims are required`);
  return items.map((claim) => {
    exactPayload(claim, ["path", "scope"], `${label} claim`);
    const path = requiredString(claim.path, `${label} claim path`);
    if (!oneOf(claim.scope, CLAIM_SCOPES))
      invalid(`Workflow control ${label} claim scope is invalid`);
    return { path, scope: claim.scope };
  });
}

// --- actors and capabilities ----------------------------------------------

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
): { actor: WorkflowActorContext; senderTaskId: string } {
  const actor = requiredActor(actorValue);
  const { executionId: actorExecutionId, taskId } = actor.identity;
  if (actorExecutionId !== executionId || taskId === undefined) {
    invalid("Workflow control mailbox actor does not match the execution");
  }
  return { actor, senderTaskId: taskId };
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

// --- primitive validators -------------------------------------------------

function exactPayload(
  payload: unknown,
  allowed: readonly string[],
  label: string,
): asserts payload is ControlPayload {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !allowed.includes(key))
  ) {
    invalid(`Workflow control ${label} payload is invalid`);
  }
}

function requiredArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`Workflow control ${label} is invalid`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return requiredArray(value, label).map((item) => requiredString(item, label));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`Workflow control ${label} is invalid`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

/** Opaque continuation tokens: any string, including the empty one. */
function optionalOpaqueString(
  value: unknown,
  label: string,
): string | undefined {
  if (value !== undefined && typeof value !== "string")
    invalid(`Workflow control ${label} is invalid`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid(`Workflow control ${label} is invalid`);
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  label: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`Workflow control ${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(`Workflow control ${label} is invalid`);
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: Readonly<Record<T, true>>,
): value is T {
  return typeof value === "string" && Object.hasOwn(allowed, value);
}

function requiredOneOf<T extends string>(
  value: unknown,
  allowed: Readonly<Record<T, true>>,
  label: string,
): T {
  if (!oneOf(value, allowed)) invalid(`Workflow control ${label} is invalid`);
  return value;
}

function optionalOneOf<T extends string>(
  value: unknown,
  allowed: Readonly<Record<T, true>>,
  label: string,
): T | undefined {
  return value === undefined ? undefined : requiredOneOf(value, allowed, label);
}

/**
 * JSON values are checked with the orchestration JSON rules (finite numbers,
 * plain objects, no cycles, depth 32, 20,000 nodes, 1 MiB strings). Those
 * limits are never stricter than the ones the downstream stores enforce, so
 * stores still apply their own, possibly tighter, limits.
 */
function assertJson(
  value: unknown,
  label: string,
): asserts value is WorkflowOrchestrationJsonValue {
  try {
    immutableWorkflowOrchestrationJson(value);
  } catch (error) {
    if (error instanceof WorkflowOrchestrationControlError) {
      invalid(`Workflow control ${label} is invalid: ${error.message}`);
    }
    throw error;
  }
}

function requiredJson(
  value: unknown,
  label: string,
): WorkflowOrchestrationJsonValue {
  assertJson(value, label);
  return value;
}

function optionalJson(
  value: unknown,
  label: string,
): WorkflowOrchestrationJsonValue | undefined {
  return value === undefined ? undefined : requiredJson(value, label);
}

function optionalJsonObject(
  value: unknown,
  label: string,
): ControlJsonObject | undefined {
  if (value === undefined) return undefined;
  const json = requiredJson(value, label);
  if (!isJsonObject(json)) invalid(`Workflow control ${label} is invalid`);
  return json;
}

function isJsonObject(
  value: WorkflowOrchestrationJsonValue,
): value is ControlJsonObject {
  return isRecord(value);
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
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_UNKNOWN_OPERATION",
    `Unknown workflow control operation: ${String(value)}`,
  );
}
