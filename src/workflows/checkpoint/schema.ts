import type { Content } from "@google/genai";
import type {
  WorkflowErrorCode,
  WorkflowSerializedError,
  WorkflowStepInterrupt,
  WorkflowStepResult,
  WorkflowStepUsage,
} from "../contracts.js";
import { MAX_WORKFLOW_AGENT_REVISION_LENGTH } from "../contracts.js";

/** Schema version written to and required of every durable checkpoint. */
export const WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Lifecycle status of a whole workflow execution. */
export type WorkflowCheckpointStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Lifecycle status of one step. `waiting` means the step raised an interrupt;
 * `interrupted` means the run was aborted while the step was in flight, so the
 * step neither completed nor failed on its own. A resume clears it by running
 * the step again when `retryFailedSteps` or `resumePolicy: "retry"` is set;
 * otherwise it fails with `WORKFLOW_INDETERMINATE_STEP`.
 */
export type WorkflowCheckpointStepStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

/**
 * Why a step attempt was entered when it was not a first attempt.
 *
 * - `interrupted`: the previous attempt did not settle: it was still `running`
 *   in the checkpoint (the process ended first), or it was stored as
 *   `interrupted` by an abort or timeout.
 * - `retry`: the previous attempt had failed and the step ran again.
 */
export type WorkflowStepResumeReason = "interrupted" | "retry";

/** Durable record of one workflow step. */
export interface WorkflowCheckpointStepV1 {
  /** Step id, unique within the execution. */
  id: string;
  /** Name of the agent that runs the step. */
  agentName: string;
  /** Agent revision at the time the step ran; a resume with another revision is rejected. */
  agentRevision?: string;
  /** Hash of the step input. */
  inputHash: string;
  /** Current step status. */
  status: WorkflowCheckpointStepStatus;
  /** Number of attempts started so far, at least 1. */
  attempts: number;
  /**
   * Why the current attempt was entered; absent on a first attempt and in
   * checkpoints written before this field existed.
   */
  resumeReason?: WorkflowStepResumeReason;
  /** Epoch milliseconds when the first attempt started. */
  startedAt: number;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
  /** Epoch milliseconds when the step finished; set only for `completed`, `failed` and `interrupted`. */
  completedAt?: number;
  /** Durable result; set only for `completed`. */
  result?: WorkflowStepResult;
  /** Serialized error; set only for `failed` and `interrupted`. */
  error?: WorkflowSerializedError;
  /** Present only while `status` is `waiting`. */
  interrupt?: WorkflowStepInterrupt;
}

/** Durable representation written to ADK session state. */
export interface WorkflowCheckpointV1 {
  /** Always {@link WORKFLOW_CHECKPOINT_SCHEMA_VERSION}. */
  schemaVersion: typeof WORKFLOW_CHECKPOINT_SCHEMA_VERSION;
  /** Id of the workflow definition. */
  workflowId: string;
  /** Version of the workflow definition. */
  workflowVersion: string;
  /** Id of the execution this checkpoint belongs to. */
  executionId: string;
  /** Hash of the workflow input. */
  inputHash: string;
  /**
   * Original workflow input, kept only while a step is `waiting` so the turn
   * that answers it (whose user message is the answer) can restore it.
   */
  input?: Content;
  /** Present for script workflows; trusted handlers are versioned explicitly. */
  sourceHash?: string;
  /** Workflow status. */
  status: WorkflowCheckpointStatus;
  /** Steps keyed by step id. */
  steps: Record<string, WorkflowCheckpointStepV1>;
  /** Final output; set only when `status` is `completed`. */
  output?: string | Content;
  /** Serialized error; set only when `status` is `failed` or `cancelled`. */
  error?: WorkflowSerializedError;
  /** Epoch milliseconds when the execution started. */
  startedAt: number;
  /** Epoch milliseconds of the last update. */
  updatedAt: number;
  /** Epoch milliseconds when the execution ended; unset while `running`. */
  completedAt?: number;
}

/**
 * Type guard that validates a value read from storage as a checkpoint.
 *
 * @remarks
 * Fails closed: accessors, cycles, exotic prototypes and inconsistent
 * status/timestamp combinations all make it return `false`. Unknown JSON-safe
 * fields are accepted for forward compatibility.
 *
 * @param value - Untrusted value, typically parsed JSON.
 * @returns `true` when the value is a well-formed {@link WorkflowCheckpointV1}; never throws.
 * @internal
 */
export function isWorkflowCheckpointV1(
  value: unknown,
): value is WorkflowCheckpointV1 {
  try {
    return isWorkflowCheckpointV1Value(value);
  } catch {
    return false;
  }
}

function isWorkflowCheckpointV1Value(
  value: unknown,
): value is WorkflowCheckpointV1 {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (hasAccessorProperty(value)) return false;
  if (
    value.schemaVersion !== WORKFLOW_CHECKPOINT_SCHEMA_VERSION ||
    !isNonEmptyString(value.workflowId) ||
    !isNonEmptyString(value.workflowVersion) ||
    !isNonEmptyString(value.executionId) ||
    !isNonEmptyString(value.inputHash) ||
    (value.sourceHash !== undefined && !isNonEmptyString(value.sourceHash)) ||
    !isCheckpointStatus(value.status) ||
    !isFiniteNumber(value.startedAt) ||
    !isFiniteNumber(value.updatedAt) ||
    value.updatedAt < value.startedAt ||
    !isOptionalFiniteNumber(value.completedAt) ||
    (typeof value.completedAt === "number" &&
      value.completedAt < value.startedAt) ||
    !isPlainRecord(value.steps) ||
    !isWorkflowOutput(value.output) ||
    !isWorkflowContent(value.input) ||
    (value.error !== undefined && !isSerializedError(value.error))
  ) {
    return false;
  }

  if (
    value.status === "completed" &&
    (value.completedAt === undefined || value.error !== undefined)
  ) {
    return false;
  }
  if (
    (value.status === "failed" || value.status === "cancelled") &&
    (value.completedAt === undefined || !isSerializedError(value.error))
  ) {
    return false;
  }
  if (value.status === "running" && value.completedAt !== undefined) {
    return false;
  }

  if (
    !Object.entries(value.steps).every(([stepId, step]) => isStep(step, stepId))
  ) {
    return false;
  }

  // Unknown JSON-safe fields remain accepted for forward compatibility, while
  // the complete durable graph still rejects cycles, exotic prototypes, and
  // accessors. Legacy runtime fields are removed before this final check.
  return isJsonSafe(
    toDurableWorkflowCheckpoint(value as unknown as WorkflowCheckpointV1),
    new Set(),
    true,
  );
}

/**
 * Removes runtime-only fields while preserving the v1 durable shape.
 *
 * @param checkpoint - Checkpoint that may carry transient `events` or `replayed` on step results.
 * @returns The same object when nothing needs removing, otherwise a copy without those fields.
 * @internal
 */
export function toDurableWorkflowCheckpoint(
  checkpoint: WorkflowCheckpointV1,
): WorkflowCheckpointV1 {
  let changed = false;
  const steps = Object.fromEntries(
    Object.entries(checkpoint.steps).map(([stepId, step]) => {
      if (!step.result) return [stepId, step];
      const { events: _events, replayed: _replayed, ...result } = step.result;
      if (!("events" in step.result) && !("replayed" in step.result)) {
        return [stepId, step];
      }
      changed = true;
      return [stepId, { ...step, result }];
    }),
  );
  return changed ? { ...checkpoint, steps } : checkpoint;
}

function isStep(
  value: unknown,
  stepId: string,
): value is WorkflowCheckpointStepV1 {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (hasAccessorProperty(value)) return false;
  if (
    value.id === stepId &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.agentName) &&
    (value.agentRevision === undefined ||
      isBoundedRevision(value.agentRevision)) &&
    isNonEmptyString(value.inputHash) &&
    (value.status === "running" ||
      value.status === "waiting" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "interrupted") &&
    Number.isSafeInteger(value.attempts) &&
    (value.attempts as number) >= 1 &&
    (value.resumeReason === undefined ||
      value.resumeReason === "interrupted" ||
      value.resumeReason === "retry") &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.updatedAt) &&
    value.updatedAt >= value.startedAt &&
    isOptionalFiniteNumber(value.completedAt)
  ) {
    if (
      value.status === "running" &&
      (value.result !== undefined ||
        value.error !== undefined ||
        value.completedAt !== undefined ||
        value.interrupt !== undefined)
    ) {
      return false;
    }
    if (
      value.status === "waiting" &&
      (value.result !== undefined ||
        value.error !== undefined ||
        value.completedAt !== undefined ||
        !isStepInterrupt(value.interrupt))
    ) {
      return false;
    }
    if (
      (value.status === "completed" ||
        value.status === "failed" ||
        value.status === "interrupted") &&
      value.interrupt !== undefined
    ) {
      return false;
    }
    if (
      value.status === "completed" &&
      (value.completedAt === undefined ||
        value.error !== undefined ||
        !isStepResult(value.result, value))
    ) {
      return false;
    }
    if (
      (value.status === "failed" || value.status === "interrupted") &&
      (value.completedAt === undefined ||
        value.result !== undefined ||
        !isSerializedError(value.error))
    ) {
      return false;
    }
    // Only an abort writes `interrupted`; any other error with it means the
    // record is corrupt, and a corrupt marker must not unlock a re-run.
    if (
      value.status === "interrupted" &&
      (value.error as WorkflowSerializedError | undefined)?.code !==
        "WORKFLOW_ABORTED"
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function isStepInterrupt(value: unknown): value is WorkflowStepInterrupt {
  return (
    isPlainRecord(value) &&
    !hasAccessorProperty(value) &&
    (value.kind === "input" ||
      value.kind === "credential" ||
      value.kind === "confirmation" ||
      value.kind === "long-running") &&
    Array.isArray(value.functionCallIds) &&
    value.functionCallIds.length > 0 &&
    value.functionCallIds.every(isNonEmptyString) &&
    Array.isArray(value.requests) &&
    value.requests.every(isPlainRecord) &&
    Array.isArray(value.events) &&
    value.events.every(isStoredInterruptEvent) &&
    isJsonSafe(value, new Set(), true)
  );
}

/**
 * The fields of an ADK `Event` that resuming an interrupted step reads. The
 * rest of the event stays free-form JSON.
 */
function isStoredInterruptEvent(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const { actions, author, branch, content, longRunningToolIds } = value;
  return (
    (actions === undefined ||
      (isPlainRecord(actions) &&
        (actions.stateDelta === undefined ||
          isPlainRecord(actions.stateDelta)))) &&
    (author === undefined || typeof author === "string") &&
    (branch === undefined || typeof branch === "string") &&
    (longRunningToolIds === undefined ||
      (Array.isArray(longRunningToolIds) &&
        longRunningToolIds.every((id) => typeof id === "string"))) &&
    (content === undefined ||
      (isPlainRecord(content) &&
        (content.role === undefined || typeof content.role === "string") &&
        (content.parts === undefined ||
          (Array.isArray(content.parts) &&
            content.parts.every(
              (part) =>
                isPlainRecord(part) &&
                (part.functionCall === undefined ||
                  isPlainRecord(part.functionCall)),
            )))))
  );
}

function isBoundedRevision(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    value === value.trim() &&
    !value.includes("\0") &&
    value.length <= MAX_WORKFLOW_AGENT_REVISION_LENGTH
  );
}

function isStepResult(
  value: unknown,
  step: Record<string, unknown>,
): value is WorkflowStepResult {
  if (!isPlainRecord(value)) return false;
  if (hasAccessorProperty(value)) return false;
  const { events: _events, replayed: _replayed, ...durableValue } = value;
  return (
    isJsonSafe(durableValue, new Set(), true) &&
    value.status === "completed" &&
    value.id === step.id &&
    value.agentName === step.agentName &&
    typeof value.output === "string" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts === step.attempts &&
    isFiniteNumber(value.startedAt) &&
    isFiniteNumber(value.completedAt) &&
    value.completedAt >= value.startedAt &&
    (value.replayed === undefined || typeof value.replayed === "boolean") &&
    (value.events === undefined || Array.isArray(value.events)) &&
    isWorkflowContent(value.content) &&
    (value.stateDelta === undefined ||
      (isPlainRecord(value.stateDelta) && isJsonSafe(value.stateDelta))) &&
    (value.usage === undefined || isWorkflowStepUsage(value.usage))
  );
}

const WORKFLOW_STEP_USAGE_FIELDS = [
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "cachedTokens",
  "toolCalls",
  "llmCalls",
] as const satisfies readonly (keyof WorkflowStepUsage)[];

/**
 * Whether a stored value is a {@link WorkflowStepUsage}: every field present
 * and a finite, non-negative number. Results saved before usage existed carry
 * no `usage` and are accepted by the caller.
 */
function isWorkflowStepUsage(value: unknown): value is WorkflowStepUsage {
  return (
    isPlainRecord(value) &&
    WORKFLOW_STEP_USAGE_FIELDS.every((field) => {
      const count = value[field];
      return isFiniteNumber(count) && count >= 0;
    })
  );
}

function isSerializedError(value: unknown): value is WorkflowSerializedError {
  return (
    isPlainRecord(value) &&
    !hasAccessorProperty(value) &&
    isJsonSafe(value) &&
    isWorkflowErrorCode(value.code) &&
    isNonEmptyString(value.message) &&
    (value.details === undefined ||
      (isPlainRecord(value.details) && isJsonSafe(value.details)))
  );
}

/** A `Record` keyed by the union stays exhaustive when a code is added. */
const WORKFLOW_ERROR_CODES: Readonly<Record<WorkflowErrorCode, true>> = {
  WORKFLOW_ABORTED: true,
  WORKFLOW_ATTEMPT_MISMATCH: true,
  WORKFLOW_DEFINITION_INVALID: true,
  WORKFLOW_DEFINITION_NOT_FOUND: true,
  WORKFLOW_EXECUTION_ERROR: true,
  WORKFLOW_INDETERMINATE_STEP: true,
  WORKFLOW_INPUT_MISMATCH: true,
  WORKFLOW_LIMIT_EXCEEDED: true,
  WORKFLOW_SANDBOX_UNAVAILABLE: true,
  WORKFLOW_SCRIPT_INVALID: true,
  WORKFLOW_SOURCE_MISMATCH: true,
  WORKFLOW_STEP_INTERRUPTED: true,
  WORKFLOW_STEP_MISMATCH: true,
  WORKFLOW_UNKNOWN_AGENT: true,
  WORKFLOW_VERSION_MISMATCH: true,
  WORKFLOW_WORKSPACE_LEASE_LOST: true,
  WORKFLOW_WORKSPACE_STATE_INCOMPATIBLE: true,
};

function isWorkflowErrorCode(value: unknown): value is WorkflowErrorCode {
  return (
    typeof value === "string" && Object.hasOwn(WORKFLOW_ERROR_CODES, value)
  );
}

function isWorkflowOutput(value: unknown): boolean {
  return value === undefined || isJsonSafe(value, new Set(), true);
}

function isWorkflowContent(value: unknown): boolean {
  return value === undefined || isContent(value);
}

function isContent(value: unknown): value is Content {
  return (
    isPlainRecord(value) &&
    !hasAccessorProperty(value) &&
    Array.isArray(value.parts) &&
    isJsonSafe(value, new Set(), true)
  );
}

function isJsonSafe(
  value: unknown,
  seen = new Set<object>(),
  allowUndefinedProperties = false,
): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && !isPlainRecord(value)) return false;

  seen.add(value);
  let safe: boolean;
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const toJSON = descriptors.toJSON;
    if (
      hasAccessorProperty(value) ||
      (toJSON && typeof toJSON.value === "function")
    ) {
      seen.delete(value);
      return false;
    }
    safe = true;
    for (let index = 0; index < value.length; index++) {
      if (
        !Object.hasOwn(value, index) ||
        !isJsonSafe(value[index], seen, allowUndefinedProperties)
      ) {
        safe = false;
        break;
      }
    }
  } else {
    if (hasAccessorProperty(value)) {
      seen.delete(value);
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const toJSON = descriptors.toJSON;
    if (toJSON && (toJSON.get || typeof toJSON.value === "function")) {
      seen.delete(value);
      return false;
    }
    safe = Object.values(descriptors).every(
      (descriptor) =>
        !descriptor.enumerable ||
        (descriptor.value === undefined
          ? allowUndefinedProperties
          : isJsonSafe(descriptor.value, seen, allowUndefinedProperties)),
    );
  }
  seen.delete(value);
  return safe;
}

function hasAccessorProperty(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).some(
    (descriptor) =>
      descriptor.get !== undefined || descriptor.set !== undefined,
  );
}

function isCheckpointStatus(value: unknown): value is WorkflowCheckpointStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
