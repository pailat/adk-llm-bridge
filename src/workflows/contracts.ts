import type { Event } from "@google/adk";
import type { Content } from "@google/genai";
import type { WorkflowUserEvent } from "./events.js";

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

/** Behavior when a checkpoint contains a step whose completion is unknown. */
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
  /** Defaults to `fail`, preventing accidental duplicate side effects. */
  resumePolicy?: WorkflowResumePolicy;
  /** Free-form JSON-safe data attached to the step for observers. */
  metadata?: Record<string, unknown>;
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
  /** Session state changes made by the agent. */
  stateDelta?: Record<string, unknown>;
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
  /** Maximum number of step invocations in one execution. */
  maxSteps?: number;
  /** Maximum parallel steps in flight. */
  maxConcurrency?: number;
  /** Upper bound for `WorkflowRetryPolicy.maxAttempts`. */
  maxAttemptsPerStep?: number;
  /** Wall-clock budget for the whole execution, in milliseconds. */
  timeoutMs?: number;
  /** Sandboxed runtime CPU budget per uninterrupted guest turn. */
  cpuTimeMs?: number;
  /** Sandbox heap limit in bytes. */
  memoryBytes?: number;
  /** Sandbox stack limit in bytes. */
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
  maxConcurrency: 4,
  maxAttemptsPerStep: 1,
  timeoutMs: 5 * 60 * 1000,
  cpuTimeMs: 5 * 1000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
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

  /** Returns the JSON-safe form of this error. */
  toJSON(): WorkflowSerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
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
