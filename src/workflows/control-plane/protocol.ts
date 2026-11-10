import type {
  WorkflowExecutionEventReadRequest,
  WorkflowExecutionListRequest,
  WorkflowExecutionRequest,
  WorkflowExecutionResumeRequest,
} from "../execution/contracts.js";
import type { WorkflowOwnershipChangeSetValidationRequest } from "../orchestration/change-set-validator.js";
import type { WorkflowPlan } from "../orchestration/contracts.js";
import type {
  WorkflowOwnershipClaimRequest,
  WorkflowOwnershipDecisionRequest,
  WorkflowOwnershipProposalRequest,
  WorkflowOwnershipReleaseRequest,
  WorkflowOwnershipScope,
  WorkflowOwnershipTransferRequest,
} from "../orchestration/ownership-controller.js";
import type { IntegrationGateRequest } from "../resources/integration-gate.js";
import type {
  WorkflowArtifactInput,
  WorkflowArtifactKey,
  WorkflowArtifactListInput,
} from "../resources/workflow-artifact-store.js";
import type {
  WorkflowTaskHandle,
  WorkflowTaskJsonValue,
  WorkflowTaskListRequest,
  WorkflowTaskMessageReadRequest,
  WorkflowTaskResumeRequest,
} from "../tasks/contracts.js";
import type { WorkflowTaskSweepRequest } from "../tasks/dispatcher.js";

/** Protocol name every control request carries in `protocol`. */
export const WORKFLOW_CONTROL_PROTOCOL =
  "adk-llm-bridge/workflow-control" as const;
/** Protocol version every control request carries in `version`. */
export const WORKFLOW_CONTROL_PROTOCOL_VERSION = 1 as const;

/** Protocol fields shared by every {@link WorkflowControlPlaneRequest}. */
export interface WorkflowControlPlaneEnvelope {
  /** Must equal {@link WORKFLOW_CONTROL_PROTOCOL}. */
  protocol: typeof WORKFLOW_CONTROL_PROTOCOL;
  /** Must equal {@link WORKFLOW_CONTROL_PROTOCOL_VERSION}. */
  version: typeof WORKFLOW_CONTROL_PROTOCOL_VERSION;
}

/**
 * Payload of `task.spawn`.
 *
 * @remarks
 * `operationId` makes a retried spawn idempotent when the control plane runs
 * with an orchestration authority; trusted host mode does not forward it.
 */
export interface WorkflowControlTaskSpawnPayload extends WorkflowTaskHandle {
  /** Id of the agent definition to run in the new task. */
  agentId: string;
  /** JSON input for the new task. */
  input?: WorkflowTaskJsonValue;
  /** Caller-chosen id that makes a retried spawn idempotent. */
  operationId: string;
}

/**
 * Payload of `task.mailbox.send`; the sender is the host-authenticated actor's
 * task, never a payload field.
 */
export interface WorkflowControlTaskMailboxSendPayload
  extends WorkflowTaskHandle {
  /** JSON message body. */
  payload: WorkflowTaskJsonValue;
  /** Caller-chosen id that makes a retried send idempotent. */
  operationId: string;
}

/**
 * A control request: the protocol envelope plus one operation and its JSON
 * payload. Pass it to {@link WorkflowControlPlane.dispatch}.
 */
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
    | { operation: "artifact.get"; payload: WorkflowArtifactKey }
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
