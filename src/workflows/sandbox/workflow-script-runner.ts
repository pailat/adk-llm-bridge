/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { Content } from "@google/genai";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
  type WorkflowParallelOptions,
  type WorkflowStep,
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
}

export interface WorkflowScriptExecutionResult {
  output: string | Content | undefined;
  steps: number;
  messages: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    (typeof value.input === "string" || isContent(value.input))
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

  const session = await runtime.createSession(options);
  let steps = 0;
  let messages = 0;
  let response: unknown;
  try {
    while (true) {
      throwIfAborted(options.signal);
      const operation = decodeTurn(session.next(response));
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
        }
      } catch (error) {
        wrapHostError(error);
      }
    }
  } finally {
    session.dispose();
  }
}
