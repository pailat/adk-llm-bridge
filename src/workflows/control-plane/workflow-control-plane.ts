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
  WorkflowTaskListRequest,
  WorkflowTaskMessageAppendRequest,
  WorkflowTaskMessageReadRequest,
  WorkflowTaskResumeRequest,
  WorkflowTaskSpawnRequest,
} from "../tasks/contracts.js";
import type { WorkflowTaskController } from "../tasks/controller.js";

export const WORKFLOW_CONTROL_PROTOCOL =
  "adk-llm-bridge/workflow-control" as const;
export const WORKFLOW_CONTROL_PROTOCOL_VERSION = 1 as const;

export interface WorkflowControlPlaneEnvelope {
  protocol: typeof WORKFLOW_CONTROL_PROTOCOL;
  version: typeof WORKFLOW_CONTROL_PROTOCOL_VERSION;
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
    | { operation: "task.spawn"; payload: WorkflowTaskSpawnRequest }
    | { operation: "task.resume"; payload: WorkflowTaskResumeRequest }
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
        payload: WorkflowTaskMessageAppendRequest;
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
  );

export interface WorkflowControlPlaneConfig {
  executions: WorkflowExecutionController;
  tasks: WorkflowTaskController;
  artifacts: WorkflowArtifactStore;
  integration: IntegrationGate;
}

export interface WorkflowControlPlaneDispatchOptions {
  /** Host-only cancellation for long-poll operations. Never serialized. */
  signal?: AbortSignal;
}

export type WorkflowControlPlaneErrorCode =
  | "WORKFLOW_CONTROL_INVALID_REQUEST"
  | "WORKFLOW_CONTROL_UNKNOWN_OPERATION";

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
      case "task.spawn":
        return await this.#tasks.spawn(normalized.payload);
      case "task.resume":
        return await this.#tasks.resume(normalized.payload);
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
      case "task.mailbox.send":
        return await this.#tasks.send(normalized.payload);
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
