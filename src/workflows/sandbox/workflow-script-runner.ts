import type { Content } from "@google/genai";
import {
  DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS,
  type WorkflowAgentDescriptor,
  type WorkflowAgentFactoryRequest,
} from "../agents/workflow-agent-factory.js";
import {
  MAX_WORKFLOW_AGENT_REVISION_LENGTH,
  WorkflowError,
  type WorkflowParallelOptions,
  type WorkflowStep,
  type WorkflowStepFailure,
  type WorkflowStepOutcome,
  type WorkflowStepResult,
} from "../contracts.js";
import type { WorkflowUserEvent } from "../events.js";
import { attachCause } from "../internal/error-support.js";
import {
  resolveStepLimits,
  StepBudget,
  type StepLimits,
} from "../internal/step-limit.js";
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

/** Options for {@link runWorkflowScript}. */
export interface WorkflowScriptExecutionOptions
  extends WorkflowScriptSessionOptions {
  /** Host capabilities the script reaches through yielded operations. */
  host: WorkflowScriptHost;
  /**
   * Set when the host may answer a step from a checkpoint instead of running
   * its agent.
   *
   * @remarks
   * Without it every requested step counts toward `limits.maxSteps` before the
   * host sees it. With it the runner cannot know in advance which steps
   * replay, so it enforces only the combined bound: it refuses a request that
   * would take the steps of this call past `maxSteps + maxReplayedSteps`, with
   * `limitName: "maxSteps + maxReplayedSteps"`. The host owns the per-kind
   * bounds and must refuse a step over `maxSteps` before running its agent, and
   * a replayed step over `maxReplayedSteps`, as the workflow runtime does.
   *
   * @defaultValue `false`
   */
  replaysFromCheckpoint?: boolean;
  /**
   * Maximum yielded RPC messages, including emit operations.
   *
   * @defaultValue Twice the step limit plus one; the step limit is
   * `maxSteps + maxReplayedSteps` when `replaysFromCheckpoint` is set.
   */
  maxMessages?: number;
  /**
   * Maximum simultaneously active guest-created agents.
   *
   * @defaultValue `DEFAULT_WORKFLOW_AGENT_FACTORY_LIMITS.maxAgents`
   */
  maxAgents?: number;
}

/** Outcome of a completed {@link runWorkflowScript} call. */
export interface WorkflowScriptExecutionResult {
  /** Final output the script returned, if any. */
  output: string | Content | undefined;
  /** Number of steps the script requested. */
  steps: number;
  /** Number of operations the script yielded before returning. */
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

/**
 * Content as host agents read it: an optional string `role` and `parts` that
 * are all objects. ADK dereferences every part, so a `null` or scalar part
 * would fail inside the host instead of as an invalid script.
 */
function isContent(value: unknown): value is Content {
  return (
    isObject(value) &&
    (value.role === undefined || typeof value.role === "string") &&
    Array.isArray(value.parts) &&
    value.parts.every(isObject)
  );
}

const STEP_KEYS = [
  "id",
  "agentName",
  "agentRevision",
  "input",
  "writePaths",
  "retry",
  "resumePolicy",
  "metadata",
] as const;
const RETRY_KEYS = [
  "maxAttempts",
  "delayMs",
  "backoffMultiplier",
  "maxDelayMs",
] as const;

function isStep(value: unknown): value is WorkflowStep {
  if (!isObject(value) || !hasOnlyKeys(value, STEP_KEYS)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.agentName === "string" &&
    value.agentName.length > 0 &&
    (value.agentRevision === undefined ||
      isAgentRevision(value.agentRevision)) &&
    (typeof value.input === "string" || isContent(value.input)) &&
    (value.writePaths === undefined ||
      (Array.isArray(value.writePaths) &&
        value.writePaths.every((path) => typeof path === "string"))) &&
    (value.retry === undefined || isRetryPolicy(value.retry)) &&
    (value.resumePolicy === undefined ||
      value.resumePolicy === "fail" ||
      value.resumePolicy === "retry") &&
    (value.metadata === undefined || isObject(value.metadata))
  );
}

/** Shape only; the runtime enforces the bounds of each field. */
function isRetryPolicy(value: unknown): boolean {
  return (
    isObject(value) &&
    hasOnlyKeys(value, RETRY_KEYS) &&
    RETRY_KEYS.every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "number" && Number.isFinite(value[key])),
    )
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
  if (!isObject(value) || !hasOnlyKeys(value, ["concurrency", "failureMode"])) {
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
    hasOnlyKeys(value, ["type", "name", "data"]) &&
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
  // The turn comes from guest-controlled JSON; check its shape first.
  if (
    !isObject(turn) ||
    !hasOnlyKeys(turn, ["done", "value"]) ||
    typeof turn.done !== "boolean"
  ) {
    return malformed("Workflow script returned a malformed generator turn");
  }
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
      if (
        !hasOnlyKeys(value, ["protocol", "version", "op", "step"]) ||
        !isStep(value.step)
      ) {
        return malformed("Workflow script yielded a malformed run operation");
      }
      return value as unknown as WorkflowScriptOperation;
    case "parallel":
      if (
        !hasOnlyKeys(value, [
          "protocol",
          "version",
          "op",
          "steps",
          "options",
        ]) ||
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
      if (
        !hasOnlyKeys(value, ["protocol", "version", "op", "event"]) ||
        !isUserEvent(value.event)
      ) {
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

/**
 * Throws `WORKFLOW_ABORTED` when the script's signal aborted; the signal's
 * reason is not used.
 */
function throwIfScriptAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkflowError("WORKFLOW_ABORTED", "Workflow script was aborted");
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  throwIfScriptAborted(signal);
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
  throw attachCause(
    new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      `Workflow script host operation failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
    error,
  );
}

function stepIdOf(step: { id?: unknown } | undefined): string {
  return typeof step?.id === "string" ? step.id : "";
}

/**
 * Refuses a request that would take the steps of this call past
 * `maxSteps + maxReplayedSteps`, naming its first step over that bound.
 */
function admitReplayable(
  limits: StepLimits,
  admitted: number,
  requested: readonly { id?: unknown }[],
): void {
  const bound = limits.maxSteps + limits.maxReplayedSteps;
  const room = bound - admitted;
  if (requested.length <= room) return;
  throw new WorkflowError(
    "WORKFLOW_LIMIT_EXCEEDED",
    `Workflow script exceeded maxSteps + maxReplayedSteps (${bound} steps in one turn); raise limits.maxSteps or limits.maxReplayedSteps and resume the same execution id to continue`,
    {
      limit: bound,
      limitName: "maxSteps + maxReplayedSteps",
      stepId: stepIdOf(requested[room]),
      requestedSteps: admitted,
      maxSteps: limits.maxSteps,
      maxReplayedSteps: limits.maxReplayedSteps,
    },
  );
}

/**
 * Drives a synchronous guest generator while awaiting all ADK work on the host.
 *
 * @remarks
 * No host callback or promise is installed inside the QuickJS VM. Every
 * yielded operation is validated against the protocol before the host sees it,
 * and host results are projected to the stable outcome contract before they
 * are sent back, so the guest never receives raw ADK event history.
 *
 * @param runtime - Script runtime that creates the isolated session.
 * @param options - Script source, input, host capabilities and limits.
 * @returns The final output with the step and message counts.
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when `maxMessages` or `maxAgents` is not a positive safe integer.
 * @throws {@link WorkflowError} with code `WORKFLOW_SCRIPT_INVALID` when the script yields a malformed operation or final output.
 * @throws {@link WorkflowError} with code `WORKFLOW_LIMIT_EXCEEDED` when the message, step or dynamic agent limit is exceeded.
 * @throws {@link WorkflowError} with code `WORKFLOW_ABORTED` when the signal aborts.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when a host operation fails or returns a malformed result.
 */
export async function runWorkflowScript(
  runtime: WorkflowScriptRuntime,
  options: WorkflowScriptExecutionOptions,
): Promise<WorkflowScriptExecutionResult> {
  const replays = options.replaysFromCheckpoint === true;
  const budget = new StepBudget(resolveStepLimits(options.limits));
  const stepBound =
    budget.limits.maxSteps + (replays ? budget.limits.maxReplayedSteps : 0);
  const maxMessages = options.maxMessages ?? stepBound * 2 + 1;
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
      throwIfScriptAborted(options.signal);
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
      const requested =
        operation.op === "run"
          ? [operation.step]
          : operation.op === "parallel"
            ? operation.steps
            : [];
      if (replays) {
        admitReplayable(budget.limits, steps, requested);
      } else {
        for (const step of requested) budget.takeExecuted(stepIdOf(step));
      }
      steps += requested.length;

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
