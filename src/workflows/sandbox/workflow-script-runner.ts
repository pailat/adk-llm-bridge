/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content } from "@google/genai";
import {
  DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS,
  type WorkflowAgentDescriptor,
  type WorkflowAgentFactoryRequest,
} from "../agents/workflow-agent-factory.js";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  MAX_WORKFLOW_AGENT_REVISION_LENGTH,
  WorkflowError,
  type WorkflowParallelOptions,
  type WorkflowStep,
  type WorkflowStepFailure,
  type WorkflowStepOutcome,
  type WorkflowStepResult,
} from "../contracts.js";
import type { WorkflowUserEvent } from "../events.js";
import {
  WORKFLOW_SCRIPT_PROTOCOL,
  WORKFLOW_SCRIPT_PROTOCOL_VERSION,
  type WorkflowScriptFinalOperation,
  type WorkflowScriptHost,
  type WorkflowScriptOperation,
} from "./protocol.js";
import type {
  WorkflowScriptGeneratorTurn,
  WorkflowScriptRuntime,
  WorkflowScriptSessionOptions,
} from "./types.js";

export interface WorkflowScriptExecutionOptions
  extends WorkflowScriptSessionOptions {
  host: WorkflowScriptHost;
  /** Maximum yielded RPC messages, including emit operations. */
  maxMessages?: number;
  /** Maximum simultaneously active guest-created agents. */
  maxAgents?: number;
}

export interface WorkflowScriptExecutionResult {
  output: string | Content | undefined;
  steps: number;
  messages: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isContent(value: unknown): value is Content {
  return isObject(value) && Array.isArray(value.parts);
}

function isStep(value: unknown): value is WorkflowStep {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.agentName === "string" &&
    value.agentName.length > 0 &&
    (value.agentRevision === undefined ||
      isAgentRevision(value.agentRevision)) &&
    (typeof value.input === "string" || isContent(value.input))
  );
}

function isAgentRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    value.length <= MAX_WORKFLOW_AGENT_REVISION_LENGTH
  );
}

function isParallelOptions(value: unknown): value is WorkflowParallelOptions {
  if (!isObject(value)) {
    return false;
  }
  return (
    (value.concurrency === undefined ||
      (Number.isSafeInteger(value.concurrency) &&
        (value.concurrency as number) > 0)) &&
    (value.failureMode === undefined ||
      value.failureMode === "fail-fast" ||
      value.failureMode === "all-settled")
  );
}

function isUserEvent(value: unknown): value is WorkflowUserEvent {
  return (
    isObject(value) &&
    value.type === "custom" &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

function isAgentFactoryRequest(
  value: unknown,
): value is WorkflowAgentFactoryRequest {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["providerId", "name", "config"]) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0
  ) {
    return false;
  }
  if (value.config === undefined) return true;
  if (
    !isObject(value.config) ||
    !hasOnlyKeys(value.config, [
      "description",
      "instruction",
      "workingDirectory",
      "permissions",
    ]) ||
    (value.config.description !== undefined &&
      typeof value.config.description !== "string") ||
    (value.config.instruction !== undefined &&
      typeof value.config.instruction !== "string") ||
    (value.config.workingDirectory !== undefined &&
      typeof value.config.workingDirectory !== "string")
  ) {
    return false;
  }
  const permissions = value.config.permissions;
  if (permissions === undefined) return true;
  return (
    isObject(permissions) &&
    hasOnlyKeys(permissions, ["mode", "allowNetwork", "allowedPaths"]) &&
    (permissions.mode === "read-only" ||
      permissions.mode === "ask" ||
      permissions.mode === "workspace-write" ||
      permissions.mode === "full-access") &&
    (permissions.allowNetwork === undefined ||
      typeof permissions.allowNetwork === "boolean") &&
    (permissions.allowedPaths === undefined ||
      (Array.isArray(permissions.allowedPaths) &&
        permissions.allowedPaths.every((path) => typeof path === "string")))
  );
}

function malformed(message: string): never {
  throw new WorkflowError("WORKFLOW_SCRIPT_INVALID", message);
}

function decodeTurn(
  turn: WorkflowScriptGeneratorTurn,
): WorkflowScriptOperation {
  if (turn.done) {
    return {
      protocol: WORKFLOW_SCRIPT_PROTOCOL,
      version: WORKFLOW_SCRIPT_PROTOCOL_VERSION,
      op: "final",
      output: turn.value,
    };
  }
  if (!isObject(turn.value)) {
    return malformed("Workflow script yielded a malformed RPC operation");
  }
  const value = turn.value;
  if (
    value.protocol !== WORKFLOW_SCRIPT_PROTOCOL ||
    value.version !== WORKFLOW_SCRIPT_PROTOCOL_VERSION
  ) {
    return malformed("Workflow script yielded an unsupported RPC protocol");
  }
  switch (value.op) {
    case "run":
      if (!isStep(value.step)) {
        return malformed("Workflow script yielded a malformed run operation");
      }
      return value as unknown as WorkflowScriptOperation;
    case "parallel":
      if (
        !Array.isArray(value.steps) ||
        !value.steps.every(isStep) ||
        (value.options !== undefined && !isParallelOptions(value.options))
      ) {
        return malformed(
          "Workflow script yielded a malformed parallel operation",
        );
      }
      return value as unknown as WorkflowScriptOperation;
    case "emit":
      if (!isUserEvent(value.event)) {
        return malformed("Workflow script yielded a malformed emit operation");
      }
      return value as unknown as WorkflowScriptOperation;
    case "spawnAgent":
      if (
        !hasOnlyKeys(value, ["protocol", "version", "op", "request"]) ||
        !isAgentFactoryRequest(value.request)
      ) {
        return malformed(
          "Workflow script yielded a malformed spawnAgent operation",
        );
      }
      return value as unknown as WorkflowScriptOperation;
    case "listAgents":
      if (!hasOnlyKeys(value, ["protocol", "version", "op"])) {
        return malformed(
          "Workflow script yielded a malformed listAgents operation",
        );
      }
      return value as unknown as WorkflowScriptOperation;
    case "releaseAgent":
      if (
        !hasOnlyKeys(value, ["protocol", "version", "op", "name"]) ||
        typeof value.name !== "string" ||
        value.name.length === 0
      ) {
        return malformed(
          "Workflow script yielded a malformed releaseAgent operation",
        );
      }
      return value as unknown as WorkflowScriptOperation;
    case "final":
      return malformed(
        "Workflow scripts must return final output, not yield it",
      );
    default:
      return malformed(
        `Workflow script yielded unknown operation: ${String(value.op)}`,
      );
  }
}

function validateOutput(value: unknown): string | Content | undefined {
  if (value === undefined || typeof value === "string" || isContent(value)) {
    return value;
  }
  return malformed(
    "Workflow script final output must be a string or ADK Content",
  );
}

type WorkflowScriptStepResult = Omit<WorkflowStepResult, "events">;
type WorkflowScriptStepOutcome = WorkflowScriptStepResult | WorkflowStepFailure;

function hasStepOutcomeFields(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.agentName === "string" &&
    Number.isSafeInteger(value.attempts) &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.completedAt === "number" &&
    Number.isFinite(value.completedAt)
  );
}

function isStepResult(value: unknown): value is WorkflowStepResult {
  return (
    isObject(value) &&
    value.status === "completed" &&
    typeof value.output === "string" &&
    hasStepOutcomeFields(value)
  );
}

function isStepFailure(value: unknown): value is WorkflowStepFailure {
  return (
    isObject(value) &&
    value.status === "failed" &&
    isObject(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    hasStepOutcomeFields(value)
  );
}

function isStepOutcome(value: unknown): value is WorkflowStepOutcome {
  return isStepResult(value) || isStepFailure(value);
}

/**
 * Exposes only the stable workflow outcome contract to the sandbox. The host
 * keeps the original result, including its complete ADK event history.
 */
function projectStepResult(
  result: WorkflowStepResult,
): WorkflowScriptStepResult {
  return {
    status: "completed",
    id: result.id,
    agentName: result.agentName,
    output: result.output,
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.stateDelta === undefined
      ? {}
      : { stateDelta: result.stateDelta }),
    attempts: result.attempts,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    ...(result.replayed === undefined ? {} : { replayed: result.replayed }),
  };
}

function projectStepFailure(failure: WorkflowStepFailure): WorkflowStepFailure {
  return {
    status: "failed",
    id: failure.id,
    agentName: failure.agentName,
    error: failure.error,
    attempts: failure.attempts,
    startedAt: failure.startedAt,
    completedAt: failure.completedAt,
  };
}

function projectStepOutcome(
  outcome: WorkflowStepOutcome,
): WorkflowScriptStepOutcome {
  return outcome.status === "completed"
    ? projectStepResult(outcome)
    : projectStepFailure(outcome);
}

function projectHostResponse(value: unknown): unknown {
  if (isStepResult(value)) {
    return projectStepResult(value);
  }
  if (Array.isArray(value) && value.every(isStepOutcome)) {
    return value.map(projectStepOutcome);
  }
  return value;
}

function projectAgentDescriptor(value: unknown): WorkflowAgentDescriptor {
  if (
    !isObject(value) ||
    typeof value.providerId !== "string" ||
    value.providerId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    !isAgentRevision(value.revision)
  ) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow dynamic agent host returned a malformed descriptor",
    );
  }
  return {
    providerId: value.providerId,
    name: value.name,
    revision: value.revision,
  };
}

function projectAgentDescriptors(value: unknown): WorkflowAgentDescriptor[] {
  if (!Array.isArray(value)) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow dynamic agent host returned a malformed descriptor list",
    );
  }
  return value.map(projectAgentDescriptor);
}

function unsupportedAgentOperation(operation: string): never {
  throw new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    `Workflow dynamic agent operation is not configured: ${operation}`,
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkflowError("WORKFLOW_ABORTED", "Workflow script was aborted");
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) {
    return operation;
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(
        new WorkflowError("WORKFLOW_ABORTED", "Workflow script was aborted"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function wrapHostError(error: unknown): never {
  if (error instanceof WorkflowError) {
    throw error;
  }
  throw new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    `Workflow script host operation failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Drives a synchronous guest generator while awaiting all ADK work on the host.
 * No host callback or promise is installed inside the QuickJS VM.
 */
export async function runWorkflowScript(
  runtime: WorkflowScriptRuntime,
  options: WorkflowScriptExecutionOptions,
): Promise<WorkflowScriptExecutionResult> {
  const maxSteps =
    options.limits?.maxSteps ?? DEFAULT_WORKFLOW_EXECUTION_LIMITS.maxSteps;
  const maxMessages = options.maxMessages ?? maxSteps * 2 + 1;
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      "maxMessages must be a positive safe integer",
    );
  }
  const maxAgents =
    options.maxAgents ?? DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS.maxAgents;
  if (!Number.isSafeInteger(maxAgents) || maxAgents <= 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      "maxAgents must be a positive safe integer",
    );
  }

  const session = await runtime.createSession(options);
  let steps = 0;
  let messages = 0;
  let response: unknown;
  const activeAgents = new Set<string>();
  try {
    while (true) {
      throwIfAborted(options.signal);
      const operation = decodeTurn(session.next(projectHostResponse(response)));
      if (operation.op === "final") {
        return {
          output: validateOutput(
            (operation as WorkflowScriptFinalOperation).output,
          ),
          steps,
          messages,
        };
      }

      messages += 1;
      if (messages > maxMessages) {
        throw new WorkflowError(
          "WORKFLOW_LIMIT_EXCEEDED",
          `Workflow script exceeded the ${maxMessages} message limit`,
        );
      }
      const requestedSteps =
        operation.op === "run"
          ? 1
          : operation.op === "parallel"
            ? operation.steps.length
            : 0;
      steps += requestedSteps;
      if (steps > maxSteps) {
        throw new WorkflowError(
          "WORKFLOW_LIMIT_EXCEEDED",
          `Workflow script exceeded the ${maxSteps} step limit`,
        );
      }

      try {
        switch (operation.op) {
          case "run":
            response = await abortable(
              options.host.run(operation.step),
              options.signal,
            );
            break;
          case "parallel":
            response = await abortable(
              options.host.parallel(operation.steps, operation.options),
              options.signal,
            );
            break;
          case "emit":
            await abortable(
              Promise.resolve(options.host.emit(operation.event)),
              options.signal,
            );
            response = null;
            break;
          case "spawnAgent": {
            if (
              !activeAgents.has(operation.request.name) &&
              activeAgents.size >= maxAgents
            ) {
              throw new WorkflowError(
                "WORKFLOW_LIMIT_EXCEEDED",
                `Workflow script exceeded the ${maxAgents} dynamic agent limit`,
              );
            }
            const spawned = await abortable(
              Promise.resolve(
                options.host.spawnAgent?.(operation.request) ??
                  unsupportedAgentOperation("spawnAgent"),
              ),
              options.signal,
            );
            const descriptor = projectAgentDescriptor(spawned);
            if (
              descriptor.name !== operation.request.name ||
              descriptor.providerId !== operation.request.providerId
            ) {
              throw new WorkflowError(
                "WORKFLOW_EXECUTION_ERROR",
                "Workflow dynamic agent host returned a mismatched descriptor",
              );
            }
            activeAgents.add(descriptor.name);
            response = descriptor;
            break;
          }
          case "listAgents": {
            const listed = await abortable(
              Promise.resolve(
                options.host.listAgents?.() ??
                  unsupportedAgentOperation("listAgents"),
              ),
              options.signal,
            );
            response = projectAgentDescriptors(listed);
            break;
          }
          case "releaseAgent": {
            const released = await abortable(
              Promise.resolve(
                options.host.releaseAgent?.(operation.name) ??
                  unsupportedAgentOperation("releaseAgent"),
              ),
              options.signal,
            );
            if (typeof released !== "boolean") {
              throw new WorkflowError(
                "WORKFLOW_EXECUTION_ERROR",
                "Workflow dynamic agent host returned a malformed release result",
              );
            }
            if (released) activeAgents.delete(operation.name);
            response = released;
            break;
          }
        }
      } catch (error) {
        wrapHostError(error);
      }
    }
  } finally {
    session.dispose();
  }
}
