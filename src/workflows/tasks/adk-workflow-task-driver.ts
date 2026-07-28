/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { type BaseAgent, InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import {
  AgentInvocationGateway,
  type AgentInvocationResult,
} from "../../runtime/agent-invocation-gateway.js";
import type { WorkflowTaskAuthorityPort } from "./authority.js";
import type {
  WorkflowTaskClaimGuard,
  WorkflowTaskDriver,
  WorkflowTaskDriverRequest,
  WorkflowTaskDriverResult,
  WorkflowTaskJsonValue,
  WorkflowTaskOrchestrationBinding,
  WorkflowTaskRecord,
} from "./contracts.js";
import { immutableTaskJson } from "./json.js";

export type AdkWorkflowTaskDriverErrorCode =
  | "ADK_WORKFLOW_TASK_INVALID_CONFIG"
  | "ADK_WORKFLOW_TASK_UNBOUND"
  | "ADK_WORKFLOW_TASK_INVOCATION_FAILED";

export class AdkWorkflowTaskDriverError extends Error {
  readonly code: AdkWorkflowTaskDriverErrorCode;

  constructor(code: AdkWorkflowTaskDriverErrorCode, message: string) {
    super(message);
    this.name = "AdkWorkflowTaskDriverError";
    this.code = code;
  }
}

/** A host-only parent ADK context. It must never be persisted in a task. */
export interface AdkWorkflowInvocationContextLease {
  context: InvocationContext;
  release?(): void | Promise<void>;
}

export interface AdkWorkflowInvocationContextProvider {
  acquire(
    task: WorkflowTaskRecord,
    signal: AbortSignal,
  ):
    | AdkWorkflowInvocationContextLease
    | Promise<AdkWorkflowInvocationContextLease>;
}

/**
 * The durable task capabilities exposed to an ADK agent for one attempt.
 * These functions are host handles and must not be stored in session state.
 */
export type AdkWorkflowTaskCapabilities = Pick<
  WorkflowTaskDriverRequest,
  | "spawn"
  | "send"
  | "readMailbox"
  | "waitForMailbox"
  | "join"
  | "awaitAny"
  | "cancel"
>;

export interface AdkWorkflowTaskCapabilityBindingLease {
  release?(): void | Promise<void>;
}

export interface AdkWorkflowTaskCapabilityBinderRequest {
  context: InvocationContext;
  agent: BaseAgent;
  task: WorkflowTaskRecord;
  capabilities: AdkWorkflowTaskCapabilities;
  signal: AbortSignal;
  /** Undefined only when allowUnboundLegacyTask was explicitly enabled. */
  binding: WorkflowTaskOrchestrationBinding | undefined;
}

export interface AdkWorkflowTaskCapabilityBinder {
  bind(
    request: AdkWorkflowTaskCapabilityBinderRequest,
  ):
    | undefined
    | AdkWorkflowTaskCapabilityBindingLease
    | Promise<undefined | AdkWorkflowTaskCapabilityBindingLease>;
}

export type AdkWorkflowTaskOutputProjector = (
  result: AgentInvocationResult,
  task: WorkflowTaskRecord,
) =>
  | WorkflowTaskJsonValue
  | undefined
  | Promise<WorkflowTaskJsonValue | undefined>;

interface AdkWorkflowTaskDriverConfigBase {
  gateway: AgentInvocationGateway;
  contextProvider: AdkWorkflowInvocationContextProvider;
  /** Live authority for the exact claimed attempt; required for bound tasks. */
  attemptAuthority?: Pick<WorkflowTaskAuthorityPort, "validateAttempt">;
  /** Deny by default: tasks normally require a durable plan/ownership binding. */
  allowUnboundLegacyTask?: boolean;
  outputProjector?: AdkWorkflowTaskOutputProjector;
}

/**
 * Arbitrary BaseAgent implementations need a binder (usually an MCP/tool
 * adapter) to interact with durable workflow capabilities. A host may instead
 * opt into task-aware mode for an agent implementation that already has its
 * own explicit integration; this driver does not inject capabilities in that
 * mode.
 */
export type AdkWorkflowTaskDriverConfig = AdkWorkflowTaskDriverConfigBase &
  (
    | {
        capabilityMode?: "bind";
        capabilityBinder: AdkWorkflowTaskCapabilityBinder;
      }
    | {
        capabilityMode: "task-aware";
        capabilityBinder?: never;
      }
  );

/**
 * Executes durable workflow tasks through real ADK agents.
 *
 * InvocationContext, BaseAgent, capability closures and release handles stay
 * in this host adapter. Only a JSON-safe authority projection reaches the
 * isolated ADK child session. Codex, Claude Code, and other agents therefore
 * require an explicit binder/MCP/tool adapter; no capability is exposed by
 * merely resolving a BaseAgent.
 */
export class AdkWorkflowTaskDriver implements WorkflowTaskDriver {
  readonly #gateway: AgentInvocationGateway;
  readonly #contextProvider: AdkWorkflowInvocationContextProvider;
  readonly #attemptAuthority?: Pick<
    WorkflowTaskAuthorityPort,
    "validateAttempt"
  >;
  readonly #capabilityBinder?: AdkWorkflowTaskCapabilityBinder;
  readonly #allowUnboundLegacyTask: boolean;
  readonly #outputProjector: AdkWorkflowTaskOutputProjector;

  constructor(config: AdkWorkflowTaskDriverConfig) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw invalidConfig("ADK workflow task driver config is invalid");
    }
    if (!(config.gateway instanceof AgentInvocationGateway)) {
      throw invalidConfig("ADK workflow task driver gateway is required");
    }
    if (
      !config.contextProvider ||
      typeof config.contextProvider.acquire !== "function"
    ) {
      throw invalidConfig(
        "ADK workflow task driver context provider is required",
      );
    }
    if (
      config.attemptAuthority !== undefined &&
      (!config.attemptAuthority ||
        typeof config.attemptAuthority.validateAttempt !== "function")
    ) {
      throw invalidConfig("ADK workflow task attempt authority is invalid");
    }
    if (
      config.capabilityMode !== undefined &&
      config.capabilityMode !== "bind" &&
      config.capabilityMode !== "task-aware"
    ) {
      throw invalidConfig("ADK workflow task capability mode is invalid");
    }
    if (
      config.capabilityMode !== "task-aware" &&
      (!config.capabilityBinder ||
        typeof config.capabilityBinder.bind !== "function")
    ) {
      throw invalidConfig(
        "ADK workflow task capability binder is required outside task-aware mode",
      );
    }
    if (
      config.capabilityMode === "task-aware" &&
      config.capabilityBinder !== undefined
    ) {
      throw invalidConfig(
        "Task-aware mode cannot also configure a capability binder",
      );
    }
    if (
      config.allowUnboundLegacyTask !== undefined &&
      typeof config.allowUnboundLegacyTask !== "boolean"
    ) {
      throw invalidConfig("allowUnboundLegacyTask must be boolean");
    }
    if (
      config.outputProjector !== undefined &&
      typeof config.outputProjector !== "function"
    ) {
      throw invalidConfig("ADK workflow task output projector is invalid");
    }

    this.#gateway = config.gateway;
    this.#contextProvider = config.contextProvider;
    this.#attemptAuthority = config.attemptAuthority;
    this.#capabilityBinder = config.capabilityBinder;
    this.#allowUnboundLegacyTask = config.allowUnboundLegacyTask ?? false;
    this.#outputProjector = config.outputProjector ?? defaultOutputProjector;
  }

  async execute(
    request: WorkflowTaskDriverRequest,
  ): Promise<WorkflowTaskDriverResult> {
    if (!request.task.orchestration && !this.#allowUnboundLegacyTask) {
      throw new AdkWorkflowTaskDriverError(
        "ADK_WORKFLOW_TASK_UNBOUND",
        `Workflow task requires an orchestration binding: ${request.task.executionId}/${request.task.taskId}`,
      );
    }

    const validateAttempt = this.#attemptValidator(request.task);
    await validateAttempt?.();

    let contextLease: AdkWorkflowInvocationContextLease | undefined;
    let capabilityLease: AdkWorkflowTaskCapabilityBindingLease | undefined;
    let primaryError: unknown;
    let hasPrimaryError = false;
    let output: WorkflowTaskJsonValue | undefined;

    try {
      contextLease = await this.#contextProvider.acquire(
        request.task,
        request.signal,
      );
      validateContextLease(contextLease);

      const result = await this.#gateway.run({
        agentName: request.task.agentId,
        input: taskInput(request.task),
        parentContext: contextLease.context,
        abortSignal: request.signal,
        sessionState: taskSessionState(request.task),
        sessionStateMode: "replace",
        validateInvocation: validateAttempt,
        prepareContext: async (context, agent) => {
          if (!this.#capabilityBinder) return;
          capabilityLease = validateCapabilityLease(
            await this.#capabilityBinder.bind({
              context,
              agent,
              task: request.task,
              capabilities: taskCapabilities(request),
              signal: request.signal,
              binding: request.task.orchestration,
            }),
          );
        },
      });

      if (result.error) {
        throw new AdkWorkflowTaskDriverError(
          "ADK_WORKFLOW_TASK_INVOCATION_FAILED",
          `ADK workflow task invocation failed for ${request.task.agentId}: ${result.error}`,
        );
      }
      output = normalizeJsonOutput(
        await this.#outputProjector(result, request.task),
      );
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    await release(capabilityLease?.release, capabilityLease, cleanupErrors);
    await release(contextLease?.release, contextLease, cleanupErrors);

    if (hasPrimaryError) {
      attachCleanupErrors(primaryError, cleanupErrors);
      throw primaryError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "ADK workflow task cleanup failed",
      );
    }
    return output === undefined ? {} : { output };
  }

  #attemptValidator(
    task: WorkflowTaskRecord,
  ): (() => Promise<void>) | undefined {
    if (!task.orchestration) return undefined;
    if (!task.claim) {
      throw new AdkWorkflowTaskDriverError(
        "ADK_WORKFLOW_TASK_UNBOUND",
        `Bound workflow task requires a live claim: ${task.executionId}/${task.taskId}`,
      );
    }
    const attemptAuthority = this.#attemptAuthority;
    if (!attemptAuthority) {
      throw invalidConfig(
        "ADK workflow task attempt authority is required for bound tasks",
      );
    }
    const claim = claimGuard(task);
    return () => attemptAuthority.validateAttempt({ task, claim });
  }
}

function taskCapabilities(
  request: WorkflowTaskDriverRequest,
): AdkWorkflowTaskCapabilities {
  return Object.freeze({
    spawn: request.spawn,
    send: request.send,
    readMailbox: request.readMailbox,
    waitForMailbox: request.waitForMailbox,
    join: request.join,
    awaitAny: request.awaitAny,
    cancel: request.cancel,
  });
}

function taskInput(task: WorkflowTaskRecord): Content {
  const text =
    typeof task.input === "string"
      ? task.input
      : task.input === undefined
        ? ""
        : JSON.stringify(task.input);
  return { role: "user", parts: [{ text }] };
}

function taskSessionState(
  task: WorkflowTaskRecord,
): Readonly<Record<string, unknown>> {
  const workflowTask: Record<string, WorkflowTaskJsonValue> = {
    executionId: task.executionId,
    taskId: task.taskId,
  };
  if (task.parentTaskId !== undefined) {
    workflowTask.parentTaskId = task.parentTaskId;
  }
  if (task.orchestration) {
    workflowTask.planRevision = task.orchestration.planRevision;
    workflowTask.ownership = task.orchestration.ownership.map((grant) => ({
      grantId: grant.grantId,
      fencingToken: grant.fencingToken,
    }));
  }
  if (task.claim) {
    workflowTask.claim = {
      workerId: task.claim.workerId,
      leaseId: task.claim.leaseId,
      fencingToken: task.claim.fencingToken,
    };
  }
  return immutableTaskJson({ workflowTask });
}

function claimGuard(task: WorkflowTaskRecord): WorkflowTaskClaimGuard {
  const claim = task.claim;
  if (!claim) {
    throw new AdkWorkflowTaskDriverError(
      "ADK_WORKFLOW_TASK_UNBOUND",
      `Bound workflow task requires a live claim: ${task.executionId}/${task.taskId}`,
    );
  }
  return Object.freeze({
    executionId: task.executionId,
    taskId: task.taskId,
    workerId: claim.workerId,
    leaseId: claim.leaseId,
    fencingToken: claim.fencingToken,
  });
}

function defaultOutputProjector(
  result: AgentInvocationResult,
): WorkflowTaskJsonValue {
  return result.output;
}

function validateContextLease(lease: AdkWorkflowInvocationContextLease): void {
  if (
    !lease ||
    typeof lease !== "object" ||
    !(lease.context instanceof InvocationContext) ||
    (lease.release !== undefined && typeof lease.release !== "function")
  ) {
    throw invalidConfig("ADK workflow invocation context lease is invalid");
  }
}

function validateCapabilityLease(
  lease: undefined | AdkWorkflowTaskCapabilityBindingLease,
): AdkWorkflowTaskCapabilityBindingLease | undefined {
  if (
    lease !== undefined &&
    (!lease ||
      typeof lease !== "object" ||
      (lease.release !== undefined && typeof lease.release !== "function"))
  ) {
    throw invalidConfig("ADK workflow task capability lease is invalid");
  }
  return lease as AdkWorkflowTaskCapabilityBindingLease | undefined;
}

function normalizeJsonOutput(
  output: WorkflowTaskJsonValue | undefined,
): WorkflowTaskJsonValue | undefined {
  if (output === undefined) return undefined;
  try {
    return immutableTaskJson(output);
  } catch {
    throw invalidConfig("ADK workflow task output must be JSON-safe");
  }
}

async function release<T>(
  releaseMethod: (() => void | Promise<void>) | undefined,
  receiver: T,
  errors: unknown[],
): Promise<void> {
  if (!releaseMethod) return;
  try {
    await releaseMethod.call(receiver);
  } catch (error) {
    errors.push(error);
  }
}

function attachCleanupErrors(primary: unknown, cleanupErrors: unknown[]): void {
  if (cleanupErrors.length === 0 || !(primary instanceof Error)) return;
  try {
    Object.defineProperty(primary, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: Object.freeze([...cleanupErrors]),
    });
  } catch {
    // Preserve the primary error even when it is non-extensible.
  }
}

function invalidConfig(message: string): AdkWorkflowTaskDriverError {
  return new AdkWorkflowTaskDriverError(
    "ADK_WORKFLOW_TASK_INVALID_CONFIG",
    message,
  );
}
