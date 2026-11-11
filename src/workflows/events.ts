import type { Content } from "@google/genai";
import type { WorkflowStepResumeReason } from "./checkpoint/schema.js";
import type {
  WorkflowExecutionSummary,
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "./contracts.js";

/** Fields carried by every workflow event. */
export interface WorkflowEventBase {
  /** Id of the workflow definition. */
  workflowId: string;
  /** Version of the workflow definition. */
  workflowVersion: string;
  /** Id of the execution that emitted the event. */
  executionId: string;
  /** Epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/** The execution began. */
export interface WorkflowStartedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "workflow_started";
}

/** A step attempt began. */
export interface WorkflowStepStartedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_started";
  /** The step being run. */
  step: WorkflowStep;
  /** One-based attempt number. */
  attempt: number;
  /**
   * Why this attempt was entered: `interrupted` when the previous attempt did
   * not settle (the step was left `running` by a process that ended, or
   * stored as `interrupted` by an abort or timeout), `retry` after a failed
   * attempt. Unset on a first attempt and when a waiting step continues with
   * its answer (same attempt number); the step record keeps the reason the
   * attempt was entered with.
   */
  resumeReason?: WorkflowStepResumeReason;
  /**
   * The model id the step's agent names, read before it runs: an external
   * agent's driver `model`; an `LlmAgent`'s string or model instance, or the
   * id it inherits from an ancestor `LlmAgent`. Absent when the agent names
   * none or the model cannot be read. It is what was requested, not what ran:
   * see `result.models` on `step_completed`.
   */
  requestedModel?: string;
}

/** A step finished successfully. */
export interface WorkflowStepCompletedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_completed";
  /** Result of the step. */
  result: WorkflowStepResult;
}

/** A step failed after exhausting its retries. */
export interface WorkflowStepFailedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_failed";
  /** Failure details. */
  failure: WorkflowStepFailure;
}

/**
 * The run was aborted while a step was in flight. The checkpoint records the
 * step as `interrupted`. A resume runs it again as the next attempt only with
 * `retryFailedSteps` or the step's `resumePolicy: "retry"`; otherwise it fails
 * with `WORKFLOW_INDETERMINATE_STEP`, because the step may have had side
 * effects.
 */
export interface WorkflowStepInterruptedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_interrupted";
  /** Id of the interrupted step. */
  stepId: string;
  /** Attempt that was in flight. */
  attempt: number;
}

/** A step was answered from a checkpoint instead of running again. */
export interface WorkflowStepReplayedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_replayed";
  /** The journaled result that was replayed. */
  result: WorkflowStepResult;
}

/** A step's sub-agent stopped waiting for input (HITL); answer to resume. */
export interface WorkflowStepWaitingEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_waiting";
  /** Id of the waiting step. */
  stepId: string;
  /** Sub-agent that is waiting. */
  agentName: string;
  /** One-based attempt number. */
  attempt: number;
  /** What the agent is waiting for. */
  kind: "input" | "credential" | "confirmation" | "long-running";
  /** Function-call ids to answer with `functionResponse` parts. */
  functionCallIds: readonly string[];
}

/** The checkpoint store persisted a new checkpoint. */
export interface WorkflowCheckpointSavedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "checkpoint_saved";
  /** Key under which the checkpoint was stored. */
  checkpointKey: string;
  /** Step whose completion triggered the save, if any. */
  stepId?: string;
}

/** One part of a checkpoint and its UTF-8 JSON size. */
export interface WorkflowCheckpointSizeContributor {
  /**
   * Keys from the checkpoint root, for example
   * `["steps", "review", "result", "output"]`.
   */
  path: readonly string[];
  /** UTF-8 JSON size of the value at `path`. */
  bytes: number;
}

/**
 * A saved checkpoint reached 80% of the store's `maxCheckpointBytes`.
 *
 * @remarks
 * Emitted at most once per checkpoint key per run, after the
 * `checkpoint_saved` event of the save that crossed the threshold, and only
 * for stores that expose `maxCheckpointBytes`. The run continues; a later save
 * above the limit fails with `checkpoint_size_limit_exceeded`.
 */
export interface WorkflowCheckpointSizeWarningEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "checkpoint_size_warning";
  /** Key of the checkpoint. */
  checkpointKey: string;
  /** Step whose transition triggered the save, if any. */
  stepId?: string;
  /** UTF-8 JSON size of the saved checkpoint. */
  bytes: number;
  /** The store's limit. */
  maxBytes: number;
  /** Largest parts of the checkpoint (at most five), largest first. */
  largestContributors: readonly WorkflowCheckpointSizeContributor[];
}

/** Output produced by the workflow. */
export interface WorkflowOutputEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "output";
  /** Output text or `Content`. */
  content: string | Content;
  /** True for an incremental chunk, not the final output. */
  partial?: boolean;
}

/** The execution failed. */
export interface WorkflowErrorEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "error";
  /** JSON-safe error. */
  error: WorkflowSerializedError;
}

/** The execution ended (completed, failed or cancelled). */
export interface WorkflowCompletedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "workflow_completed";
  /** Final summary. */
  summary: WorkflowExecutionSummary;
}

/** The run ended because one or more steps wait for input; it is resumable. */
export interface WorkflowWaitingEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "workflow_waiting";
  /** Summary with status `waiting`. */
  summary: WorkflowExecutionSummary;
  /** Ids of the steps that wait for input. */
  stepIds: readonly string[];
}

/** User-defined event emitted through `WorkflowContext.emit`. */
export interface WorkflowCustomEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "custom";
  /** Event name chosen by the workflow code. */
  name: string;
  /** JSON-safe payload. */
  data?: unknown;
}

/** Event accepted from trusted or sandboxed workflow code via `ctx.emit`. */
export interface WorkflowUserEvent {
  /** Event discriminator. */
  type: "custom";
  /** Event name. */
  name: string;
  /** JSON-safe payload. */
  data?: unknown;
}

/** Lifecycle, output, checkpoint, and user events emitted by a workflow runtime. */
export type WorkflowEvent =
  | WorkflowStartedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepCompletedEvent
  | WorkflowStepFailedEvent
  | WorkflowStepInterruptedEvent
  | WorkflowStepReplayedEvent
  | WorkflowStepWaitingEvent
  | WorkflowCheckpointSavedEvent
  | WorkflowCheckpointSizeWarningEvent
  | WorkflowOutputEvent
  | WorkflowErrorEvent
  | WorkflowCompletedEvent
  | WorkflowWaitingEvent
  | WorkflowCustomEvent;

const WORKFLOW_EVENT_TYPES = new Set<WorkflowEvent["type"]>([
  "workflow_started",
  "step_started",
  "step_completed",
  "step_failed",
  "step_interrupted",
  "step_replayed",
  "step_waiting",
  "checkpoint_saved",
  "checkpoint_size_warning",
  "output",
  "error",
  "workflow_completed",
  "workflow_waiting",
  "custom",
]);

/**
 * Type guard for {@link WorkflowEvent}.
 *
 * @remarks
 * Checks the event type and the base fields only, not the type-specific
 * payload.
 *
 * @param value - Value to test.
 * @returns True when `value` has a known `type` and the base fields.
 */
export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<WorkflowEventBase> & { type?: unknown };
  return (
    typeof candidate.type === "string" &&
    WORKFLOW_EVENT_TYPES.has(candidate.type as WorkflowEvent["type"]) &&
    typeof candidate.workflowId === "string" &&
    typeof candidate.workflowVersion === "string" &&
    typeof candidate.executionId === "string" &&
    typeof candidate.timestamp === "number"
  );
}
