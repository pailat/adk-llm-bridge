import {
  type BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  type Session,
} from "@google/adk";
import type { Content, Part } from "@google/genai";
import type {
  AgentInvocationGateway,
  AgentInvocationResult,
} from "../../runtime/agent-invocation-gateway.js";
import {
  describeAgentModel,
  rootSessionOf,
} from "../../runtime/agent-invocation-gateway.js";
import { describeAgentKind } from "../../runtime/agent-kind.js";
import { parseJson } from "../../utils/json.js";
import { LogCode, warn } from "../../utils/log.js";
import { isTempStateKey, withoutTempStateKeys } from "../../utils/state.js";
import type { WorkflowStepResolution } from "../checkpoint/checkpoint.js";
import { hashWorkflowValue } from "../checkpoint/hash.js";
import type { WorkflowCheckpointStepAcceptanceV1 } from "../checkpoint/replay-acceptance.js";
import type {
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
import {
  AdkSessionCheckpointStore,
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
  WorkflowCheckpointSizeWarningEvent,
  WorkflowCompletedEvent,
  WorkflowCustomEvent,
  WorkflowErrorEvent,
  WorkflowEvent,
  WorkflowOutputEvent,
  WorkflowStartedEvent,
  WorkflowStepChangeAcceptedEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowStepInterruptedEvent,
  WorkflowStepModelChangedEvent,
  WorkflowStepReplayedEvent,
  WorkflowStepStartedEvent,
  WorkflowStepWaitingEvent,
  WorkflowUserEvent,
  WorkflowWaitingEvent,
} from "../events.js";
import { isWorkflowEvent } from "../events.js";
import { canonicalJson } from "../internal/canonical-hash.js";
import { isRecord } from "../internal/guards.js";
import { monotonicNow } from "../internal/monotonic-clock.js";
import { resolveStepLimits, StepBudget } from "../internal/step-limit.js";
import { isWorkflowAgent } from "../internal/workflow-agent-brand.js";
import type { ResolvedWorkflowReplayOptions } from "../node-config.js";
import {
  recordWorkflowSpanEvent,
  withStepSpan,
  withWorkflowSpan,
} from "../telemetry.js";
import type {
  WorkflowWorkspaceConfig,
  WorkspaceLease,
} from "../workspace/workspace-adapter.js";
import { AsyncSemaphore } from "./async-semaphore.js";
import {
  WorkflowCheckpointCoordinator,
  type WorkflowCheckpointSizeWarning,
} from "./workflow-checkpoint-coordinator.js";

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
   * is entered again (an ADK node retry with the same invocation id). Without
   * it, and on every turn that answers a waiting step, a recorded failure is
   * replayed. A step stopped by an abort or timeout (closed run, node
   * `timeout`, run timeout) is recorded `interrupted`, not failed: with this
   * option, or with `resumePolicy: "retry"` on the step, it runs again;
   * otherwise the resume fails with `WORKFLOW_INDETERMINATE_STEP`. Steps left
   * `running` stay indeterminate unless they declare `resumePolicy: "retry"`.
   */
  retryFailedSteps?: boolean;
  /** Model and input-change handling on replayed steps; see `WorkflowReplayOptions`. */
  replay?: ResolvedWorkflowReplayOptions;
}

/**
 * Warning code logged when parallel steps share a sub-agent, so they run one
 * at a time.
 */
const PARALLEL_STEPS_SHARE_AGENT = "WORKFLOW_PARALLEL_STEPS_SHARE_AGENT";

/** Step ids named in that warning before it shortens the list. */
const MAX_LISTED_SHARED_STEPS = 5;

/** Step ids named in the unrecorded-model warning before it shortens the list. */
const MAX_LISTED_UNRECORDED_STEPS = 10;
/** Characters of an input digest shown in logs and spans: `sha256:` and 12 hex. */
const INPUT_DIGEST_SHOWN = 19;

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
  /**
   * Last value of each checkpoint key carried by an event this runtime
   * emitted, its own and those forwarded from delegated workflows.
   */
  readonly #emittedCheckpoints = new Map<string, unknown>();
  readonly #hooks?: WorkflowRuntimeHooks;
  readonly #checkpointStore: WorkflowCheckpointStore;
  readonly #resolveExecutionId: WorkflowExecutionIdResolver;
  readonly #workspace?: WorkflowWorkspaceConfig;
  readonly #abortSignal?: AbortSignal;
  readonly #structuredOutput: boolean;
  readonly #retryFailedSteps: boolean;
  readonly #replay?: ResolvedWorkflowReplayOptions;
  /** Replayed or resumed steps whose saved record has no model, this turn. */
  readonly #unrecordedModelSteps: string[] = [];
  readonly #limits: Required<WorkflowExecutionLimits>;
  readonly #globalSemaphore: AsyncSemaphore;
  readonly #agentSemaphores = new WeakMap<BaseAgent, AsyncSemaphore>();
  /** Sub-agents already reported as shared by parallel steps in this run. */
  readonly #warnedSharedAgents = new Set<BaseAgent>();
  readonly #seenStepIds = new Set<string>();
  #executionSignal?: AbortSignal;
  #executionId?: string;
  /** Original input restored from a waiting checkpoint (answer turn). */
  #inputOverride?: Content;
  #checkpointCoordinator?: WorkflowCheckpointCoordinator;
  #stepCount = 0;
  #replayedStepCount = 0;
  readonly #stepBudget: StepBudget;

  constructor(config: WorkflowRuntimeConfig) {
    this.#definition = config.definition;
    this.#checkpointDefinition =
      config.checkpointDefinition ?? config.definition;
    this.#parentContext = config.parentContext;
    this.#agentName = config.agentName;
    this.#declaredAgents = config.declaredAgents;
    this.#gateway = config.gateway;
    this.#eventSink = (event) => {
      this.recordCheckpointDelta(event);
      return config.eventSink(event);
    };
    this.#hooks = config.hooks;
    this.#checkpointStore =
      config.checkpointStore ?? new AdkSessionCheckpointStore();
    this.#resolveExecutionId =
      config.resolveExecutionId ??
      ((context) => this.defaultExecutionId(context));
    this.#workspace = config.workspace;
    this.#abortSignal = config.abortSignal;
    this.#structuredOutput = config.structuredOutput === true;
    this.#retryFailedSteps = config.retryFailedSteps === true;
    this.#replay = config.replay;
    this.#limits = validateLimits(config.definition.limits);
    this.#stepBudget = new StepBudget(this.#limits);
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
    const delegatedRun = this.registerDelegatedRun();

    try {
      throwIfRunAborted(abortScope.signal);
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
        replay: this.#replay,
        answerTurn: this.#inputOverride !== undefined,
        onWrite: (write, stepId) => this.emitCheckpointSaved(write, stepId),
        onSizeWarning: (warning) => this.emitCheckpointSizeWarning(warning),
      });
      await this.#checkpointCoordinator.initialize();
      checkpointInitialized = true;
      await this.emitWorkflowEvent({
        ...this.envelope(startedAt),
        type: "workflow_started",
      } satisfies WorkflowStartedEvent);

      const output = await this.#definition.handler(this.createContext());
      throwIfRunAborted(abortScope.signal);
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
      this.logUnrecordedModels();
      this.#checkpointCoordinator?.reportUnusedAcceptances();
      abortScope.dispose();
      await this.persistCheckpointsAfterAbort();
      delegatedRun?.();
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
    if (concurrency > 1) this.warnSharedParallelAgents(steps);
    const localSemaphore = new AsyncSemaphore(concurrency);
    const parallelAbort = new AbortController();
    const scopeSignal = AbortSignal.any([
      this.executionSignal(),
      parallelAbort.signal,
    ]);

    const interrupts: WorkflowInterruptedError["interrupts"][number][] = [];
    // The failure that stopped the fan-out. A queued step rejects with the
    // stop reason before the failing step settles, and a stopped sibling
    // throws it too, so `Promise.all` may settle with the stop reason instead.
    let stoppedBy: { error: unknown } | undefined;
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
          if (failureMode === "fail-fast" || isReplayIntegrityError(caught)) {
            // Only the first failure stops the fan-out; a stopped sibling
            // rethrows the stop reason and must not replace it.
            if (stoppedBy === undefined) {
              stoppedBy = { error: caught };
              parallelAbort.abort(siblingStopReason(step, caught));
            }
            throw caught;
          }
          // A recorded failure keeps its stored record, marked `replayed`.
          return (
            (caught instanceof WorkflowError
              ? replayedFailures.get(caught)
              : undefined) ?? failureFromError(step, caught)
          );
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
      throw stoppedBy ? stoppedBy.error : caught;
    }
  }

  /**
   * Warns once per run and sub-agent when parallel steps resolve to the same
   * declared sub-agent: its per-agent lock runs them one at a time, so the
   * fan-out is not parallel. Steps that fail validation are left to
   * {@link runStep}; names and ids are quoted in the message.
   */
  private warnSharedParallelAgents(steps: readonly WorkflowStep[]): void {
    const stepIdsByAgent = new Map<BaseAgent, string[]>();
    for (const step of steps) {
      if (typeof step?.id !== "string" || typeof step.agentName !== "string") {
        continue;
      }
      const agent = this.#declaredAgents.get(step.agentName);
      if (!agent) continue;
      const ids = stepIdsByAgent.get(agent) ?? [];
      ids.push(step.id);
      stepIdsByAgent.set(agent, ids);
    }
    for (const [agent, ids] of stepIdsByAgent) {
      if (ids.length < 2 || this.#warnedSharedAgents.has(agent)) continue;
      this.#warnedSharedAgents.add(agent);
      const listed = ids
        .slice(0, MAX_LISTED_SHARED_STEPS)
        .map((id) => JSON.stringify(id))
        .join(", ");
      const more = ids.length > MAX_LISTED_SHARED_STEPS ? ", ..." : "";
      warn(
        PARALLEL_STEPS_SHARE_AGENT,
        `Workflow ${JSON.stringify(this.#agentName)}: ${ids.length} parallel steps (${listed}${more}) use the same sub-agent ${JSON.stringify(agent.name)}, which runs one step at a time. Declare one sub-agent per concurrent branch to run them in parallel.`,
      );
    }
  }

  private async runStep(
    requestedStep: WorkflowStep,
    signal: AbortSignal,
  ): Promise<WorkflowStepResult> {
    throwIfRunAborted(signal);
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
    // The step limits are checked once the checkpoint tells whether the step
    // replays or executes, before it is saved `running`.
    const prepared = await this.checkpointCoordinator()
      .prepareStep(
        step,
        (resolution) => {
          if (
            resolution.action === "replay" ||
            resolution.action === "replay-failure"
          ) {
            this.#stepBudget.takeReplayed(step.id);
          } else {
            this.#stepBudget.takeExecuted(step.id);
          }
        },
        { requested: describeAgentModel(declaredAgent).requested },
      )
      .catch(async (caught: unknown) => {
        if (isReplayIntegrityError(caught)) {
          await this.emitWorkflowEvent({
            ...this.envelope(),
            type: "step_failed",
            failure: failureFromError(step, caught, 0),
          } satisfies WorkflowStepFailedEvent);
        }
        throw caught;
      });
    // A step about to execute is already saved `running`, so its abort check
    // runs inside the try below, where the abort is recorded as `interrupted`.
    if (prepared.resolution.action !== "execute") throwIfRunAborted(signal);
    if (prepared.accepted) {
      await this.reportAcceptedChanges(step.id, prepared.accepted);
    }
    if (prepared.resolution.action !== "execute") {
      await this.reportModelNotes(step.id, prepared.resolution);
    }
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
    if (prepared.resolution.action === "replay-failure") {
      // The step failed on an earlier turn of this execution. Report the same
      // failure so the workflow takes the same path it took then.
      const { failure } = prepared.resolution;
      this.#replayedStepCount++;
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "step_failed",
        failure,
      } satisfies WorkflowStepFailedEvent);
      const error = new WorkflowError(
        failure.error.code,
        failure.error.message,
        failure.error.details,
      );
      replayedFailures.set(error, failure);
      throw error;
    }

    // A waiting step continues with the answer carried by this turn; without
    // one it keeps waiting and re-emits its pending request.
    const resume =
      prepared.resolution.action === "resume"
        ? await this.resumeOf(
            step,
            prepared.resolution.interrupt,
            prepared.resolution.attempt,
            prepared.inputHash,
          )
        : undefined;

    // Attempt number of a step left `running` in the checkpoint; cleared once the
    // step completes or its failure is recorded. A resumed step stays `waiting`
    // (still answerable) if its continuation is aborted.
    let unsettledAttempt: number | undefined = resume
      ? undefined
      : prepared.resolution.attempt;
    try {
      throwIfRunAborted(signal);
      const hookResult = resume
        ? undefined
        : await this.#hooks?.beforeStep?.(hookContext);
      throwIfRunAborted(signal);
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
              "retry",
            );
            // Only now is the retry saved `running`. An abort during the delay
            // leaves the previous attempt's recorded failure in place.
            unsettledAttempt = attempt;
          }
          // An in-run retry is always `retry`. Otherwise the reason comes from
          // the checkpoint resolution and is unset on a first attempt.
          const resumeReason =
            attemptIndex > 0
              ? "retry"
              : prepared.resolution.action === "execute"
                ? prepared.resolution.resumeReason
                : undefined;
          const requestedModel = describeAgentModel(declaredAgent).requested;
          const agentKind = describeAgentKind(declaredAgent);
          await this.emitWorkflowEvent({
            ...this.envelope(),
            type: "step_started",
            step,
            attempt,
            ...(resumeReason === undefined ? {} : { resumeReason }),
            ...(requestedModel === undefined ? {} : { requestedModel }),
            agentKind,
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
              agentKind,
            } satisfies WorkflowStepCompletedEvent);
            return completed;
          }

          lastError = new WorkflowError(
            "WORKFLOW_EXECUTION_ERROR",
            `Workflow step ${step.id} failed: ${result.error}`,
            {
              agentName: step.agentName,
              stepId: step.id,
              attempt,
              ...agentFailureCause(result),
            },
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
      if (isReplayIntegrityError(caught)) {
        await this.emitWorkflowEvent({
          ...this.envelope(),
          type: "step_failed",
          failure: failureFromError(step, caught, unsettledAttempt ?? 0),
        } satisfies WorkflowStepFailedEvent);
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
    inputHash: string,
  ): Promise<StepResume> {
    const answer = this.#parentContext.userContent;
    const answered = functionResponseIds(answer);
    if (
      !answer ||
      !interrupt.functionCallIds.some((callId) => answered.has(callId))
    ) {
      // The run may have failed past this wait earlier; the answer turn needs
      // the checkpoint to show it as running with its input again.
      await this.checkpointCoordinator().restoreWaitingStep(
        step,
        inputHash,
        attempt,
        interrupt,
      );
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
    let failure: WorkflowStepFailure;
    try {
      failure = failureFromError(step, caught, attempt);
      await this.checkpointCoordinator().failStep(failure);
    } catch {
      // A broken store cannot record the failure; the original error wins.
      return;
    }
    if (failure.error.code === "WORKFLOW_ABORTED") {
      try {
        await this.emitWorkflowEvent({
          ...this.envelope(),
          type: "step_interrupted",
          stepId: step.id,
          attempt,
        } satisfies WorkflowStepInterruptedEvent);
      } catch {
        // A throwing event sink must not replace the original error.
      }
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
      throwIfRunAborted(signal);
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
        this.runGatewayAttempt(step, agent, signal, attemptContext, resume),
      ),
    );
  }

  /** One `execute_node` span per step attempt; sub-agent spans nest under it. */
  private async runGatewayAttempt(
    step: WorkflowStep,
    agent: BaseAgent,
    signal: AbortSignal,
    attemptContext: WorkflowAttemptContext,
    resume?: StepResume,
  ): Promise<AgentInvocationResult> {
    try {
      return await withStepSpan(
        {
          name: step.id,
          nodePath: `${this.#agentName}.${step.id}`,
          agentKind: describeAgentKind(agent),
          runId: attemptContext.executionId,
          attempt: attemptContext.attempt - 1,
        },
        async (handle) => {
          const delegated = await this.#gateway.run({
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
          const result = withoutSettledNestedErrors(
            delegated,
            this.#declaredAgents.get(step.agentName),
          );
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

  /**
   * Reports what the model check found on a step whose saved outcome is
   * reused: a `step_model_changed` event with a warn log, or a count of steps
   * the check could not cover (logged once per turn).
   */
  private async reportModelNotes(
    stepId: string,
    resolution: Exclude<WorkflowStepResolution, { action: "execute" }>,
  ): Promise<void> {
    if (resolution.modelUnrecorded === true) {
      this.#unrecordedModelSteps.push(stepId);
      return;
    }
    const change = resolution.modelChanged;
    if (!change) return;
    const action = (
      {
        replay: "replayed",
        "replay-failure": "replayed-failure",
        resume: "resumed",
      } as const
    )[resolution.action];
    warn(
      LogCode.WORKFLOW_STEP_MODEL_CHANGED,
      `step "${stepId}" ${action} from the checkpoint with model ${
        change.savedRequestedModel ?? "(none)"
      }, but its agent now requests ${change.requestedModel ?? "(none)"}`,
    );
    recordWorkflowSpanEvent("step_model_changed", {
      "adk.workflow.step.id": stepId,
      "adk.workflow.step.action": action,
      ...(change.savedRequestedModel === undefined
        ? {}
        : { "adk.workflow.step.saved_model": change.savedRequestedModel }),
      ...(change.requestedModel === undefined
        ? {}
        : { "adk.workflow.step.requested_model": change.requestedModel }),
    });
    await this.emitWorkflowEvent({
      ...this.envelope(),
      type: "step_model_changed",
      stepId,
      savedRecorded: true,
      ...(change.savedRequestedModel === undefined
        ? {}
        : { savedRequestedModel: change.savedRequestedModel }),
      ...(change.savedResolvedModels === undefined
        ? {}
        : { savedResolvedModels: change.savedResolvedModels }),
      ...(change.requestedModel === undefined
        ? {}
        : { requestedModel: change.requestedModel }),
      action,
    } satisfies WorkflowStepModelChangedEvent);
  }

  /**
   * Reports host acceptances applied to a step and already saved: a warn log
   * (it weakens a durability check, so it is always visible), a span event and
   * a `step_change_accepted` event per entry. The reason text goes only into
   * the event; the log and the span carry its length.
   */
  private async reportAcceptedChanges(
    stepId: string,
    accepted: readonly WorkflowCheckpointStepAcceptanceV1[],
  ): Promise<void> {
    for (const acceptance of accepted) {
      const from = telemetryValue(acceptance.kind, acceptance.from);
      const to = telemetryValue(acceptance.kind, acceptance.to);
      warn(
        LogCode.WORKFLOW_REPLAY_CHANGE_ACCEPTED,
        `step ${JSON.stringify(stepId)} replays its saved result after a host-accepted ${acceptance.kind} change from ${from} to ${to}${
          acceptance.approvedBy === undefined
            ? ""
            : ` (approved by ${JSON.stringify(acceptance.approvedBy)})`
        }`,
      );
      recordWorkflowSpanEvent("step_change_accepted", {
        "adk.workflow.step.id": stepId,
        "adk.workflow.acceptance.kind": acceptance.kind,
        "adk.workflow.acceptance.from": from,
        "adk.workflow.acceptance.to": to,
        ...(acceptance.approvedBy === undefined
          ? {}
          : { "adk.workflow.acceptance.approved_by": acceptance.approvedBy }),
        "adk.workflow.acceptance.reason_length": acceptance.reason.length,
      });
      await this.emitWorkflowEvent({
        ...this.envelope(),
        type: "step_change_accepted",
        stepId,
        acceptance,
      } satisfies WorkflowStepChangeAcceptedEvent);
    }
  }

  /** Logs once the steps this turn replayed without a saved model to compare. */
  private logUnrecordedModels(): void {
    const steps = this.#unrecordedModelSteps;
    if (steps.length === 0) return;
    const listed = steps.slice(0, MAX_LISTED_UNRECORDED_STEPS).join(", ");
    const more =
      steps.length > MAX_LISTED_UNRECORDED_STEPS
        ? `, and ${steps.length - MAX_LISTED_UNRECORDED_STEPS} more`
        : "";
    warn(
      LogCode.WORKFLOW_STEP_MODEL_UNRECORDED,
      `${steps.length} replayed or resumed step(s) have no saved model, so a model change could not be checked: ${listed}${more}`,
    );
    steps.length = 0;
  }

  private async emitCheckpointSizeWarning(
    warning: WorkflowCheckpointSizeWarning,
  ): Promise<void> {
    await this.emitWorkflowEvent({
      ...this.envelope(),
      type: "checkpoint_size_warning",
      ...warning,
    } satisfies WorkflowCheckpointSizeWarningEvent);
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

  private recordCheckpointDelta(event: Event): void {
    // Checkpoint deltas ride only on `checkpoint_saved` events, which are never
    // partial, so no partial filter is needed here.
    for (const [key, value] of Object.entries(
      event.actions?.stateDelta ?? {},
    )) {
      if (key.startsWith(`${WORKFLOW_CHECKPOINT_STATE_PREFIX}:`)) {
        this.#emittedCheckpoints.set(key, value);
      }
    }
  }

  /**
   * Registers a run whose session is a gateway child session with the root
   * session, so the root can collect its checkpoints after an abort. The entry
   * holds this run's live checkpoint map, so the root can read it even while
   * the run is still going.
   *
   * @returns A function that marks the run settled, or `undefined` for a run
   * in a root session.
   */
  private registerDelegatedRun(): (() => void) | undefined {
    const session = this.#parentContext.session;
    if (!session) return undefined;
    const root = rootSessionOf(session);
    if (root === session) return undefined;
    let runs = delegatedRuns.get(root);
    if (!runs) {
      runs = new Set();
      delegatedRuns.set(root, runs);
    }
    const registry = runs;
    let markSettled: () => void = () => {};
    const run: DelegatedRun = {
      checkpoints: this.#emittedCheckpoints,
      settled: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
      done: false,
      collected: false,
    };
    registry.add(run);
    return () => {
      run.done = true;
      markSettled();
      // An aborted run stays registered until its root collects it; any other
      // run, or one the root already collected, is dropped now.
      if (run.collected || !this.#parentContext.abortSignal?.aborted) {
        registry.delete(run);
      }
    };
  }

  /**
   * Appends the checkpoints that an aborted run emitted but that never reached
   * session state.
   *
   * @remarks
   * An ADK `Runner` stops appending events once its signal aborts, so the
   * events that record the abort (step `interrupted`, run `cancelled`) are
   * dropped and, with the default session store, the session would keep the
   * step `running`. The Runner waits for the workflow's generator to close
   * before it seals the invocation, so this append lands before the Runner's
   * own abort events and never runs concurrently with them.
   *
   * Only the workflow that runs in the root session appends. A delegated
   * workflow runs in a gateway child session, which the context's
   * `sessionService` does not own, and the gateway stops forwarding its events
   * on abort. The root waits up to {@link DELEGATED_ABORT_GRACE_MS} for those
   * runs to settle, then appends their checkpoints with its own, in one event.
   * A delegated run still going after the grace period (a handler that ignores
   * the signal) contributes the checkpoint it had at that moment, usually its
   * step or the run still `running`; what it records later does not reach the
   * session, so a resume reports that step as indeterminate. A failed append
   * is logged and never replaces the run's own outcome.
   */
  private async persistCheckpointsAfterAbort(): Promise<void> {
    const { abortSignal, session, sessionService } = this.#parentContext;
    if (
      !abortSignal?.aborted ||
      !session ||
      !sessionService ||
      rootSessionOf(session) !== session
    ) {
      return;
    }
    const latest = new Map(this.#emittedCheckpoints);
    const runs = delegatedRuns.get(session);
    if (runs) {
      await settledWithin(runs, DELEGATED_ABORT_GRACE_MS);
      for (const run of runs) {
        // A delegated run's values are newer than the copies it forwarded.
        for (const [key, value] of run.checkpoints) latest.set(key, value);
        run.collected = true;
        if (run.done) runs.delete(run);
      }
    }
    const missing: Record<string, unknown> = {};
    for (const [key, value] of latest) {
      if (!sameCheckpointValue(session.state?.[key], value)) {
        missing[key] = value;
      }
    }
    if (Object.keys(missing).length === 0) return;
    try {
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: this.#parentContext.invocationId,
          author: this.#agentName,
          branch: this.#parentContext.branch,
          actions: createEventActions({ stateDelta: missing }),
        }),
      });
    } catch (error) {
      warn(
        WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED,
        `Workflow ${this.#definition.id} was aborted but its final checkpoint could not be appended to the session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
  // A journal is an external store: its `stateDelta` gets the same filter as
  // a live step's before it reaches the checkpoint.
  const { stateDelta, ...rest } = result as unknown as WorkflowStepResult;
  return {
    ...rest,
    ...stepStateDelta(stateDelta),
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
  throwIfRunAborted(signal);
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

function validateLimits(
  limits: WorkflowExecutionLimits | undefined,
): Required<WorkflowExecutionLimits> {
  const merged = {
    ...DEFAULT_WORKFLOW_EXECUTION_LIMITS,
    ...limits,
    ...resolveStepLimits(limits),
  };
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
    "maxReplayedSteps",
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
    usage: { ...invocation.usage },
    ...(invocation.models
      ? {
          models: {
            requested: [...invocation.models.requested],
            resolved: [...invocation.models.resolved],
            unknown: invocation.models.unknown,
          },
        }
      : {}),
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
    ([key]) =>
      !key.startsWith(`${WORKFLOW_CHECKPOINT_STATE_PREFIX}:`) &&
      !isTempStateKey(key),
  );
  return entries.length > 0 ? { stateDelta: Object.fromEntries(entries) } : {};
}

/**
 * Error code and kind of a failed delegation: `causeCode` is the `errorCode`
 * of the last event that reported an error, `errorKind` the gateway's
 * classification. Absent fields are omitted.
 */
function agentFailureCause(result: AgentInvocationResult): {
  causeCode?: string;
  errorKind?: string;
} {
  const failedEvent = result.events.findLast(
    (event) =>
      event.errorMessage !== undefined || event.errorCode !== undefined,
  );
  return {
    ...(failedEvent?.errorCode ? { causeCode: failedEvent.errorCode } : {}),
    ...(result.errorKind ? { errorKind: result.errorKind } : {}),
  };
}

/**
 * Whether `caught` says the saved checkpoint no longer matches the workflow.
 * Such an error fails the run in every parallel failure mode: it is not a
 * step outcome the workflow can carry on from.
 */
function isReplayIntegrityError(caught: unknown): boolean {
  return (
    caught instanceof WorkflowError &&
    (caught.code === "WORKFLOW_STEP_MISMATCH" ||
      caught.code === "WORKFLOW_INPUT_MISMATCH" ||
      caught.code === "WORKFLOW_VERSION_MISMATCH" ||
      caught.code === "WORKFLOW_SOURCE_MISMATCH" ||
      caught.code === "WORKFLOW_ATTEMPT_MISMATCH")
  );
}

/**
 * A nested workflow forwards the events of its own steps, including the error
 * events of attempts it retried. The gateway keeps the last error event as the
 * delegation error, so a nested run that completed or is waiting would be
 * reported as failed. For an agent that runs a workflow of its own, that error
 * is dropped when the event that set it comes before the nested workflow's
 * final `workflow_completed` or `workflow_waiting` event. An error after it, a
 * thrown error, and a nested run that failed (it ends with its own `error`
 * event) are kept.
 */
function withoutSettledNestedErrors(
  result: AgentInvocationResult,
  agent: BaseAgent | undefined,
): AgentInvocationResult {
  if (!agent || !result.error || !isWorkflowAgent(agent)) return result;
  const typeOf = (event: Event): string | undefined =>
    (event.customMetadata?.workflowEvent as WorkflowEvent | undefined)?.type;
  const finalIndex = result.events.findLastIndex(
    (event) =>
      event.author === agent.name &&
      ["workflow_completed", "workflow_waiting", "error"].includes(
        typeOf(event) ?? "",
      ),
  );
  const final = result.events[finalIndex];
  if (
    !final ||
    (typeOf(final) !== "workflow_completed" &&
      typeOf(final) !== "workflow_waiting")
  ) {
    return result;
  }
  const errorIndex = result.events.findLastIndex(
    (event) => event.errorMessage !== undefined,
  );
  if (
    errorIndex < 0 ||
    errorIndex > finalIndex ||
    result.events[errorIndex]?.errorMessage !== result.error
  ) {
    return result;
  }
  const { error: _error, errorKind: _errorKind, ...settled } = result;
  return settled;
}

/** Recorded failures replayed by `runStep`, keyed by the error it throws. */
const replayedFailures = new WeakMap<WorkflowError, WorkflowStepFailure>();

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

/**
 * Warning code logged when an aborted run could not append its final
 * checkpoint to the session.
 */
const WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED =
  "WORKFLOW_CHECKPOINT_ABORT_RECORD_FAILED";

/**
 * How long, in milliseconds, an aborted root workflow waits for its delegated
 * workflows to settle before it records their checkpoints as they stand.
 */
const DELEGATED_ABORT_GRACE_MS = 500;

/** A workflow run in a gateway child session, as its root sees it. */
interface DelegatedRun {
  /** The run's live map of checkpoint values. */
  readonly checkpoints: ReadonlyMap<string, unknown>;
  /** Resolves once the run has settled. */
  readonly settled: Promise<void>;
  /** Whether the run has settled. */
  done: boolean;
  /** Whether a root has read its checkpoints. */
  collected: boolean;
}

/**
 * Delegated workflow runs by root session: those still going, and aborted
 * ones that settled before their root collected them.
 */
const delegatedRuns = new WeakMap<Session, Set<DelegatedRun>>();

/**
 * Waits until every run in `runs`, including ones added while waiting, has
 * settled, or until `timeoutMs` has passed.
 */
async function settledWithin(
  runs: ReadonlySet<DelegatedRun>,
  timeoutMs: number,
): Promise<void> {
  const deadline = monotonicNow() + timeoutMs;
  while (true) {
    const pending = [...runs].filter((run) => !run.done);
    const remaining = deadline - monotonicNow();
    if (pending.length === 0 || remaining <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending.map((run) => run.settled)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    clearTimeout(timer);
  }
}

/** Compares two checkpoint values by their canonical JSON. */
function sameCheckpointValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function createExecutionAbortScope(
  sourceSignals: readonly (AbortSignal | undefined)[],
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of sourceSignals) {
    if (!signal) continue;
    const abort = () => controller.abort(abortReasonOf(signal.reason));
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
 * The reason a run's execution signal aborts with. A `WorkflowError` whose code
 * is not `WORKFLOW_ABORTED` becomes one, with its code kept as
 * `details.reasonCode`: an abort always records the step in flight as
 * `interrupted` and the run as `cancelled`, whatever error the caller aborted
 * with. Other reasons are kept and mapped by `throwIfRunAborted`.
 */
function abortReasonOf(reason: unknown): unknown {
  if (reason === undefined) {
    return new WorkflowError("WORKFLOW_ABORTED", "Workflow execution aborted");
  }
  if (
    !(reason instanceof WorkflowError) ||
    reason.code === "WORKFLOW_ABORTED"
  ) {
    return reason;
  }
  return new WorkflowError("WORKFLOW_ABORTED", reason.message, {
    ...reason.details,
    reasonCode: reason.code,
  });
}

/**
 * The reason `ctx.parallel` aborts the remaining steps with when one of them
 * fails in `fail-fast` mode (or hits a checkpoint mismatch in any mode):
 * `WORKFLOW_ABORTED`, with the failing step's code
 * as `details.reasonCode` and its id as `details.failedStepId`. A sibling in
 * flight is then recorded `interrupted`, like any aborted step, so a resume
 * re-runs it only with `retryFailedSteps` or `resumePolicy: "retry"`. The
 * failing step's own details are not copied: they describe that step, not
 * the sibling. When the run itself was aborted, the siblings have already
 * stopped with the run's reason, so this one is not used.
 */
function siblingStopReason(failedStep: WorkflowStep, caught: unknown): unknown {
  const error = asWorkflowError(caught);
  const failedStepId =
    typeof failedStep?.id === "string" ? failedStep.id : undefined;
  return new WorkflowError(
    "WORKFLOW_ABORTED",
    failedStepId === undefined
      ? `Stopped because a parallel step failed with ${error.code}`
      : `Stopped because parallel step ${JSON.stringify(failedStepId)} failed with ${error.code}`,
    {
      reasonCode: error.code,
      ...(failedStepId === undefined ? {} : { failedStepId }),
    },
  );
}

/**
 * Node output of a workflow result, following ADK's `maybeSetOutput`
 * (`run_llm_agent_as_node`): visible (non-thought) text joined with `""`; with
 * `structured`, non-blank text is parsed as JSON and kept as text if that
 * fails. Integers beyond `Number.MAX_SAFE_INTEGER` stay exact, as strings, as
 * in `ExternalAgent`. A `Content` without text is passed through unchanged.
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
    const parsed = parseJson(text);
    return parsed.ok ? parsed.value : text;
  }
  return text;
}

/**
 * Throws the run's abort as a `WorkflowError`: the reason itself when it is
 * one, otherwise `WORKFLOW_ABORTED` with the reason's message. Unlike
 * `internal/abort.ts`, a non-workflow reason is never thrown as it is.
 */
function throwIfRunAborted(signal: AbortSignal): void {
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
  throwIfRunAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      try {
        throwIfRunAborted(signal);
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
    case "step_interrupted":
      return `Workflow ${event.workflowId}: ${event.stepId} interrupted`;
    case "step_replayed":
      return `Workflow ${event.workflowId}: ${event.result.id} replayed`;
    case "step_model_changed":
      return `Workflow ${event.workflowId}: ${event.stepId} model changed`;
    case "step_change_accepted":
      return `Workflow ${event.workflowId}: ${event.stepId} ${event.acceptance.kind} change accepted`;
    case "step_waiting":
      return `Workflow ${event.workflowId}: ${event.stepId} waiting for input`;
    case "workflow_waiting":
      return `Workflow ${event.workflowId}: waiting for input`;
    case "checkpoint_saved":
      return `Workflow ${event.workflowId}: checkpoint saved`;
    case "checkpoint_size_warning":
      return `Workflow ${event.workflowId}: checkpoint size warning`;
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

/**
 * JSON form of a gateway interrupt, as persisted in the checkpoint. The stored
 * events keep no `temp:` state keys.
 */
function toStepInterrupt(
  interrupt: NonNullable<AgentInvocationResult["interrupt"]>,
): WorkflowStepInterrupt {
  const stored = JSON.parse(
    JSON.stringify({
      kind: interrupt.kind,
      functionCallIds: interrupt.functionCallIds,
      requests: interrupt.requests,
      events: interrupt.events,
    }),
  ) as WorkflowStepInterrupt;
  for (const event of stored.events) {
    const actions = (event as { actions?: { stateDelta?: unknown } }).actions;
    if (actions && isRecord(actions.stateDelta)) {
      actions.stateDelta = withoutTempStateKeys(actions.stateDelta);
    }
  }
  return stored;
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

/**
 * An acceptance value as logs and spans show it: a model id whole, an input
 * digest cut to `sha256:` and its first 12 hex characters. A full digest of
 * a short input can be reversed by guessing; the checkpoint and the
 * `step_change_accepted` event keep the full value.
 */
function telemetryValue(
  kind: WorkflowCheckpointStepAcceptanceV1["kind"],
  value: string,
): string {
  return kind === "input" ? value.slice(0, INPUT_DIGEST_SHOWN) : value;
}
