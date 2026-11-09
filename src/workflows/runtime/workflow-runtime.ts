import {
  type BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from "@google/adk";
import type { Content, Part } from "@google/genai";
import type {
  AgentInvocationGateway,
  AgentInvocationResult,
} from "../../runtime/agent-invocation-gateway.js";
import { hashWorkflowValue } from "../checkpoint/hash.js";
import type {
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
import {
  ADKSessionCheckpointStore,
  WORKFLOW_CHECKPOINT_STATE_PREFIX,
} from "../checkpoint/store.js";
import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  MAX_WORKFLOW_AGENT_REVISION_LENGTH,
  WORKFLOW_AGENT_REVISION_UNVERSIONED,
  WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY,
  type WorkflowAttemptContext,
  type WorkflowAttemptReplay,
  type WorkflowContext,
  WorkflowError,
  type WorkflowExecutionLimits,
  type WorkflowExecutionSummary,
  WorkflowInterruptedError,
  type WorkflowOutput,
  type WorkflowParallelOptions,
  type WorkflowRetryPolicy,
  type WorkflowStep,
  type WorkflowStepFailure,
  type WorkflowStepInterrupt,
  type WorkflowStepOutcome,
  type WorkflowStepResult,
} from "../contracts.js";
import type {
  TrustedWorkflowDefinition,
  WorkflowDefinition,
} from "../definition.js";
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
  WorkflowStepWaitingEvent,
  WorkflowUserEvent,
  WorkflowWaitingEvent,
} from "../events.js";
import { isWorkflowEvent } from "../events.js";
import { withStepSpan, withWorkflowSpan } from "../telemetry.js";
import type {
  WorkflowWorkspaceConfig,
  WorkspaceLease,
} from "../workspace/workspace-adapter.js";
import { AsyncSemaphore } from "./async-semaphore.js";
import { WorkflowCheckpointCoordinator } from "./workflow-checkpoint-coordinator.js";

/**
 * Resolves the durable execution id for an ADK invocation.
 *
 * @remarks
 * Checkpoints are keyed by this id, so it must be stable across a resume.
 */
export type WorkflowExecutionIdResolver = (
  context: InvocationContext,
) => string | Promise<string>;

/** Step identity passed to {@link WorkflowRuntimeHooks}. */
export interface WorkflowStepHookContext {
  /** Trusted definition of the running workflow. */
  definition: TrustedWorkflowDefinition;
  /** Id of the execution the step belongs to. */
  executionId: string;
  /** Step about to run or just finished. */
  step: WorkflowStep;
}

/**
 * Extension point for durable runtimes: observe or replay steps and attempts
 * without coupling the agent invocation gateway to a checkpoint store.
 *
 * @remarks
 * Passed as `runtimeHooks` to {@link WorkflowAgent} and
 * {@link ScriptWorkflowAgent}.
 */
export interface WorkflowRuntimeHooks {
  /**
   * Called before a step runs. Returning a result replays it instead of invoking
   * the agent; returning `undefined` lets the step run. Not called on a resume
   * of a waiting step.
   */
  beforeStep?(
    context: WorkflowStepHookContext,
  ): WorkflowStepResult | undefined | Promise<WorkflowStepResult | undefined>;
  /** Called after a step completes successfully. */
  afterStep?(
    context: WorkflowStepHookContext,
    result: WorkflowStepResult,
  ): void | Promise<void>;
  /** Called after a step fails. */
  stepFailed?(
    context: WorkflowStepHookContext,
    failure: WorkflowStepFailure,
  ): void | Promise<void>;
  /**
   * Looks up a previously confirmed durable result before agent invocation.
   * The runtime validates the returned idempotency key and step identity.
   */
  beforeAttempt?(
    context: WorkflowAttemptContext,
  ):
    | WorkflowAttemptReplay
    | undefined
    | Promise<WorkflowAttemptReplay | undefined>;
  /**
   * Durable outbox boundary. This resolves before the successful step
   * checkpoint is committed, allowing a resume to replay by idempotency key.
   */
  afterAttempt?(
    context: WorkflowAttemptContext,
    result: WorkflowStepResult,
  ): void | Promise<void>;
  /** Observes an unsuccessful agent invocation before its failure checkpoint. */
  attemptFailed?(
    context: WorkflowAttemptContext,
    failure: WorkflowStepFailure,
  ): void | Promise<void>;
}

/**
 * Dependencies and options for {@link WorkflowRuntime}.
 *
 * @internal
 */
export interface WorkflowRuntimeConfig {
  /** Trusted definition to execute. */
  definition: TrustedWorkflowDefinition;
  /**
   * Durable identity used by checkpoints. Defaults to the executable trusted
   * definition, but script adapters provide their original source definition.
   */
  checkpointDefinition?: WorkflowDefinition;
  /** ADK invocation the workflow runs inside. */
  parentContext: InvocationContext;
  /** Name of the workflow agent, used in telemetry and execution id resolution. */
  agentName: string;
  /** Sub-agents a step may invoke, keyed by name; any other agent name is rejected. */
  declaredAgents: ReadonlyMap<string, BaseAgent>;
  /** Gateway through which agent steps are invoked. */
  gateway: AgentInvocationGateway;
  /** Receives each ADK event the runtime produces. */
  eventSink: (event: Event) => void | Promise<void>;
  /** Optional hooks that observe or replay steps and attempts. */
  hooks?: WorkflowRuntimeHooks;
  /** Store for workflow checkpoints. Defaults to the ADK session state store. */
  checkpointStore?: WorkflowCheckpointStore;
  /** Resolves the durable execution id. Defaults to the id of the run waiting for an answer in the session, else the ADK invocation id. */
  resolveExecutionId?: WorkflowExecutionIdResolver;
  /** Workspace coordination for steps that declare `writePaths`; such a step fails without it. */
  workspace?: WorkflowWorkspaceConfig;
  /** Host-owned cancellation signal scoped to this runtime invocation. */
  abortSignal?: AbortSignal;
  /**
   * Publish the final text as parsed JSON on `event.output`, as ADK does for an
   * `LlmAgent` with an `outputSchema`. Falls back to the text when it is not
   * valid JSON.
   */
  structuredOutput?: boolean;
  /**
   * Re-execute steps whose last recorded attempt failed when the same execution
   * is entered again (an ADK node retry with the same invocation id). Steps left
   * `running` stay indeterminate unless they declare `resumePolicy: "retry"`.
   */
  retryFailedSteps?: boolean;
}

/**
 * Executes one trusted workflow definition inside an ADK invocation.
 *
 * @internal
 */
export class WorkflowRuntime {
  readonly #definition: TrustedWorkflowDefinition;
  readonly #checkpointDefinition: WorkflowDefinition;
  readonly #parentContext: InvocationContext;
  readonly #agentName: string;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;
  readonly #gateway: AgentInvocationGateway;
  readonly #eventSink: (event: Event) => void | Promise<void>;
  readonly #hooks?: WorkflowRuntimeHooks;
  readonly #checkpointStore: WorkflowCheckpointStore;
  readonly #resolveExecutionId: WorkflowExecutionIdResolver;
  readonly #workspace?: WorkflowWorkspaceConfig;
  readonly #abortSignal?: AbortSignal;
  readonly #structuredOutput: boolean;
  readonly #retryFailedSteps: boolean;
  readonly #limits: Required<WorkflowExecutionLimits>;
  readonly #globalSemaphore: AsyncSemaphore;
  readonly #agentSemaphores = new WeakMap<BaseAgent, AsyncSemaphore>();
  readonly #seenStepIds = new Set<string>();
  #executionSignal?: AbortSignal;
  #executionId?: string;
  /** Original input restored from a waiting checkpoint (answer turn). */
  #inputOverride?: Content;
  #checkpointCoordinator?: WorkflowCheckpointCoordinator;
  #stepCount = 0;
  #replayedStepCount = 0;

  constructor(config: WorkflowRuntimeConfig) {
    this.#definition = config.definition;
    this.#checkpointDefinition =
      config.checkpointDefinition ?? config.definition;
    this.#parentContext = config.parentContext;
    this.#agentName = config.agentName;
    this.#declaredAgents = config.declaredAgents;
    this.#gateway = config.gateway;
    this.#eventSink = config.eventSink;
    this.#hooks = config.hooks;
    this.#checkpointStore =
      config.checkpointStore ?? new ADKSessionCheckpointStore();
    this.#resolveExecutionId =
      config.resolveExecutionId ??
      ((context) => this.defaultExecutionId(context));
    this.#workspace = config.workspace;
    this.#abortSignal = config.abortSignal;
    this.#structuredOutput = config.structuredOutput === true;
    this.#retryFailedSteps = config.retryFailedSteps === true;
    this.#limits = validateLimits(config.definition.limits);
    this.#globalSemaphore = new AsyncSemaphore(this.#limits.maxConcurrency);
  }

  /**
   * Runs the workflow once, checkpointing every step.
   *
   * @returns The execution summary; its status is `waiting` when steps await input.
   * @throws {@link WorkflowError} when the workflow fails or is aborted; the
   * failure is checkpointed and emitted as an `error` event first.
   */
  execute(): Promise<WorkflowExecutionSummary> {
    return withWorkflowSpan(
      {
        workflowName: this.#agentName,
        sessionId: this.#parentContext.session?.id,
      },
      () => this.executeWorkflow(),
    );
  }

  private async executeWorkflow(): Promise<WorkflowExecutionSummary> {
    const startedAt = Date.now();
    const abortScope = createExecutionAbortScope(
      [this.#parentContext.abortSignal, this.#abortSignal],
      this.#limits.timeoutMs,
    );
    this.#executionSignal = abortScope.signal;
    let checkpointInitialized = false;

    try {
      throwIfAborted(abortScope.signal);
      this.#executionId = await this.#resolveExecutionId(this.#parentContext);
      validateExecutionId(this.#executionId);
      this.#inputOverride = await this.restoreWaitingInput();
      this.#checkpointCoordinator = new WorkflowCheckpointCoordinator({
        definition: this.#checkpointDefinition,
        executionId: this.#executionId,
        input: this.workflowInput(),
        context: this.#parentContext,
        store: this.#checkpointStore,
        retryFailedSteps: this.#retryFailedSteps,
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
      if (caught instanceof WorkflowInterruptedError) {
        // Steps are waiting for input: the checkpoint already records them, so
        // the run ends cleanly and a later turn resumes it.
        const summary = this.summary("waiting", startedAt);
        await this.emitWorkflowEvent({
          ...this.envelope(),
          type: "workflow_waiting",
          summary,
          stepIds: caught.interrupts.map((entry) => entry.stepId),
        } satisfies WorkflowWaitingEvent);
        return summary;
      }
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
    const scopeSignal = AbortSignal.any([
      this.executionSignal(),
      parallelAbort.signal,
    ]);

    const interrupts: WorkflowInterruptedError["interrupts"][number][] = [];
    const pending = steps.map((step) =>
      localSemaphore.use(scopeSignal, async () => {
        try {
          return await this.runStep(step, scopeSignal);
        } catch (caught) {
          if (caught instanceof WorkflowInterruptedError) {
            // A waiting step does not cancel its siblings; the run ends once
            // all of them settled.
            interrupts.push(...caught.interrupts);
            return undefined as unknown as WorkflowStepOutcome;
          }
          if (failureMode === "fail-fast") throw caught;
          return failureFromError(step, caught);
        }
      }),
    );

    try {
      const outcomes = await Promise.all(pending);
      if (interrupts.length > 0) throw new WorkflowInterruptedError(interrupts);
      return outcomes;
    } catch (caught) {
      parallelAbort.abort(caught);
      await Promise.allSettled(pending);
      throw caught;
    }
  }

  private async runStep(
    requestedStep: WorkflowStep,
    signal: AbortSignal,
  ): Promise<WorkflowStepResult> {
    throwIfAborted(signal);
    validateStep(requestedStep);
    const step =
      this.checkpointCoordinator().withStoredAgentRevision(requestedStep);
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

    // A waiting step continues with the answer carried by this turn; without
    // one it keeps waiting and re-emits its pending request.
    const resume =
      prepared.resolution.action === "resume"
        ? await this.resumeOf(
            step,
            prepared.resolution.interrupt,
            prepared.resolution.attempt,
          )
        : undefined;

    // Attempt number of a step left `running` in the checkpoint; cleared once the
    // step completes or its failure is recorded. A resumed step stays `waiting`
    // (still answerable) if its continuation is aborted.
    let unsettledAttempt: number | undefined = resume
      ? undefined
      : prepared.resolution.attempt;
    try {
      const hookResult = resume
        ? undefined
        : await this.#hooks?.beforeStep?.(hookContext);
      throwIfAborted(signal);
      if (hookResult) {
        const result = {
          ...hookResult,
          replayed: true,
        } satisfies WorkflowStepResult;
        await this.checkpointCoordinator().completeStep(result);
        unsettledAttempt = undefined;
        this.#replayedStepCount++;
        await this.emitWorkflowEvent({
          ...this.envelope(),
          type: "step_replayed",
          result,
        } satisfies WorkflowStepReplayedEvent);
        return result;
      }

      const lease = await this.acquireWorkspaceLease(step, signal);
      const leaseLossSignal = lease?.lossSignal;
      const attemptSignal = leaseLossSignal
        ? AbortSignal.any([signal, leaseLossSignal])
        : signal;
      const idempotencyKey = await workflowAttemptIdempotencyKey({
        workflowId: this.#definition.id,
        workflowVersion: this.#definition.version,
        executionId: this.executionId(),
        stepId: step.id,
        agentName: step.agentName,
        agentRevision: normalizedAgentRevision(step.agentRevision),
        inputHash: prepared.inputHash,
      });
      let operationError: unknown;
      try {
        // The answer is consumed by the resumed delegation, so it is not retried.
        const maxAttempts = resume
          ? 1
          : validateRetry(step, this.#limits.maxAttemptsPerStep);
        const startedAt = Date.now();
        let lastError: WorkflowError | undefined;
        for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
          const attempt = prepared.resolution.attempt + attemptIndex;
          if (!(resume && attemptIndex === 0)) unsettledAttempt = attempt;
          const attemptContext = createWorkflowAttemptContext({
            definition: this.#definition,
            executionId: this.executionId(),
            step,
            attempt,
            inputHash: prepared.inputHash,
            idempotencyKey,
            lease,
          });
          throwIfAttemptAborted(attemptSignal, leaseLossSignal, attemptContext);
          if (attemptIndex > 0) {
            await retryDelay(step, attemptIndex, attemptSignal);
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

          const replay = await this.#hooks?.beforeAttempt?.(attemptContext);
          throwIfAttemptAborted(attemptSignal, leaseLossSignal, attemptContext);
          if (replay) {
            const replayed = validateAttemptReplay(attemptContext, replay);
            await this.checkpointCoordinator().completeStep(replayed);
            unsettledAttempt = undefined;
            this.#replayedStepCount++;
            await this.emitWorkflowEvent({
              ...this.envelope(),
              type: "step_replayed",
              result: replayed,
            } satisfies WorkflowStepReplayedEvent);
            return replayed;
          }

          const result = await this.runAgentAttempt(
            step,
            declaredAgent,
            attemptSignal,
            attemptContext,
            attemptIndex === 0 ? resume : undefined,
          );
          throwIfAttemptAborted(attemptSignal, leaseLossSignal, attemptContext);
          if (result.interrupt && !result.error) {
            const interrupt = toStepInterrupt(result.interrupt);
            await this.checkpointCoordinator().waitStep(
              step,
              prepared.inputHash,
              attempt,
              interrupt,
            );
            unsettledAttempt = undefined;
            await this.emitWorkflowEvent({
              ...this.envelope(),
              type: "step_waiting",
              stepId: step.id,
              agentName: step.agentName,
              attempt,
              kind: interrupt.kind,
              functionCallIds: interrupt.functionCallIds,
            } satisfies WorkflowStepWaitingEvent);
            throw new WorkflowInterruptedError([
              { stepId: step.id, interrupt },
            ]);
          }
          if (!result.error) {
            const completed = stepResult(step, result, attempt, startedAt);
            await this.#hooks?.afterAttempt?.(attemptContext, completed);
            throwIfAttemptAborted(
              attemptSignal,
              leaseLossSignal,
              attemptContext,
            );
            await this.checkpointCoordinator().completeStep(completed);
            unsettledAttempt = undefined;
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
          await this.#hooks?.attemptFailed?.(attemptContext, failure);
          await this.checkpointCoordinator().failStep(failure);
          unsettledAttempt = undefined;
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
      } catch (caught) {
        if (!(caught instanceof WorkflowInterruptedError)) {
          operationError = caught;
        }
        throw caught;
      } finally {
        await releaseWorkspaceLease(lease, operationError);
      }
    } catch (caught) {
      // The attempt has ended (agent stopped, aborted or a hook threw). Record a
      // failure instead of leaving the step `running`, which a resume would
      // report as indeterminate.
      if (unsettledAttempt !== undefined) {
        await this.recordStepFailure(step, unsettledAttempt, caught);
      }
      throw caught;
    }
  }

  /**
   * The answer to a waiting step carried by this turn. Without one the step
   * keeps waiting: its pending request events and a `step_waiting` event are
   * emitted again, so a caller that only sees this turn (an outer workflow or
   * gateway re-entering a still-waiting run) still gets the interrupt.
   */
  private async resumeOf(
    step: WorkflowStep,
    interrupt: WorkflowStepInterrupt,
    attempt: number,
  ): Promise<StepResume> {
    const answer = this.#parentContext.userContent;
    const answered = functionResponseIds(answer);
    if (
      !answer ||
      !interrupt.functionCallIds.some((callId) => answered.has(callId))
    ) {
      await this.reemitPendingInterrupt(step, interrupt, attempt);
      throw new WorkflowInterruptedError([{ stepId: step.id, interrupt }]);
    }
    return {
      answer,
      events: storedInterruptEvents(interrupt),
    };
  }

  /**
   * Emits the step's pending requests again as new events of this turn, then
   * its `step_waiting` event, so a caller that only sees this turn still finds
   * the interrupt.
   *
   * Nothing the model would see twice is emitted. The session keeps these
   * events, and a later run of the step with inherited history builds its
   * model context from them, where a repeated function call id is rejected by
   * providers that require unique ids:
   * - an `adk_request_*` call is emitted as its call part alone (no text),
   *   which ADK keeps out of model context and still reports as a request;
   * - any other pending long-running id is emitted as an event with no
   *   content and only `longRunningToolIds`, which ADK drops from model
   *   context and the gateway still counts as pending.
   *
   * Answered and exempt calls (such as an ADK `NodeTool` wrapper call) are not
   * pending, so they are not emitted.
   */
  private async reemitPendingInterrupt(
    step: WorkflowStep,
    interrupt: WorkflowStepInterrupt,
    attempt: number,
  ): Promise<void> {
    const pending = new Set(interrupt.functionCallIds);
    const stored = storedInterruptEvents(interrupt);
    const requestIds = new Set(
      stored.flatMap((event) =>
        requestCallParts(event, pending).map(
          (part) => part.functionCall?.id as string,
        ),
      ),
    );
    const emitted = new Set<string>();
    for (const event of stored) {
      const origin = {
        invocationId: this.#parentContext.invocationId,
        author: event.author,
        ...(event.branch === undefined ? {} : { branch: event.branch }),
      };
      const parts = requestCallParts(event, pending).filter(
        (part) => !emitted.has(part.functionCall?.id as string),
      );
      if (parts.length > 0) {
        const ids = parts.map((part) => part.functionCall?.id as string);
        for (const id of ids) emitted.add(id);
        const longRunning = (event.longRunningToolIds ?? []).filter((id) =>
          ids.includes(id),
        );
        await this.#eventSink(
          createEvent({
            ...origin,
            content: { role: event.content?.role ?? "model", parts },
            ...(longRunning.length > 0
              ? { longRunningToolIds: longRunning }
              : {}),
          }),
        );
      }
      const markers = (event.longRunningToolIds ?? []).filter(
        (id) => pending.has(id) && !requestIds.has(id) && !emitted.has(id),
      );
      if (markers.length > 0) {
        for (const id of markers) emitted.add(id);
        await this.#eventSink(
          createEvent({ ...origin, longRunningToolIds: markers }),
        );
      }
    }
    await this.emitWorkflowEvent({
      ...this.envelope(),
      type: "step_waiting",
      stepId: step.id,
      agentName: step.agentName,
      attempt,
      kind: interrupt.kind,
      functionCallIds: interrupt.functionCallIds,
    } satisfies WorkflowStepWaitingEvent);
  }

  private async recordStepFailure(
    step: WorkflowStep,
    attempt: number,
    caught: unknown,
  ): Promise<void> {
    try {
      await this.checkpointCoordinator().failStep(
        failureFromError(step, caught, attempt),
      );
    } catch {
      // A broken store cannot record the failure; the original error wins.
    }
  }

  private async acquireWorkspaceLease(
    step: WorkflowStep,
    signal: AbortSignal,
  ): Promise<WorkspaceLease | undefined> {
    if (step.writePaths === undefined) return undefined;
    if (!this.#workspace) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        `Workflow step ${step.id} declares writePaths without a workspace adapter`,
        { stepId: step.id },
      );
    }

    const lease = await this.#workspace.adapter.acquire(
      {
        workspaceId: this.#workspace.workspaceId,
        ownerId: `${this.#definition.id}:${this.executionId()}:${step.id}`,
        writePaths: step.writePaths,
      },
      { signal },
    );
    if (signal.aborted) {
      await lease.release();
      throwIfAborted(signal);
    }
    return lease;
  }

  private async runAgentAttempt(
    step: WorkflowStep,
    agent: BaseAgent,
    signal: AbortSignal,
    attemptContext: WorkflowAttemptContext,
    resume?: StepResume,
  ): Promise<AgentInvocationResult> {
    let agentSemaphore = this.#agentSemaphores.get(agent);
    if (!agentSemaphore) {
      agentSemaphore = new AsyncSemaphore(1);
      this.#agentSemaphores.set(agent, agentSemaphore);
    }
    return agentSemaphore.use(signal, () =>
      this.#globalSemaphore.use(signal, () =>
        this.runGatewayAttempt(step, signal, attemptContext, resume),
      ),
    );
  }

  /** One `execute_node` span per step attempt; sub-agent spans nest under it. */
  private async runGatewayAttempt(
    step: WorkflowStep,
    signal: AbortSignal,
    attemptContext: WorkflowAttemptContext,
    resume?: StepResume,
  ): Promise<AgentInvocationResult> {
    try {
      return await withStepSpan(
        {
          name: step.id,
          nodePath: `${this.#agentName}.${step.id}`,
          runId: attemptContext.executionId,
          attempt: attemptContext.attempt - 1,
        },
        async (handle) => {
          const result = await this.#gateway.run({
            agentName: step.agentName,
            input: resume ? resume.answer : stepInputContent(step),
            parentContext: this.#parentContext,
            branch: childBranch(this.#parentContext.branch, step.agentName),
            abortSignal: signal,
            sessionState: {
              [WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY]: attemptContext,
            },
            // Explicit so gateway default changes cannot alter workflow steps.
            // A resumed delegation already carries its own history in
            // `resume.events`; inheriting the parent's would duplicate it.
            sessionStateMode: "merge",
            sessionHistoryMode: resume ? "replace" : "inherit",
            ...(resume ? { resume: { events: resume.events } } : {}),
            eventSink: (event) => this.#eventSink(event),
          });
          if (result.interrupt) {
            handle.waiting(result.interrupt.functionCallIds.length);
          }
          // A failed agent run is a result, not an exception; surface it to the
          // span (error.type only, never the message) and unwrap below.
          if (result.error) throw new AgentAttemptFailure(result);
          return result;
        },
      );
    } catch (caught) {
      if (caught instanceof AgentAttemptFailure) return caught.result;
      throw caught;
    }
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

  /**
   * Default execution id. A turn that answers a waiting step reuses the id of
   * the run that raised it. While the most recent run of this workflow agent
   * in the session still waits (its checkpoint is `running` with a `waiting`
   * step, for the same workflow version), every other turn reuses that id too,
   * so it keeps waiting or is rejected instead of starting a fresh run. Any
   * other turn starts a run keyed by invocation id.
   */
  private async defaultExecutionId(
    context: InvocationContext,
  ): Promise<string> {
    const workflowId = this.#checkpointDefinition.id;
    const answered = answeredExecutionId(context, workflowId, this.#agentName);
    if (answered !== undefined) return answered;
    const latest = latestWaitingExecutionId(
      context,
      workflowId,
      this.#agentName,
    );
    if (
      latest !== undefined &&
      (await WorkflowCheckpointCoordinator.isWaiting(
        this.#checkpointStore,
        context,
        this.#checkpointDefinition,
        latest,
      ))
    ) {
      return latest;
    }
    return context.invocationId;
  }

  /**
   * On the turn that answers a waiting step, the user message is the answer;
   * the workflow keeps running on the input it was started with.
   */
  private async restoreWaitingInput(): Promise<Content | undefined> {
    const answered = functionResponseIds(this.#parentContext.userContent);
    if (answered.size === 0) return undefined;
    return WorkflowCheckpointCoordinator.savedInput(
      this.#checkpointStore,
      this.#parentContext,
      this.#checkpointDefinition.id,
      this.executionId(),
      answered,
    );
  }

  private workflowInput(): Content {
    return (
      this.#inputOverride ??
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
        // ADK graph nodes hand `event.output` to the next node and to
        // `ctx.runNode()`; without it an agent used as a node yields undefined.
        output: nodeOutputOf(output, this.#structuredOutput),
        nodeInfo: { messageAsOutput: true },
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

interface WorkflowAttemptIdentity {
  workflowId: string;
  workflowVersion: string;
  executionId: string;
  stepId: string;
  agentName: string;
  agentRevision: string;
  inputHash: string;
}

async function workflowAttemptIdempotencyKey(
  identity: WorkflowAttemptIdentity,
): Promise<string> {
  const digest = await hashWorkflowValue({
    protocol: "adk-llm-bridge/workflow-attempt-v1",
    ...identity,
  });
  return `workflow-attempt-v1:${digest}`;
}

function createWorkflowAttemptContext({
  definition,
  executionId,
  step,
  attempt,
  inputHash,
  idempotencyKey,
  lease,
}: {
  definition: TrustedWorkflowDefinition;
  executionId: string;
  step: WorkflowStep;
  attempt: number;
  inputHash: string;
  idempotencyKey: string;
  lease: WorkspaceLease | undefined;
}): WorkflowAttemptContext {
  validateWorkspaceCapability(lease);
  const workspace = lease
    ? Object.freeze({
        workspaceId: lease.workspaceId,
        leaseId: lease.leaseId,
        ...(lease.fencingToken === undefined
          ? {}
          : { fencingToken: lease.fencingToken }),
        ...(lease.expiresAt === undefined
          ? {}
          : { expiresAt: lease.expiresAt }),
      })
    : undefined;
  return Object.freeze({
    workflowId: definition.id,
    workflowVersion: definition.version,
    executionId,
    stepId: step.id,
    agentName: step.agentName,
    agentRevision: normalizedAgentRevision(step.agentRevision),
    attempt,
    inputHash,
    idempotencyKey,
    ...(workspace ? { workspace } : {}),
  });
}

function validateWorkspaceCapability(lease: WorkspaceLease | undefined): void {
  if (!lease) return;
  if (
    lease.fencingToken !== undefined &&
    (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 0)
  ) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workspace lease fencingToken must be a non-negative safe integer",
      { leaseId: lease.leaseId, fencingToken: lease.fencingToken },
    );
  }
  if (lease.expiresAt !== undefined && !Number.isFinite(lease.expiresAt)) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workspace lease expiresAt must be finite",
      { leaseId: lease.leaseId, expiresAt: lease.expiresAt },
    );
  }
}

function validateAttemptReplay(
  context: WorkflowAttemptContext,
  replay: WorkflowAttemptReplay,
): WorkflowStepResult {
  const result = isRecord(replay) ? replay.result : undefined;
  if (
    !isRecord(replay) ||
    replay.idempotencyKey !== context.idempotencyKey ||
    (replay.agentRevision ?? WORKFLOW_AGENT_REVISION_UNVERSIONED) !==
      context.agentRevision ||
    !isRecord(result) ||
    result.status !== "completed" ||
    result.id !== context.stepId ||
    result.agentName !== context.agentName ||
    typeof result.output !== "string" ||
    !Number.isSafeInteger(result.attempts) ||
    result.attempts < 1 ||
    !Number.isFinite(result.startedAt) ||
    !Number.isFinite(result.completedAt) ||
    result.events !== undefined ||
    (result.content !== undefined && !isWorkflowContent(result.content)) ||
    (result.stateDelta !== undefined && !isRecord(result.stateDelta)) ||
    !isJsonSafe(replay)
  ) {
    throw new WorkflowError(
      "WORKFLOW_ATTEMPT_MISMATCH",
      `Durable workflow attempt result does not match step ${context.stepId}`,
      {
        stepId: context.stepId,
        agentName: context.agentName,
        expectedAgentRevision: context.agentRevision,
        actualAgentRevision: isRecord(replay)
          ? String(replay.agentRevision ?? WORKFLOW_AGENT_REVISION_UNVERSIONED)
          : "",
        expectedIdempotencyKey: context.idempotencyKey,
        actualIdempotencyKey: isRecord(replay)
          ? String(replay.idempotencyKey ?? "")
          : "",
      },
    );
  }
  return {
    ...(result as unknown as WorkflowStepResult),
    attempts: context.attempt,
    replayed: true,
  };
}

async function releaseWorkspaceLease(
  lease: WorkspaceLease | undefined,
  operationError: unknown,
): Promise<void> {
  if (!lease) return;
  try {
    await lease.release();
  } catch (releaseError) {
    if (operationError === undefined) throw releaseError;
  }
}

function throwIfAttemptAborted(
  signal: AbortSignal,
  leaseLossSignal: AbortSignal | undefined,
  context: WorkflowAttemptContext,
): void {
  if (leaseLossSignal?.aborted) {
    const reason = leaseLossSignal.reason;
    const reasonMessage =
      isRecord(reason) && typeof reason.message === "string"
        ? reason.message
        : "Workflow workspace lease was lost";
    throw new WorkflowError("WORKFLOW_WORKSPACE_LEASE_LOST", reasonMessage, {
      stepId: context.stepId,
      agentName: context.agentName,
      idempotencyKey: context.idempotencyKey,
      ...(context.workspace ?? {}),
      leaseLossReason: isJsonSafe(reason) ? reason : { message: reasonMessage },
    });
  }
  throwIfAborted(signal);
}

/** Content with an optional string `role` and object `parts`, as ADK reads it. */
function isWorkflowContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    (value.role === undefined || typeof value.role === "string") &&
    Array.isArray(value.parts) &&
    value.parts.every(isRecord) &&
    isJsonSafe(value)
  );
}

function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;

  seen.add(value);
  const safe = Array.isArray(value)
    ? value.every((item) => isJsonSafe(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.values(value).every((item) => isJsonSafe(item, seen));
  seen.delete(value);
  return safe;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (
    step.agentRevision !== undefined &&
    (typeof step.agentRevision !== "string" ||
      !step.agentRevision ||
      step.agentRevision !== step.agentRevision.trim() ||
      step.agentRevision.includes("\0") ||
      step.agentRevision.length > MAX_WORKFLOW_AGENT_REVISION_LENGTH)
  ) {
    throw new WorkflowError(
      "WORKFLOW_STEP_MISMATCH",
      `Workflow step ${step.id} agentRevision must be a non-empty trimmed string of at most ${MAX_WORKFLOW_AGENT_REVISION_LENGTH} characters`,
      { stepId: step.id },
    );
  }
  if (
    step.writePaths !== undefined &&
    (!Array.isArray(step.writePaths) || step.writePaths.length === 0)
  ) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      `Workflow step ${step.id} writePaths must contain at least one path`,
      { stepId: step.id },
    );
  }
}

function normalizedAgentRevision(revision: string | undefined): string {
  return revision ?? WORKFLOW_AGENT_REVISION_UNVERSIONED;
}

/** Largest delay `setTimeout` honors; longer delays fire after about 1 ms. */
const MAX_RETRY_DELAY_MS = 2_147_483_647;
const RETRY_POLICY_KEYS: Readonly<Record<keyof WorkflowRetryPolicy, true>> = {
  maxAttempts: true,
  delayMs: true,
  backoffMultiplier: true,
  maxDelayMs: true,
};

function validateRetry(step: WorkflowStep, limit: number): number {
  const retry: unknown = step.retry;
  if (
    retry !== undefined &&
    (retry === null || typeof retry !== "object" || Array.isArray(retry))
  ) {
    throw invalidRetry(step, "retry must be an object");
  }
  const policy = (retry ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(policy)) {
    if (!Object.hasOwn(RETRY_POLICY_KEYS, name)) {
      throw invalidRetry(step, `retry has an unknown field ${name}`);
    }
  }
  const attempts = policy.maxAttempts ?? 1;
  if (
    typeof attempts !== "number" ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > limit
  ) {
    throw new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `Step ${step.id} maxAttempts must be between 1 and ${limit}`,
      {
        stepId: step.id,
        ...(typeof attempts === "number" && Number.isFinite(attempts)
          ? { maxAttempts: attempts }
          : {}),
        limit,
      },
    );
  }
  for (const name of ["delayMs", "backoffMultiplier", "maxDelayMs"] as const) {
    const value = policy[name];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidRetry(step, `retry ${name} must be a finite number`);
    }
    if (value < 0) {
      throw invalidRetry(step, `retry ${name} cannot be negative`);
    }
    if (name !== "backoffMultiplier" && value > MAX_RETRY_DELAY_MS) {
      throw invalidRetry(
        step,
        `retry ${name} cannot exceed ${MAX_RETRY_DELAY_MS} ms`,
      );
    }
  }
  return attempts;
}

function invalidRetry(step: WorkflowStep, message: string): WorkflowError {
  return new WorkflowError(
    "WORKFLOW_DEFINITION_INVALID",
    `Step ${step.id} ${message}`,
    { stepId: step.id },
  );
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
    ...stepStateDelta(invocation.stateDelta),
    attempts,
    startedAt,
    completedAt: Date.now(),
  };
}

/**
 * State written by the step's agent, minus the checkpoints of nested workflow
 * agents. Those are persisted by the nested workflow's own events; embedding
 * them in this checkpoint would nest whole checkpoints inside each other
 * (rejected by validation and quadratic in size), and replaying an old copy
 * would overwrite the newer one.
 */
function stepStateDelta(
  stateDelta: Record<string, unknown> | undefined,
): { stateDelta: Record<string, unknown> } | Record<string, never> {
  if (!stateDelta) return {};
  const entries = Object.entries(stateDelta).filter(
    ([key]) => !key.startsWith(`${WORKFLOW_CHECKPOINT_STATE_PREFIX}:`),
  );
  return entries.length > 0 ? { stateDelta: Object.fromEntries(entries) } : {};
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
  const delay = Math.min(
    calculated,
    step.retry?.maxDelayMs ?? calculated,
    MAX_RETRY_DELAY_MS,
  );
  if (delay > 0) await abortableDelay(delay, signal);
}

function createExecutionAbortScope(
  sourceSignals: readonly (AbortSignal | undefined)[],
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of sourceSignals) {
    if (!signal) continue;
    const abort = () =>
      controller.abort(
        signal.reason ??
          new WorkflowError("WORKFLOW_ABORTED", "Workflow execution aborted"),
      );
    if (signal.aborted) {
      abort();
      break;
    }
    listeners.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }

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
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

/**
 * Node output of a workflow result, following ADK's `maybeSetOutput`
 * (`run_llm_agent_as_node`): visible (non-thought) text joined with `""`; with
 * `structured`, non-blank text is parsed as JSON and kept as text if that
 * fails. A `Content` without text is passed through unchanged.
 */
function nodeOutputOf(
  output: Exclude<WorkflowOutput, undefined>,
  structured: boolean,
): unknown {
  let text: string;
  if (typeof output === "string") {
    text = output;
  } else {
    text = (output.parts ?? [])
      .filter((part) => typeof part.text === "string" && part.thought !== true)
      .map((part) => part.text)
      .join("");
    if (text === "") return output;
  }
  if (structured && text.trim() !== "") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
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
    case "step_waiting":
      return `Workflow ${event.workflowId}: ${event.stepId} waiting for input`;
    case "workflow_waiting":
      return `Workflow ${event.workflowId}: waiting for input`;
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

/** Carries a failed gateway result through the step span as an error. */
class AgentAttemptFailure extends Error {
  constructor(readonly result: AgentInvocationResult) {
    super("Workflow agent attempt failed");
    this.name = "AgentAttemptFailure";
  }
}

interface StepResume {
  /** The user message answering the pending function calls. */
  answer: Content;
  /** Events of the interrupted delegation, as stored in the checkpoint. */
  events: readonly Event[];
}

function functionResponseIds(content: Content | undefined): Set<string> {
  const ids = new Set<string>();
  for (const part of content?.parts ?? []) {
    const id = part.functionResponse?.id;
    if (typeof id === "string" && id !== "") ids.add(id);
  }
  return ids;
}

/** ADK's human-in-the-loop request calls, which ADK keeps out of model context. */
const REQUEST_CALL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
]);

/** The pending `adk_request_*` function-call parts of a stored event. */
function requestCallParts(event: Event, pending: ReadonlySet<string>): Part[] {
  return (event.content?.parts ?? []).filter((part) => {
    const call = part.functionCall;
    return (
      typeof call?.id === "string" &&
      pending.has(call.id) &&
      typeof call.name === "string" &&
      REQUEST_CALL_NAMES.has(call.name)
    );
  });
}

/**
 * The stored events of an interrupt as ADK events. The checkpoint schema
 * checks, at load, the event fields that resuming reads (`author`, `branch`,
 * `longRunningToolIds`, `content.parts` and their `functionCall`).
 */
function storedInterruptEvents(
  interrupt: WorkflowStepInterrupt,
): readonly Event[] {
  return interrupt.events as unknown as readonly Event[];
}

/** JSON form of a gateway interrupt, as persisted in the checkpoint. */
function toStepInterrupt(
  interrupt: NonNullable<AgentInvocationResult["interrupt"]>,
): WorkflowStepInterrupt {
  return JSON.parse(
    JSON.stringify({
      kind: interrupt.kind,
      functionCallIds: interrupt.functionCallIds,
      requests: interrupt.requests,
      events: interrupt.events,
    }),
  ) as WorkflowStepInterrupt;
}

/**
 * Execution id of the waiting run, emitted by this workflow agent, whose
 * `step_waiting` call ids this turn answers with `functionResponse` parts.
 */
function answeredExecutionId(
  context: InvocationContext,
  workflowId: string,
  agentName: string,
): string | undefined {
  const answered = functionResponseIds(context.userContent);
  if (answered.size === 0) return undefined;
  const events = context.session?.events ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const waiting = event?.customMetadata?.workflowEvent;
    if (
      event?.author === agentName &&
      isWorkflowEvent(waiting) &&
      waiting.type === "step_waiting" &&
      waiting.workflowId === workflowId &&
      waiting.functionCallIds.some((callId) => answered.has(callId))
    ) {
      return waiting.executionId;
    }
  }
  return undefined;
}

/**
 * Execution id of the most recent `step_waiting` event this workflow agent
 * emitted in the session, if any. Whether that run still waits is decided by
 * its checkpoint, not by the events.
 */
function latestWaitingExecutionId(
  context: InvocationContext,
  workflowId: string,
  agentName: string,
): string | undefined {
  const events = context.session?.events ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const waiting = event?.customMetadata?.workflowEvent;
    if (
      event?.author === agentName &&
      isWorkflowEvent(waiting) &&
      waiting.type === "step_waiting" &&
      waiting.workflowId === workflowId
    ) {
      return waiting.executionId;
    }
  }
  return undefined;
}
