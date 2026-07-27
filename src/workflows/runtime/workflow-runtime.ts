/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
} from "@google/adk";
import type { Content } from "@google/genai";
import type {
  AgentInvocationGateway,
  AgentInvocationResult,
} from "../../runtime/agent-invocation-gateway.js";
import type {
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
import { ADKSessionCheckpointStore } from "../checkpoint/store.js";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  type WorkflowContext,
  WorkflowError,
  type WorkflowExecutionLimits,
  type WorkflowExecutionSummary,
  type WorkflowOutput,
  type WorkflowParallelOptions,
  type WorkflowStep,
  type WorkflowStepFailure,
  type WorkflowStepOutcome,
  type WorkflowStepResult,
} from "../contracts.js";
import type { TrustedWorkflowDefinition } from "../definition.js";
import type {
  WorkflowCheckpointSavedEvent,
  WorkflowCompletedEvent,
  WorkflowCustomEvent,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowOutputEvent,
  WorkflowStartedEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowStepReplayedEvent,
  WorkflowStepStartedEvent,
  WorkflowUserEvent,
} from "../events.js";
import { AsyncSemaphore } from "./async-semaphore.js";
import { WorkflowCheckpointCoordinator } from "./workflow-checkpoint-coordinator.js";

export type WorkflowExecutionIdResolver = (
  context: InvocationContext,
) => string | Promise<string>;

export interface WorkflowStepHookContext {
  definition: TrustedWorkflowDefinition;
  executionId: string;
  step: WorkflowStep;
}

/** Internal extension point used by durable runtimes without coupling the gateway. */
export interface WorkflowRuntimeHooks {
  beforeStep?(
    context: WorkflowStepHookContext,
  ): WorkflowStepResult | undefined | Promise<WorkflowStepResult | undefined>;
  afterStep?(
    context: WorkflowStepHookContext,
    result: WorkflowStepResult,
  ): void | Promise<void>;
  stepFailed?(
    context: WorkflowStepHookContext,
    failure: WorkflowStepFailure,
  ): void | Promise<void>;
}

export interface WorkflowRuntimeConfig {
  definition: TrustedWorkflowDefinition;
  parentContext: InvocationContext;
  agentName: string;
  declaredAgents: ReadonlyMap<string, BaseAgent>;
  gateway: AgentInvocationGateway;
  eventSink: (event: Event) => void | Promise<void>;
  hooks?: WorkflowRuntimeHooks;
  checkpointStore?: WorkflowCheckpointStore;
  resolveExecutionId?: WorkflowExecutionIdResolver;
}

/** Executes one trusted workflow definition inside an ADK invocation. */
export class WorkflowRuntime {
  readonly #definition: TrustedWorkflowDefinition;
  readonly #parentContext: InvocationContext;
  readonly #agentName: string;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;
  readonly #gateway: AgentInvocationGateway;
  readonly #eventSink: (event: Event) => void | Promise<void>;
  readonly #hooks?: WorkflowRuntimeHooks;
  readonly #checkpointStore: WorkflowCheckpointStore;
  readonly #resolveExecutionId: WorkflowExecutionIdResolver;
  readonly #limits: Required<WorkflowExecutionLimits>;
  readonly #globalSemaphore: AsyncSemaphore;
  readonly #agentSemaphores = new WeakMap<BaseAgent, AsyncSemaphore>();
  readonly #seenStepIds = new Set<string>();
  #executionSignal?: AbortSignal;
  #executionId?: string;
  #checkpointCoordinator?: WorkflowCheckpointCoordinator;
  #stepCount = 0;
  #replayedStepCount = 0;

  constructor(config: WorkflowRuntimeConfig) {
    this.#definition = config.definition;
    this.#parentContext = config.parentContext;
    this.#agentName = config.agentName;
    this.#declaredAgents = config.declaredAgents;
    this.#gateway = config.gateway;
    this.#eventSink = config.eventSink;
    this.#hooks = config.hooks;
    this.#checkpointStore =
      config.checkpointStore ?? new ADKSessionCheckpointStore();
    this.#resolveExecutionId =
      config.resolveExecutionId ?? ((context) => context.invocationId);
    this.#limits = validateLimits(config.definition.limits);
    this.#globalSemaphore = new AsyncSemaphore(this.#limits.maxConcurrency);
  }

  async execute(): Promise<WorkflowExecutionSummary> {
    const startedAt = Date.now();
    const abortScope = createExecutionAbortScope(
      this.#parentContext.abortSignal,
      this.#limits.timeoutMs,
    );
    this.#executionSignal = abortScope.signal;
    let checkpointInitialized = false;

    try {
      throwIfAborted(abortScope.signal);
      this.#executionId = await this.#resolveExecutionId(this.#parentContext);
      validateExecutionId(this.#executionId);
      this.#checkpointCoordinator = new WorkflowCheckpointCoordinator({
        definition: this.#definition,
        executionId: this.#executionId,
        input: this.workflowInput(),
        context: this.#parentContext,
        store: this.#checkpointStore,
        onWrite: (write, stepId) => this.emitCheckpointSaved(write, stepId),
      });
      await this.#checkpointCoordinator.initialize();
      checkpointInitialized = true;
      await this.emitWorkflowEvent({
        ...this.envelope(startedAt),
        type: "workflow_started",
      } satisfies WorkflowStartedEvent);

      const output = await this.#definition.handler(this.createContext());
      throwIfAborted(abortScope.signal);
      await this.#checkpointCoordinator.completeWorkflow(output);
      if (output !== undefined) await this.emitOutput(output);
      const summary = this.summary("completed", startedAt);
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "workflow_completed",
        summary,
      } satisfies WorkflowCompletedEvent);
      return summary;
    } catch (caught) {
      const error = asWorkflowError(caught);
      if (checkpointInitialized) {
        await this.#checkpointCoordinator?.failWorkflow(
          error.toJSON(),
          error.code === "WORKFLOW_ABORTED" ? "cancelled" : "failed",
        );
      }
      await this.emitWorkflowEvent(
        {
          ...this.envelope(),
          type: "error",
          error: error.toJSON(),
        } satisfies WorkflowErrorEvent,
        {
          errorCode: error.code,
          errorMessage: error.message,
        },
      );
      throw error;
    } finally {
      abortScope.dispose();
      this.#executionSignal = undefined;
      this.#checkpointCoordinator = undefined;
      this.#executionId = undefined;
    }
  }

  private createContext(): WorkflowContext {
    const input = this.workflowInput();
    return Object.freeze({
      input,
      inputText: contentText(input),
      signal: this.executionSignal(),
      run: (step: WorkflowStep) => this.runStep(step, this.executionSignal()),
      parallel: (
        steps: readonly WorkflowStep[],
        options?: WorkflowParallelOptions,
      ) => this.runParallel(steps, options),
      emit: (event: WorkflowUserEvent) => {
        void this.emitWorkflowEvent({
          ...this.envelope(),
          type: "custom",
          name: event.name,
          ...(event.data === undefined ? {} : { data: event.data }),
        } satisfies WorkflowCustomEvent);
      },
    });
  }

  private async runParallel(
    steps: readonly WorkflowStep[],
    options: WorkflowParallelOptions = {},
  ): Promise<WorkflowStepOutcome[]> {
    validateParallelOptions(options, this.#limits.maxConcurrency);
    const failureMode = options.failureMode ?? "fail-fast";
    const concurrency = options.concurrency ?? this.#limits.maxConcurrency;
    const localSemaphore = new AsyncSemaphore(concurrency);
    const parallelAbort = new AbortController();
    const scope = combineAbortSignals([
      this.executionSignal(),
      parallelAbort.signal,
    ]);

    const pending = steps.map((step) =>
      localSemaphore.use(scope.signal, async () => {
        try {
          return await this.runStep(step, scope.signal);
        } catch (caught) {
          if (failureMode === "fail-fast") throw caught;
          return failureFromError(step, caught);
        }
      }),
    );

    try {
      return await Promise.all(pending);
    } catch (caught) {
      parallelAbort.abort(caught);
      await Promise.allSettled(pending);
      throw caught;
    } finally {
      scope.dispose();
    }
  }

  private async runStep(
    step: WorkflowStep,
    signal: AbortSignal,
  ): Promise<WorkflowStepResult> {
    throwIfAborted(signal);
    validateStep(step);
    if (this.#seenStepIds.has(step.id)) {
      throw new WorkflowError(
        "WORKFLOW_STEP_MISMATCH",
        `Workflow step id must be unique: ${step.id}`,
        { stepId: step.id },
      );
    }
    this.#seenStepIds.add(step.id);
    this.#stepCount++;
    if (this.#stepCount > this.#limits.maxSteps) {
      throw new WorkflowError(
        "WORKFLOW_LIMIT_EXCEEDED",
        `Workflow exceeded the maximum of ${this.#limits.maxSteps} steps`,
        { limit: this.#limits.maxSteps, stepId: step.id },
      );
    }
    const declaredAgent = this.#declaredAgents.get(step.agentName);
    if (!declaredAgent) {
      throw new WorkflowError(
        "WORKFLOW_UNKNOWN_AGENT",
        `Workflow may only invoke a directly declared sub-agent: ${step.agentName}`,
        { agentName: step.agentName, stepId: step.id },
      );
    }

    const hookContext = {
      definition: this.#definition,
      executionId: this.executionId(),
      step,
    } satisfies WorkflowStepHookContext;
    const prepared = await this.checkpointCoordinator().prepareStep(step);
    throwIfAborted(signal);
    if (prepared.resolution.action === "replay") {
      const result = {
        ...prepared.resolution.result,
        replayed: true,
      } satisfies WorkflowStepResult;
      this.#replayedStepCount++;
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "step_replayed",
        result,
      } satisfies WorkflowStepReplayedEvent);
      return result;
    }

    const hookResult = await this.#hooks?.beforeStep?.(hookContext);
    throwIfAborted(signal);
    if (hookResult) {
      const result = {
        ...hookResult,
        replayed: true,
      } satisfies WorkflowStepResult;
      await this.checkpointCoordinator().completeStep(result);
      this.#replayedStepCount++;
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "step_replayed",
        result,
      } satisfies WorkflowStepReplayedEvent);
      return result;
    }

    const maxAttempts = validateRetry(step, this.#limits.maxAttemptsPerStep);
    const startedAt = Date.now();
    let lastError: WorkflowError | undefined;
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      const attempt = prepared.resolution.attempt + attemptIndex;
      if (attemptIndex > 0) {
        await retryDelay(step, attemptIndex, signal);
        await this.checkpointCoordinator().startAttempt(
          step,
          prepared.inputHash,
          attempt,
        );
      }
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "step_started",
        step,
        attempt,
      } satisfies WorkflowStepStartedEvent);

      const result = await this.runAgentAttempt(step, declaredAgent, signal);
      throwIfAborted(signal);
      if (!result.error) {
        const completed = stepResult(step, result, attempt, startedAt);
        await this.checkpointCoordinator().completeStep(completed);
        await this.#hooks?.afterStep?.(hookContext, completed);
        await this.emitWorkflowEvent({
          ...this.envelope(),
          type: "step_completed",
          result: completed,
        } satisfies WorkflowStepCompletedEvent);
        return completed;
      }

      lastError = new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Workflow step ${step.id} failed: ${result.error}`,
        { agentName: step.agentName, stepId: step.id, attempt },
      );
      const failure = failureFromError(step, lastError, attempt, startedAt);
      await this.checkpointCoordinator().failStep(failure);
    }

    const failure = failureFromError(
      step,
      lastError ?? new Error(`Workflow step ${step.id} failed`),
      prepared.resolution.attempt + maxAttempts - 1,
      startedAt,
    );
    await this.#hooks?.stepFailed?.(hookContext, failure);
    await this.emitWorkflowEvent({
      ...this.envelope(),
      type: "step_failed",
      failure,
    } satisfies WorkflowStepFailedEvent);
    throw lastError;
  }

  private async runAgentAttempt(
    step: WorkflowStep,
    agent: BaseAgent,
    signal: AbortSignal,
  ): Promise<AgentInvocationResult> {
    let agentSemaphore = this.#agentSemaphores.get(agent);
    if (!agentSemaphore) {
      agentSemaphore = new AsyncSemaphore(1);
      this.#agentSemaphores.set(agent, agentSemaphore);
    }
    return agentSemaphore.use(signal, () =>
      this.#globalSemaphore.use(signal, () =>
        this.#gateway.run({
          agentName: step.agentName,
          input: stepInputContent(step),
          parentContext: this.#parentContext,
          branch: childBranch(this.#parentContext.branch, step.agentName),
          abortSignal: signal,
          eventSink: (event) => this.#eventSink(event),
        }),
      ),
    );
  }

  private executionSignal(): AbortSignal {
    if (!this.#executionSignal) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow runtime is not executing",
      );
    }
    return this.#executionSignal;
  }

  private executionId(): string {
    return this.#executionId?.trim()
      ? this.#executionId
      : this.#parentContext.invocationId;
  }

  private checkpointCoordinator(): WorkflowCheckpointCoordinator {
    if (!this.#checkpointCoordinator) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow checkpoint coordinator is not initialized",
      );
    }
    return this.#checkpointCoordinator;
  }

  private workflowInput(): Content {
    return (
      this.#parentContext.userContent ?? {
        role: "user",
        parts: [],
      }
    );
  }

  private async emitCheckpointSaved(
    write: WorkflowCheckpointWrite,
    stepId?: string,
  ): Promise<void> {
    await this.emitWorkflowEvent(
      {
        ...this.envelope(),
        type: "checkpoint_saved",
        checkpointKey: write.checkpointKey,
        ...(stepId ? { stepId } : {}),
      } satisfies WorkflowCheckpointSavedEvent,
      { actions: createEventActions({ stateDelta: write.stateDelta }) },
    );
  }

  private async emitOutput(
    output: Exclude<WorkflowOutput, undefined>,
  ): Promise<void> {
    const content =
      typeof output === "string"
        ? { role: "model", parts: [{ text: output }] }
        : output;
    const workflowEvent = {
      ...this.envelope(),
      type: "output",
      content: output,
    } satisfies WorkflowOutputEvent;
    await this.#eventSink(
      createEvent({
        invocationId: this.#parentContext.invocationId,
        author: this.#agentName,
        branch: this.#parentContext.branch,
        content,
        turnComplete: true,
        customMetadata: workflowMetadata(workflowEvent),
      }),
    );
  }

  private async emitWorkflowEvent(
    event: WorkflowEvent,
    extra: Partial<Event> = {},
  ): Promise<void> {
    await this.#eventSink(
      createEvent({
        invocationId: this.#parentContext.invocationId,
        author: this.#agentName,
        branch: this.#parentContext.branch,
        customMetadata: workflowMetadata(event),
        ...extra,
      }),
    );
  }

  private envelope(timestamp = Date.now()) {
    return {
      workflowId: this.#definition.id,
      workflowVersion: this.#definition.version,
      executionId: this.executionId(),
      timestamp,
    };
  }

  private summary(
    status: WorkflowExecutionSummary["status"],
    startedAt: number,
  ): WorkflowExecutionSummary {
    return {
      workflowId: this.#definition.id,
      workflowVersion: this.#definition.version,
      executionId: this.executionId(),
      status,
      steps: this.#stepCount,
      replayedSteps: this.#replayedStepCount,
      startedAt,
      completedAt: Date.now(),
    };
  }
}

function validateLimits(
  limits: WorkflowExecutionLimits | undefined,
): Required<WorkflowExecutionLimits> {
  const merged = { ...DEFAULT_WORKFLOW_EXECUTION_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Workflow limit ${name} must be greater than zero`,
        { limit: name, value },
      );
    }
  }
  for (const name of [
    "maxSteps",
    "maxConcurrency",
    "maxAttemptsPerStep",
  ] as const) {
    if (!Number.isInteger(merged[name])) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Workflow limit ${name} must be an integer`,
      );
    }
  }
  return merged;
}

function validateExecutionId(executionId: string): void {
  if (typeof executionId !== "string" || !executionId.trim()) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow execution id resolver must return a non-empty string",
    );
  }
}

function validateStep(step: WorkflowStep): void {
  if (!step.id?.trim()) {
    throw new WorkflowError(
      "WORKFLOW_STEP_MISMATCH",
      "Workflow step id is required",
    );
  }
  if (!step.agentName?.trim()) {
    throw new WorkflowError(
      "WORKFLOW_UNKNOWN_AGENT",
      "Workflow step agentName is required",
      { stepId: step.id },
    );
  }
}

function validateRetry(step: WorkflowStep, limit: number): number {
  const attempts = step.retry?.maxAttempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > limit) {
    throw new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `Step ${step.id} maxAttempts must be between 1 and ${limit}`,
      { stepId: step.id, maxAttempts: attempts, limit },
    );
  }
  for (const [name, value] of Object.entries(step.retry ?? {})) {
    if (name !== "maxAttempts" && value !== undefined && value < 0) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Step ${step.id} retry ${name} cannot be negative`,
      );
    }
  }
  return attempts;
}

function validateParallelOptions(
  options: WorkflowParallelOptions,
  maxConcurrency: number,
): void {
  if (
    options.concurrency !== undefined &&
    (!Number.isInteger(options.concurrency) ||
      options.concurrency < 1 ||
      options.concurrency > maxConcurrency)
  ) {
    throw new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `Parallel concurrency must be between 1 and ${maxConcurrency}`,
      { concurrency: options.concurrency, limit: maxConcurrency },
    );
  }
}

function stepInputContent(step: WorkflowStep): Content {
  return typeof step.input === "string"
    ? { role: "user", parts: [{ text: step.input }] }
    : step.input;
}

function stepResult(
  step: WorkflowStep,
  invocation: AgentInvocationResult,
  attempts: number,
  startedAt: number,
): WorkflowStepResult {
  const content = [...invocation.events]
    .reverse()
    .find((event) => !event.partial && event.content)?.content;
  return {
    status: "completed",
    id: step.id,
    agentName: invocation.agentName,
    output: invocation.output,
    ...(content ? { content } : {}),
    events: invocation.events,
    ...(invocation.stateDelta ? { stateDelta: invocation.stateDelta } : {}),
    attempts,
    startedAt,
    completedAt: Date.now(),
  };
}

function failureFromError(
  step: WorkflowStep,
  caught: unknown,
  attempts = 1,
  startedAt = Date.now(),
): WorkflowStepFailure {
  return {
    status: "failed",
    id: step.id,
    agentName: step.agentName,
    error: asWorkflowError(caught).toJSON(),
    attempts,
    startedAt,
    completedAt: Date.now(),
  };
}

function asWorkflowError(caught: unknown): WorkflowError {
  if (caught instanceof WorkflowError) return caught;
  return new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    caught instanceof Error ? caught.message : String(caught),
  );
}

function contentText(content: Content): string {
  return (content.parts ?? [])
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string")
    .join("");
}

function childBranch(parent: string | undefined, agentName: string): string {
  return parent ? `${parent}.${agentName}` : agentName;
}

async function retryDelay(
  step: WorkflowStep,
  failedAttempt: number,
  signal: AbortSignal,
): Promise<void> {
  const base = step.retry?.delayMs ?? 0;
  const multiplier = step.retry?.backoffMultiplier ?? 1;
  const calculated = base * multiplier ** Math.max(0, failedAttempt - 1);
  const delay = Math.min(calculated, step.retry?.maxDelayMs ?? calculated);
  if (delay > 0) await abortableDelay(delay, signal);
}

function createExecutionAbortScope(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(
      parentSignal?.reason ??
        new WorkflowError("WORKFLOW_ABORTED", "Workflow execution aborted"),
    );
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(
      new WorkflowError(
        "WORKFLOW_ABORTED",
        `Workflow execution timed out after ${timeoutMs}ms`,
        { timeoutMs },
      ),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

function combineAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of signals) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abort();
      break;
    }
    listeners.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof WorkflowError) throw signal.reason;
  throw new WorkflowError(
    "WORKFLOW_ABORTED",
    signal.reason instanceof Error
      ? signal.reason.message
      : typeof signal.reason === "string"
        ? signal.reason
        : "Workflow execution aborted",
  );
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function workflowMetadata(event: WorkflowEvent): Record<string, unknown> {
  return {
    title: workflowEventTitle(event),
    workflow: true,
    workflowEvent: event,
  };
}

function workflowEventTitle(event: WorkflowEvent): string {
  switch (event.type) {
    case "workflow_started":
      return `Workflow ${event.workflowId}: started`;
    case "step_started":
      return `Workflow ${event.workflowId}: ${event.step.id} started`;
    case "step_completed":
      return `Workflow ${event.workflowId}: ${event.result.id} completed`;
    case "step_failed":
      return `Workflow ${event.workflowId}: ${event.failure.id} failed`;
    case "step_replayed":
      return `Workflow ${event.workflowId}: ${event.result.id} replayed`;
    case "checkpoint_saved":
      return `Workflow ${event.workflowId}: checkpoint saved`;
    case "output":
      return `Workflow ${event.workflowId}: output`;
    case "error":
      return `Workflow ${event.workflowId}: error`;
    case "workflow_completed":
      return `Workflow ${event.workflowId}: completed`;
    case "custom":
      return `Workflow ${event.workflowId}: ${event.name}`;
  }
}
