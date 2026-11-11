import type { Content } from "@google/genai";
import type { WorkflowCheckpointStepAcceptanceV1 } from "./checkpoint/replay-acceptance.js";
import type { WorkflowStepResumeReason } from "./checkpoint/schema.js";
import type {
  WorkflowExecutionSummary,
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "./contracts.js";

/**
 * Kind of the agent that runs a workflow step.
 *
 * - `external`: an `ExternalAgent` (a coding-agent runtime behind a driver).
 * - `llm`: an ADK `LlmAgent`, subclasses included.
 * - `workflow`: an agent that runs a workflow of its own: `WorkflowAgent`,
 *   `ScriptWorkflowAgent`, ADK's `Workflow`, `SequentialAgent`,
 *   `ParallelAgent` and `LoopAgent`.
 * - `host`: any other `BaseAgent` (a custom agent, a `RoutedAgent`, ...).
 */
export type WorkflowAgentKind = "llm" | "external" | "host" | "workflow";

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
  /**
   * What kind of agent runs the step, read from the agent before it runs:
   * `external` (an `ExternalAgent`), `llm` (an `LlmAgent`, subclasses
   * included), `workflow` (an agent that runs a workflow of its own: the
   * bridge's workflow agents and ADK's `Workflow`, `SequentialAgent`,
   * `ParallelAgent` and `LoopAgent`) or `host` (any other `BaseAgent`).
   * Absent on events recorded before 0.7.0.
   */
  agentKind?: WorkflowAgentKind;
}

/** A step finished successfully. */
export interface WorkflowStepCompletedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_completed";
  /** Result of the step. */
  result: WorkflowStepResult;
  /** Kind of the step's agent, as on `step_started`. Absent on older events. */
  agentKind?: WorkflowAgentKind;
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

/**
 * A replayed or resumed step's agent now requests another model than the one
 * recorded when the step ran.
 *
 * @remarks
 * Emitted in `replay.modelChange: "warn"` mode (the default) before the step's
 * `step_replayed` (or its replayed `step_failed`), and not when the step runs
 * again. The saved result is still used: it was produced by the saved model.
 */
export interface WorkflowStepModelChangedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_model_changed";
  /** Id of the step. */
  stepId: string;
  /** Model the step's agent requested when the step ran, or the `to` of its latest accepted model change; absent when it named none. */
  savedRequestedModel?: string;
  /** Always `true` here: a step with no model record cannot be compared and gets no event. */
  savedRecorded: boolean;
  /** Models the runtime reported when the step ran (`result.models.resolved`), when stored. */
  savedResolvedModels?: readonly string[];
  /** Model the step's agent requests now; absent when it names none or it cannot be read. */
  requestedModel?: string;
  /** What the runtime did: replayed the saved result, replayed a saved failure, or continued a waiting step. */
  action: "replayed" | "replayed-failure" | "resumed";
}

/**
 * A host acceptance (`replay.acceptChanges`) was applied to a completed step
 * and saved in the checkpoint.
 *
 * @remarks
 * Emitted after the `checkpoint_saved` of the save that recorded it and
 * before the step's `step_replayed`, once per applied entry. Not emitted when
 * a relaunch carries an entry an earlier turn already applied.
 */
export interface WorkflowStepChangeAcceptedEvent extends WorkflowEventBase {
  /** Event discriminator. */
  type: "step_change_accepted";
  /** Id of the step. */
  stepId: string;
  /** The audit entry stored on the step. */
  acceptance: WorkflowCheckpointStepAcceptanceV1;
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
  | WorkflowStepModelChangedEvent
  | WorkflowStepChangeAcceptedEvent
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
  "step_model_changed",
  "step_change_accepted",
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
