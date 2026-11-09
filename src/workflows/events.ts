import type { Content } from "@google/genai";
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
  | WorkflowStepReplayedEvent
  | WorkflowStepWaitingEvent
  | WorkflowCheckpointSavedEvent
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
  "step_replayed",
  "step_waiting",
  "checkpoint_saved",
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
