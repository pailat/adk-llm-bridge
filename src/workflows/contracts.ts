import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import type { WorkflowUserEvent } from "./events.js";
import { toJsonSafeRecord } from "./internal/json-safe-record.js";

/** Reserved child-session state key for the active workflow attempt. */
export const WORKFLOW_ATTEMPT_CONTEXT_STATE_KEY =
  "__adk_llm_bridge_workflow_attempt_v1";

/** Stable identity used by legacy and explicitly unversioned agents. */
export const WORKFLOW_AGENT_REVISION_UNVERSIONED = "unversioned";

/** Maximum durable agent revision length accepted across host/guest boundaries. */
export const MAX_WORKFLOW_AGENT_REVISION_LENGTH = 256;

/** Input accepted by a workflow step. */
export type WorkflowStepInputContent = string | Content;

/**
 * Retry policy applied to one workflow step.
 *
 * @remarks
 * `maxAttempts` is capped by `WorkflowExecutionLimits.maxAttemptsPerStep`.
 */
export interface WorkflowRetryPolicy {
  /** Total number of attempts, including the first execution. */
  maxAttempts: number;
  /** Delay before the second attempt. Defaults to no delay. */
  delayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. */
  backoffMultiplier?: number;
  /** Optional upper bound for a backoff delay. */
  maxDelayMs?: number;
}

/**
 * Behavior when a re-entered checkpoint holds a step that did not complete
 * (left `running`, failed, or `interrupted` by an abort or timeout).
 */
export type WorkflowResumePolicy = "fail" | "retry";

/** A deterministic invocation of a declared ADK sub-agent. */
export interface WorkflowStep {
  /** Stable identifier used for checkpointing and replay. */
  id: string;
  /** Name of a sub-agent declared by the containing WorkflowAgent. */
  agentName: string;
  /**
   * Stable revision or configuration fingerprint for the selected agent.
   * Changing it prevents replay of work produced by a different agent build.
   */
  agentRevision?: string;
  /** Prompt sent to the agent: plain text or ADK `Content`. */
  input: WorkflowStepInputContent;
  /**
   * Relative workspace paths this step may write while its agent is running.
   * Declaring paths requires a workspace adapter on the containing workflow.
   */
  writePaths?: readonly string[];
  /** Retry policy for this step. Without it the step runs once. */
  retry?: WorkflowRetryPolicy;
  /**
   * Defaults to `fail`, preventing accidental duplicate side effects. With
   * `retry`, a re-entered execution runs the step again when it was left
   * `running`, was `interrupted` by an abort or timeout, or ended with a
   * recorded failure. A turn that answers a waiting step still replays a
   * recorded failure, and fails an `interrupted` step with
   * `WORKFLOW_INDETERMINATE_STEP`.
   */
  resumePolicy?: WorkflowResumePolicy;
  /** Free-form JSON-safe data attached to the step for observers. */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregate usage of one step's agent run, JSON-safe.
 *
 * @remarks
 * Sums non-partial event `usageMetadata` and the function calls on those
 * events, including events of nested workflow agents. Only the successful
 * attempt is counted: failed attempts that were retried, and failed steps,
 * report no usage. Values are summed as each runtime reports them, so any
 * double counting there carries into the totals. Cost is not computed.
 */
export interface WorkflowStepUsage {
  /** Summed prompt tokens. */
  promptTokens: number;
  /** Summed completion tokens. */
  completionTokens: number;
  /** Summed total tokens. */
  totalTokens: number;
  /** Summed cached prompt tokens; part of `promptTokens`, not added on top. */
  cachedTokens: number;
  /**
   * Summed prompt-cache write tokens. Absent when no provider in the step
   * reported a cache write (and in results saved before it existed).
   */
  cacheCreationTokens?: number;
  /** Function calls requested on non-partial events. */
  toolCalls: number;
  /**
   * Events that reported usage: one per model response for an `LlmAgent`, one
   * per run for an `ExternalAgent` that ends with a final response.
   */
  llmCalls: number;
}

/**
 * The models of one step's agent run, JSON-safe.
 *
 * @remarks
 * Collected over the successful attempt's non-partial events, nested agents
 * included. Each id appears once, in first-seen order. Neither list is proof
 * of what ran: `resolved` holds only what a trusted runtime reported (see
 * `ExternalAgentModelInfo`), so a Codex or Gemini step has an empty
 * `resolved` and `unknown: true`.
 */
export interface WorkflowStepModels {
  /** Requested ids, unique, first-seen order, nested agents included. */
  requested: string[];
  /** Ids a trusted runtime reported: an external agent's resolved model and the `modelVersion` of LLM responses. */
  resolved: string[];
  /**
   * True when any run in the step was not fully explicit and reported: an
   * external run with no `requested`, a status other than `reported`, or no
   * model info at all; or an `LlmAgent` whose model was inherited or could not
   * be read.
   */
  unknown: boolean;
}

/** Successful result returned by `WorkflowContext.run`. */
export interface WorkflowStepResult {
  /** Discriminator for {@link WorkflowStepOutcome}. */
  status: "completed";
  /** Id of the step that produced this result. */
  id: string;
  /** Name of the sub-agent that ran the step. */
  agentName: string;
  /** Final text output of the agent. */
  output: string;
  /** Full final `Content`, when the agent produced non-text parts. */
  content?: Content;
  /** Runtime-only ADK events; omitted from journaled results. */
  events?: readonly Event[];
  /**
   * Session state changes made by the agent. ADK `temp:` keys and the
   * checkpoint's own keys are left out.
   */
  stateDelta?: Record<string, unknown>;
  /**
   * Aggregate usage of the successful attempt's agent run; earlier failed
   * attempts are not included. Absent in checkpoints written before 0.7.
   * When present in a stored checkpoint it must hold every
   * {@link WorkflowStepUsage} field as a finite, non-negative number, or the
   * checkpoint is rejected as corrupt.
   */
  usage?: WorkflowStepUsage;
  /**
   * The models of the successful attempt's agent run. Absent in checkpoints
   * written before 0.7 and for a step whose agent has no model information.
   * When present in a stored checkpoint it must hold `requested` and
   * `resolved` as arrays of non-empty strings and `unknown` as a boolean, or
   * the checkpoint is rejected as corrupt.
   */
  models?: WorkflowStepModels;
  /** Attempts used, including the successful one. */
  attempts: number;
  /** Epoch milliseconds when the step started. */
  startedAt: number;
  /** Epoch milliseconds when the step finished. */
  completedAt: number;
  /** True when the result came from a checkpoint instead of a new run. */
  replayed?: boolean;
}

/** Failed item returned by all-settled parallel execution. */
export interface WorkflowStepFailure {
  /** Discriminator for {@link WorkflowStepOutcome}. */
  status: "failed";
  /** Id of the failed step. */
  id: string;
  /** Name of the sub-agent that ran the step. */
  agentName: string;
  /** JSON-safe error of the last attempt. */
  error: WorkflowSerializedError;
  /** Attempts used before giving up. */
  attempts: number;
  /** Epoch milliseconds when the step started. */
  startedAt: number;
  /** Epoch milliseconds when the step finished. */
  completedAt: number;
  /**
   * True when the failure was read back from the checkpoint instead of
   * happening on this turn (the step did not run again).
   */
  replayed?: boolean;
}

/** JSON-safe workspace capability granted to one workflow attempt. */
export interface WorkflowAttemptWorkspaceContext {
  /** Workspace the attempt may write to. */
  workspaceId: string;
  /** Lease that authorizes the writes. */
  leaseId: string;
  /** Monotonic token that lets the host reject writes from stale holders. */
  fencingToken?: number;
  /** Epoch milliseconds when the lease expires. */
  expiresAt?: number;
}

/**
 * Durable identity and host capabilities for one workflow agent attempt.
 *
 * `idempotencyKey` intentionally excludes `attempt`, so retries and resumes of
 * the same step input address the same durable outbox record.
 */
export interface WorkflowAttemptContext {
  /** Id of the running workflow definition. */
  workflowId: string;
  /** Version of the running workflow definition. */
  workflowVersion: string;
  /** Id of this execution of the workflow. */
  executionId: string;
  /** Id of the step being attempted. */
  stepId: string;
  /** Name of the sub-agent that runs the step. */
  agentName: string;
  /** Revision of the agent; `unversioned` when none was declared. */
  agentRevision: string;
  /** One-based attempt number. */
  attempt: number;
  /** Hash of the canonical step input. */
  inputHash: string;
  /** Durable outbox key shared by every attempt of the same step input. */
  idempotencyKey: string;
  /** Workspace capability, present only when the step declares `writePaths`. */
  workspace?: WorkflowAttemptWorkspaceContext;
}

/**
 * JSON-safe durable result returned instead of invoking the agent.
 * Runtime-only `events` must be omitted from the journaled result.
 */
export interface WorkflowAttemptReplay {
  /** Outbox key the journaled result belongs to. */
  idempotencyKey: string;
  /** Omitted legacy records are interpreted as `unversioned`. */
  agentRevision?: string;
  /** Journaled result returned in place of a new agent run. */
  result: WorkflowStepResult;
}

/** Result of one step in an all-settled parallel run: success or failure. */
export type WorkflowStepOutcome = WorkflowStepResult | WorkflowStepFailure;

/**
 * How `WorkflowContext.parallel` reacts to a failing step: `fail-fast` rejects
 * on the first failure, `all-settled` returns every outcome.
 *
 * @remarks
 * In `fail-fast` mode the first failure aborts the remaining steps. A step
 * still in flight is checkpointed `interrupted` with `WORKFLOW_ABORTED`
 * (`details.reasonCode` is the failing step's code, `details.failedStepId` its
 * id), so a resume re-runs it only with `retryFailedSteps` or
 * `resumePolicy: "retry"`; otherwise it fails with
 * `WORKFLOW_INDETERMINATE_STEP`. A step that had not started is not recorded.
 */
export type WorkflowParallelFailureMode = "fail-fast" | "all-settled";

/** Options for `WorkflowContext.parallel`. */
export interface WorkflowParallelOptions {
  /** Per-call concurrency override, bounded by the execution-wide limit. */
  concurrency?: number;
  /** Defaults to `fail-fast`. */
  failureMode?: WorkflowParallelFailureMode;
}

/**
 * Limits shared by trusted and sandboxed workflow runtimes.
 *
 * @remarks
 * Unset fields use {@link DEFAULT_WORKFLOW_EXECUTION_LIMITS}.
 */
export interface WorkflowExecutionLimits {
  /**
   * Maximum number of steps one turn of the workflow may execute.
   *
   * @remarks
   * A step counts when its agent runs in this turn, including a waiting step
   * that continues with the turn's answer and a step a `beforeStep` or
   * `beforeAttempt` hook answers (admitted before the hook runs). Steps
   * replayed from the checkpoint do not count here;
   * {@link WorkflowExecutionLimits.maxReplayedSteps} bounds them. The check
   * runs before the step is saved `running` or its agent starts, also inside
   * `ctx.parallel`. On `WORKFLOW_LIMIT_EXCEEDED` the details carry `limit`,
   * `limitName`, `stepId`, `executedSteps`, `replayedSteps`, `maxSteps` and
   * `maxReplayedSteps`, for handler and script workflows alike.
   */
  maxSteps?: number;
  /**
   * Maximum number of steps one turn of the workflow may replay without
   * executing their agent.
   *
   * @remarks
   * A resumed turn replays every step the execution recorded before, so this
   * bound grows with the life of the run, and it guards against a script that
   * loops over recorded steps. When a resume fails with
   * `WORKFLOW_LIMIT_EXCEEDED` and `limitName: "maxReplayedSteps"`, raise it and
   * resume the same execution id. A script workflow bounds its yielded messages
   * at twice the sum of both step limits plus one.
   *
   * @defaultValue Ten times the effective `maxSteps` (1000 with the default
   * `maxSteps`). {@link DEFAULT_WORKFLOW_EXECUTION_LIMITS} lists the value for
   * the default `maxSteps`.
   */
  maxReplayedSteps?: number;
  /** Maximum parallel steps in flight. */
  maxConcurrency?: number;
  /** Upper bound for `WorkflowRetryPolicy.maxAttempts`. */
  maxAttemptsPerStep?: number;
  /**
   * Time budget for the whole execution, in milliseconds, measured by a
   * runtime timer. A timer does not fire while the host sleeps, and whether
   * time asleep counts toward it depends on the runtime and operating system.
   */
  timeoutMs?: number;
  /**
   * Time budget, in milliseconds of monotonic time, for each guest turn and
   * for set-up (the compile of the bridge's wrapper included). QuickJS checks
   * it between bytecode operations, so it is not a hard bound on the host
   * thread; see the "Time bound" section of `docs/workflow-orchestration.md`.
   */
  cpuTimeMs?: number;
  /** Sandbox heap limit in bytes. */
  memoryBytes?: number;
  /**
   * Sandbox stack limit in bytes. A value above 32768 (32 KiB) is refused with
   * `WORKFLOW_DEFINITION_INVALID`: QuickJS runs on the host's own stack, and a
   * larger limit lets the host overflow before QuickJS reports the limit,
   * which leaks the runtime. 32 KiB allows about 190 nested calls.
   */
  stackBytes?: number;
  /** Maximum script source size in bytes. */
  maxSourceBytes?: number;
  /** Maximum size of one host/guest message in bytes. */
  maxMessageBytes?: number;
}

/** Limits applied when a workflow definition does not override them. */
export const DEFAULT_WORKFLOW_EXECUTION_LIMITS: Readonly<
  Required<WorkflowExecutionLimits>
> = Object.freeze({
  maxSteps: 100,
  maxReplayedSteps: 1000,
  maxConcurrency: 4,
  maxAttemptsPerStep: 1,
  timeoutMs: 5 * 60 * 1000,
  cpuTimeMs: 5 * 1000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 32 * 1024,
  maxSourceBytes: 256 * 1024,
  maxMessageBytes: 1024 * 1024,
});

/** Public API available to a trusted workflow handler. */
export interface WorkflowContext {
  /** Input the workflow was started with. */
  readonly input: Content;
  /** Text of the workflow input. */
  readonly inputText: string;
  /** Aborted when the execution is cancelled or times out. */
  readonly signal: AbortSignal;
  /**
   * Runs one step.
   *
   * @throws {@link WorkflowError} with the step's failure after retries.
   * @throws {@link WorkflowInterruptedError} when the step waits for input.
   */
  run(step: WorkflowStep): Promise<WorkflowStepResult>;
  /**
   * Runs steps concurrently, bounded by `maxConcurrency`.
   *
   * @throws {@link WorkflowError} on the first failure in `fail-fast` mode.
   */
  parallel(
    steps: readonly WorkflowStep[],
    options?: WorkflowParallelOptions,
  ): Promise<WorkflowStepOutcome[]>;
  /** Emits a user-defined event into the workflow event stream. */
  emit(event: WorkflowUserEvent): void;
}

/** Value a workflow handler may return as its final output. */
export type WorkflowOutput = string | Content | undefined;

/** Function body of a trusted workflow. */
export type WorkflowHandler = (
  context: WorkflowContext,
) => WorkflowOutput | Promise<WorkflowOutput>;

/**
 * A step whose sub-agent stopped waiting for a human or an external system
 * (ADK `adk_request_input`, `adk_request_confirmation`,
 * `adk_request_credential`, or a long-running tool call). Persisted in the
 * checkpoint so a later turn can answer it.
 */
export interface WorkflowStepInterrupt {
  /** What the agent is waiting for. */
  kind: "input" | "credential" | "confirmation" | "long-running";
  /** Function-call ids that must be answered to resume the step. */
  functionCallIds: string[];
  /** ADK `UserInputRequest` view of the pending requests (JSON form). */
  requests: Array<Record<string, unknown>>;
  /** Events of the interrupted delegation (JSON form), needed to resume it. */
  events: Array<Record<string, unknown>>;
}

/** Final summary of one workflow execution. */
export interface WorkflowExecutionSummary {
  /** Id of the workflow definition. */
  workflowId: string;
  /** Version of the workflow definition. */
  workflowVersion: string;
  /** Id of this execution. */
  executionId: string;
  /** Terminal status; `waiting` means the run paused for external input. */
  status: "completed" | "failed" | "cancelled" | "waiting";
  /** Steps that ran or were replayed. */
  steps: number;
  /** Steps answered from a checkpoint. */
  replayedSteps: number;
  /** Epoch milliseconds when the execution started. */
  startedAt: number;
  /** Epoch milliseconds when the execution ended. */
  completedAt: number;
}

/** Machine-readable codes carried by {@link WorkflowError}. */
export type WorkflowErrorCode =
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_ATTEMPT_MISMATCH"
  | "WORKFLOW_DEFINITION_INVALID"
  | "WORKFLOW_DEFINITION_NOT_FOUND"
  | "WORKFLOW_EXECUTION_ERROR"
  | "WORKFLOW_INDETERMINATE_STEP"
  | "WORKFLOW_INPUT_MISMATCH"
  | "WORKFLOW_LIMIT_EXCEEDED"
  | "WORKFLOW_REPLAY_ACCEPTANCE_INVALID"
  | "WORKFLOW_SANDBOX_UNAVAILABLE"
  | "WORKFLOW_SCRIPT_INVALID"
  | "WORKFLOW_SOURCE_MISMATCH"
  | "WORKFLOW_STEP_INTERRUPTED"
  | "WORKFLOW_STEP_MISMATCH"
  | "WORKFLOW_UNKNOWN_AGENT"
  | "WORKFLOW_VERSION_MISMATCH"
  | "WORKFLOW_WORKSPACE_LEASE_LOST"
  | "WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE";

/** JSON-safe form of a {@link WorkflowError}. */
export interface WorkflowSerializedError {
  /** Error code. */
  code: WorkflowErrorCode;
  /** Human-readable message. */
  message: string;
  /** Extra structured context. */
  details?: Record<string, unknown>;
}

/** Error raised by the workflow runtime; `code` identifies the failure. */
export class WorkflowError extends Error {
  /** Machine-readable error code. */
  readonly code: WorkflowErrorCode;
  /** Extra structured context. */
  readonly details?: Record<string, unknown>;

  /**
   * @param code - Error code.
   * @param message - Human-readable message.
   * @param details - Optional structured context.
   */
  constructor(
    code: WorkflowErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }

  /**
   * Returns the JSON-safe form of this error.
   *
   * @remarks
   * `details` is a JSON projection, so the result can always be recorded in a
   * checkpoint: `undefined` values and functions are dropped, non-finite
   * numbers become `null` and a `bigint` becomes its decimal string. Details
   * that do not project onto an object are omitted.
   */
  toJSON(): WorkflowSerializedError {
    const details = toJsonSafeRecord(this.details);
    return {
      code: this.code,
      message: this.message,
      ...(details ? { details } : {}),
    };
  }
}

/**
 * Thrown by `WorkflowContext.run` / `parallel` when a step is waiting for
 * input. It unwinds the handler; the runtime catches it, keeps the checkpoint
 * (step status `waiting`) and ends the run without failing the workflow.
 * Handlers must not swallow it.
 */
export class WorkflowInterruptedError extends WorkflowError {
  /** Pending interrupts, one per waiting step. */
  readonly interrupts: ReadonlyArray<{
    stepId: string;
    interrupt: WorkflowStepInterrupt;
  }>;

  /** @param interrupts - Waiting steps and what each one needs. */
  constructor(
    interrupts: ReadonlyArray<{
      stepId: string;
      interrupt: WorkflowStepInterrupt;
    }>,
  ) {
    super(
      "WORKFLOW_STEP_INTERRUPTED",
      `Workflow is waiting for input on step: ${interrupts
        .map((entry) => entry.stepId)
        .join(", ")}`,
      { stepIds: interrupts.map((entry) => entry.stepId) },
    );
    this.name = "WorkflowInterruptedError";
    this.interrupts = interrupts;
  }
}
