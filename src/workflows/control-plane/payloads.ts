import type {
  WorkflowExecutionEventCursor,
  WorkflowExecutionEventReadRequest,
  WorkflowExecutionListRequest,
  WorkflowExecutionRequest,
  WorkflowExecutionResumeRequest,
  WorkflowExecutionStatus,
} from "../execution/contracts.js";
import {
  MAX_WORKFLOW_EVENT_READ_LIMIT,
  MAX_WORKFLOW_EXECUTION_LIST_LIMIT,
} from "../execution/stores.js";
import { isPlainRecord } from "../internal/guards.js";
import type { WorkflowOwnershipChangeSetValidationRequest } from "../orchestration/change-set-validator.js";
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
import {
  immutableWorkflowOrchestrationJson,
  type WorkflowOrchestrationJsonLimits,
} from "../orchestration/json.js";
import type {
  WorkflowOwnershipClaimRequest,
  WorkflowOwnershipDecisionRequest,
  WorkflowOwnershipProposalRequest,
  WorkflowOwnershipReleaseRequest,
  WorkflowOwnershipScope,
  WorkflowOwnershipTransferRequest,
} from "../orchestration/ownership-controller.js";
import type { IntegrationGateRequest } from "../resources/integration-gate.js";
import {
  MAX_WORKFLOW_ARTIFACT_LIST_LIMIT,
  type WorkflowArtifactInput,
  type WorkflowArtifactKey,
  type WorkflowArtifactListInput,
  type WorkflowArtifactReference,
} from "../resources/workflow-artifact-store.js";
import type {
  WorkflowTaskHandle,
  WorkflowTaskListRequest,
  WorkflowTaskMessageCursor,
  WorkflowTaskMessageReadRequest,
  WorkflowTaskResumeRequest,
  WorkflowTaskStatus,
} from "../tasks/contracts.js";
import {
  MAX_WORKFLOW_TASK_SWEEP_LIMIT,
  type WorkflowTaskSweepRequest,
} from "../tasks/dispatcher.js";
import {
  MAX_WORKFLOW_TASK_LIST_LIMIT,
  MAX_WORKFLOW_TASK_MESSAGE_READ_LIMIT,
} from "../tasks/stores.js";
import type {
  WorkflowChangeEntry,
  WorkflowChangeEntryKind,
  WorkflowChangeEntryMode,
  WorkflowChangeSet,
  WorkflowExpectedTarget,
  WorkflowOwnershipFence,
} from "../workspace/change-driver.js";
import { invalid, WorkflowControlPlaneError } from "./errors.js";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  type WorkflowControlPlaneRequest,
  type WorkflowControlTaskMailboxSendPayload,
  type WorkflowControlTaskSpawnPayload,
} from "./protocol.js";

/**
 * Payload validators for the workflow control plane. Each one checks a raw
 * JSON payload (exact keys, types, bounds) and returns a freshly built typed
 * object; JSON fields are the validated frozen copies. Results are
 * revalidated by `controlResult`. Internal module, not exported publicly.
 */

/**
 * Name of a control-plane operation.
 *
 * @internal
 */
export type WorkflowControlOperation = WorkflowControlPlaneRequest["operation"];
/**
 * A raw payload object, before validation.
 *
 * @internal
 */
export type ControlPayload = Record<string, unknown>;
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

/**
 * Execution statuses accepted by `execution.list`.
 *
 * @remarks
 * Each status union has its own table, so a status added to either union is
 * a compile error here until it is listed. A table typed with the
 * intersection of both unions would accept a missing status silently.
 *
 * @internal
 */
export const EXECUTION_STATUSES: Readonly<
  Record<WorkflowExecutionStatus, true>
> = {
  queued: true,
  running: true,
  cancelling: true,
  completed: true,
  failed: true,
  cancelled: true,
};
/**
 * Task statuses accepted by `task.list`; see {@link EXECUTION_STATUSES}.
 *
 * @internal
 */
export const TASK_STATUSES: Readonly<Record<WorkflowTaskStatus, true>> = {
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

/**
 * Checks the request envelope and returns its operation and raw payload.
 *
 * @param request - The request as received from a transport.
 * @returns The known operation and its payload object.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the envelope is malformed, or with code `WORKFLOW_CONTROL_UNKNOWN_OPERATION` for an unknown operation.
 * @internal
 */
export function controlRequest(request: unknown): {
  operation: WorkflowControlOperation;
  payload: ControlPayload;
} {
  if (
    !isPlainRecord(request) ||
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
    !isPlainRecord(request.payload)
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

/**
 * Validates an `execution.start` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The execution request, with JSON fields as frozen copies.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function executionStartPayload(
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

/**
 * Validates an `execution.resume` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The resume request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function executionResumePayload(
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

/**
 * Validates a payload that only names an execution.
 *
 * @param payload - Raw payload of the operation.
 * @returns The execution id.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function executionIdPayload(payload: unknown): string {
  if (
    !isPlainRecord(payload) ||
    Object.keys(payload).some((key) => key !== "executionId") ||
    typeof payload.executionId !== "string" ||
    payload.executionId.length === 0
  ) {
    invalid("Workflow execution identity payload is invalid");
  }
  return payload.executionId;
}

/**
 * Validates an `execution.list` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The list request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function executionListPayload(
  payload: ControlPayload,
): WorkflowExecutionListRequest {
  exactPayload(payload, ["status", "cursor", "limit"], "execution list");
  const status = optionalOneOf(
    payload.status,
    EXECUTION_STATUSES,
    "execution list status",
  );
  const cursor = optionalOpaqueString(payload.cursor, "execution list cursor");
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_EXECUTION_LIST_LIMIT,
    "execution list limit",
  );
  return {
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Validates an `execution.events` payload, including its cursor.
 *
 * @param payload - Raw payload of the operation.
 * @returns The event read request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function executionEventsPayload(
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
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_EVENT_READ_LIMIT,
    "execution events limit",
  );
  return {
    executionId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

// --- tasks ----------------------------------------------------------------

/**
 * Validates a `task.awaitAny` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The task handles.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function awaitAnyPayload(
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

/**
 * Validates a task handle.
 *
 * @param payload - Raw payload of the operation.
 * @returns The handle.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskHandlePayload(payload: unknown): WorkflowTaskHandle {
  exactPayload(payload, ["executionId", "taskId"], "task handle");
  return {
    executionId: requiredString(payload.executionId, "task handle executionId"),
    taskId: requiredString(payload.taskId, "task handle taskId"),
  };
}

/**
 * Returns the shared execution and the task ids of a non-empty handle list.
 *
 * @param handles - Validated task handles.
 * @param label - Operation name used in error messages.
 * @returns The execution id and task ids.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the list is empty or spans executions.
 * @internal
 */
export function taskHandleScope(
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

/**
 * Validates a `task.resume` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The resume request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskResumePayload(
  payload: ControlPayload,
): WorkflowTaskResumeRequest {
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

/**
 * Validates a `task.list` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The list request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskListPayload(
  payload: ControlPayload,
): WorkflowTaskListRequest {
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
  const status = optionalOneOf(
    payload.status,
    TASK_STATUSES,
    "task list status",
  );
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_TASK_LIST_LIMIT,
    "task list limit",
  );
  return {
    executionId,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(status === undefined ? {} : { status }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Validates a `task.mailbox.read` or `task.mailbox.wait` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The read request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskMailboxReadPayload(
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
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_TASK_MESSAGE_READ_LIMIT,
    "task mailbox read limit",
  );
  return {
    executionId,
    taskId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Validates a `task.spawn` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The spawn payload, with `input` as a frozen copy.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskSpawnPayload(
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

/**
 * Validates a `task.mailbox.send` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The send payload, with the message as a frozen copy.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskMailboxSendPayload(
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

/**
 * Validates a `task.sweep` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The sweep request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function taskSweepPayload(
  payload: ControlPayload,
): WorkflowTaskSweepRequest {
  exactPayload(payload, ["executionId", "limit", "cursor"], "task sweep");
  const executionId = requiredString(
    payload.executionId,
    "task sweep executionId",
  );
  // The sweep cursor is opaque and is passed through unchanged.
  const cursor = optionalOpaqueString(payload.cursor, "task sweep cursor");
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_TASK_SWEEP_LIMIT,
    "task sweep limit",
  );
  return {
    executionId,
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

// --- resources ------------------------------------------------------------

/**
 * Validates an `artifact.put` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The artifact input, with JSON fields as frozen copies.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function artifactPutPayload(
  payload: ControlPayload,
): WorkflowArtifactInput {
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

/**
 * Validates an `artifact.get` payload: the execution id and the artifact id.
 *
 * @param payload - Raw payload of the operation.
 * @returns The artifact key.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function artifactKeyPayload(
  payload: ControlPayload,
): WorkflowArtifactKey {
  if (
    Object.keys(payload).some(
      (key) => key !== "executionId" && key !== "artifactId",
    ) ||
    typeof payload.executionId !== "string" ||
    payload.executionId.length === 0 ||
    typeof payload.artifactId !== "string" ||
    payload.artifactId.length === 0
  ) {
    invalid("Workflow artifact identity payload is invalid");
  }
  return { executionId: payload.executionId, artifactId: payload.artifactId };
}

/**
 * Validates an `artifact.list` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The list input, without a signal.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function artifactListPayload(
  payload: ControlPayload,
): Omit<WorkflowArtifactListInput, "signal"> {
  exactPayload(
    payload,
    ["executionId", "taskId", "type", "cursor", "limit"],
    "artifact list",
  );
  const executionId = requiredString(
    payload.executionId,
    "artifact list executionId",
  );
  const taskId = optionalString(payload.taskId, "artifact list taskId");
  const type = optionalString(payload.type, "artifact list type");
  const cursor = optionalOpaqueString(payload.cursor, "artifact list cursor");
  const limit = optionalPageLimit(
    payload.limit,
    MAX_WORKFLOW_ARTIFACT_LIST_LIMIT,
    "artifact list limit",
  );
  return {
    executionId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(type === undefined ? {} : { type }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * Validates an `integration.validate` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The gate request, with `context` as a frozen copy.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function integrationPayload(
  payload: ControlPayload,
): IntegrationGateRequest {
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
 * Validates a `plan.put` payload: the plan's shape and types.
 *
 * @remarks
 * Cross-field rules (unique ids, lane dependencies, waves, ownership layout)
 * stay in `validateWorkflowPlan`, which the plan controller runs.
 *
 * @param payload - Raw payload of the operation.
 * @returns The plan, rebuilt field by field.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function planPutPayload(payload: ControlPayload): WorkflowPlan {
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

/**
 * Validates a payload that names an execution and a plan revision.
 *
 * @param payload - Raw payload.
 * @param label - Operation name used in error messages.
 * @returns The execution id and plan revision.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function planRevisionPayload(
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

/**
 * Validates an `ownership.list` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The ownership scope.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipScopePayload(
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

/**
 * Validates an `ownership.claim` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The claim request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipClaimPayload(
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

/**
 * Validates an `ownership.propose` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The proposal request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipProposalPayload(
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

/**
 * Validates an `ownership.approve` or `ownership.reject` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The decision request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipDecisionPayload(
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

/**
 * Validates an `ownership.transfer` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The transfer request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipTransferPayload(
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

/**
 * Validates an `ownership.release` payload.
 *
 * @param payload - Raw payload of the operation.
 * @returns The release request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipReleasePayload(
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

/**
 * Validates an `ownership.validate` payload, including the change set.
 *
 * @param payload - Raw payload of the operation.
 * @returns The validation request.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` when the payload is invalid.
 * @internal
 */
export function ownershipValidationPayload(
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
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
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

// --- primitive validators -------------------------------------------------

/**
 * Asserts that `payload` is a plain object with only the allowed keys.
 *
 * @param payload - Value to check.
 * @param allowed - Keys the payload may have.
 * @param label - Name used in the error message.
 * @throws {@link WorkflowControlPlaneError} with code `WORKFLOW_CONTROL_INVALID_REQUEST` otherwise.
 * @internal
 */
export function exactPayload(
  payload: unknown,
  allowed: readonly string[],
  label: string,
): asserts payload is ControlPayload {
  if (
    !isPlainRecord(payload) ||
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

/**
 * An optional page size: a positive integer no larger than `maximum`, the
 * bound the services document for that listing.
 */
function optionalPageLimit(
  value: unknown,
  maximum: number,
  label: string,
): number | undefined {
  const limit = optionalPositiveInteger(value, label);
  if (limit !== undefined && limit > maximum)
    invalid(`Workflow control ${label} is invalid`);
  return limit;
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
function requiredJson(
  value: unknown,
  label: string,
): WorkflowOrchestrationJsonValue {
  try {
    // Forward the validated, frozen copy, never the caller's value: an
    // in-process caller cannot change what was checked (getters, later
    // mutation). The copy drops `undefined` members, as the stores do.
    return immutableWorkflowOrchestrationJson<unknown>(
      value,
    ) as WorkflowOrchestrationJsonValue;
  } catch (error) {
    if (error instanceof WorkflowOrchestrationControlError) {
      invalid(`Workflow control ${label} is invalid: ${error.message}`);
    }
    throw error;
  }
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
  return isPlainRecord(value);
}

// --- results --------------------------------------------------------------

type ControlResultShape = "object" | "array" | "object-or-absent";

/** Top-level shape of each operation's result; exhaustive by construction. */
const RESULT_SHAPES: Readonly<
  Record<WorkflowControlOperation, ControlResultShape>
> = {
  "execution.start": "object",
  "execution.resume": "object",
  "execution.status": "object",
  "execution.cancel": "object",
  "execution.list": "object",
  "execution.events": "object",
  "task.spawn": "object",
  "task.resume": "object",
  "task.dispatch": "object",
  "task.recover": "object",
  "task.sweep": "object",
  "task.status": "object",
  "task.cancel": "object",
  "task.list": "object",
  "task.join": "object",
  "task.awaitAny": "object",
  "task.mailbox.send": "object",
  "task.mailbox.read": "object",
  "task.mailbox.wait": "object",
  "artifact.put": "object",
  "artifact.get": "object-or-absent",
  "artifact.list": "object",
  "integration.validate": "object",
  "plan.put": "object",
  "plan.get": "object",
  "plan.list": "array",
  "plan.activate": "object",
  "ownership.claim": "object",
  "ownership.propose": "object",
  "ownership.approve": "object",
  "ownership.reject": "object",
  "ownership.transfer": "object",
  "ownership.release": "object",
  "ownership.list": "array",
  "ownership.validate": "object",
};

/**
 * Results hold whole records (and pages of them), so only the JSON rules
 * apply: no node or string cap, and a depth that leaves room for the record
 * around a 32-deep stored value.
 */
const RESULT_JSON_LIMITS: Readonly<WorkflowOrchestrationJsonLimits> =
  Object.freeze({
    maxDepth: 64,
    maxNodes: Number.MAX_SAFE_INTEGER,
    maxStringLength: Number.MAX_SAFE_INTEGER,
  });

/**
 * Revalidates what a controller returned before it reaches a transport.
 *
 * @remarks
 * The value must be JSON (finite numbers, plain objects, no cycles) with the
 * operation's top-level shape: an array for `plan.list` and `ownership.list`,
 * an object or nothing for `artifact.get`, an object otherwise. The copy is
 * frozen, so a transport never holds a controller's live object.
 *
 * @param operation - The operation that produced the result.
 * @param value - What the controller returned.
 * @returns A frozen JSON copy of `value`, or `undefined` for a missing artifact.
 * @throws {@link WorkflowControlPlaneError} with code
 * `WORKFLOW_CONTROL_INVALID_RESULT` when the value is not JSON or has the
 * wrong shape.
 * @internal
 */
export function controlResult(
  operation: WorkflowControlOperation,
  value: unknown,
): unknown {
  const shape = RESULT_SHAPES[operation];
  if (value === undefined && shape === "object-or-absent") return undefined;
  let copy: unknown;
  try {
    copy = immutableWorkflowOrchestrationJson<unknown>(
      value,
      RESULT_JSON_LIMITS,
    );
  } catch (error) {
    if (error instanceof WorkflowOrchestrationControlError) {
      invalidResult(operation, error.message);
    }
    throw error;
  }
  const matches = shape === "array" ? Array.isArray(copy) : isPlainRecord(copy);
  if (!matches)
    invalidResult(
      operation,
      `expected a JSON ${shape === "array" ? "array" : "object"}`,
    );
  return copy;
}

function invalidResult(operation: string, reason: string): never {
  throw new WorkflowControlPlaneError(
    "WORKFLOW_CONTROL_INVALID_RESULT",
    `Workflow control ${operation} result is invalid: ${reason}`,
  );
}
