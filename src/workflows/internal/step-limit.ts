import {
  DEFAULT_WORKFLOW_EXECUTION_LIMITS,
  WorkflowError,
  type WorkflowExecutionLimits,
} from "../contracts.js";

/**
 * How many times `maxSteps` bounds the replayed steps of one turn when
 * `maxReplayedSteps` is not set.
 *
 * @internal
 */
export const REPLAYED_STEPS_PER_STEP = 10;

/**
 * The two step bounds of one workflow turn.
 *
 * @internal
 */
export interface StepLimits {
  /** Steps whose agent the turn may execute. */
  maxSteps: number;
  /** Steps the turn may replay without executing their agent. */
  maxReplayedSteps: number;
}

/**
 * Resolves `maxReplayedSteps`, which defaults to
 * {@link REPLAYED_STEPS_PER_STEP} times the effective `maxSteps`.
 *
 * @remarks
 * Validation of the values is left to the caller.
 *
 * @internal
 */
export function resolveStepLimits(
  limits: WorkflowExecutionLimits | undefined,
): StepLimits {
  const maxSteps =
    limits?.maxSteps ?? DEFAULT_WORKFLOW_EXECUTION_LIMITS.maxSteps;
  return {
    maxSteps,
    maxReplayedSteps:
      limits?.maxReplayedSteps ?? maxSteps * REPLAYED_STEPS_PER_STEP,
  };
}

/**
 * Counts the executed and replayed steps of one workflow turn against
 * {@link StepLimits}.
 *
 * @remarks
 * Shared by the trusted runtime and the sandboxed script runner so both apply
 * the same rule and report it the same way. A step counts as executed when its
 * agent may run in this turn (a new or retried step, a waiting step that
 * continues with an answer, or a step a `beforeStep` / `beforeAttempt` hook
 * then answers), and as replayed when its result or recorded failure comes
 * from the checkpoint.
 *
 * @internal
 */
export class StepBudget {
  #executed = 0;
  #replayed = 0;

  constructor(readonly limits: StepLimits) {}

  /** Steps counted as executed so far. */
  get executed(): number {
    return this.#executed;
  }

  /** Steps counted as replayed so far. */
  get replayed(): number {
    return this.#replayed;
  }

  /**
   * Counts one executed step.
   *
   * @throws {@link WorkflowError} with code `WORKFLOW_LIMIT_EXCEEDED` when it passes `maxSteps`; nothing is counted then.
   */
  takeExecuted(stepId: string): void {
    if (this.#executed >= this.limits.maxSteps) {
      throw this.exceeded("maxSteps", stepId);
    }
    this.#executed++;
  }

  /**
   * Counts one replayed step.
   *
   * @throws {@link WorkflowError} with code `WORKFLOW_LIMIT_EXCEEDED` when it passes `maxReplayedSteps`; nothing is counted then.
   */
  takeReplayed(stepId: string): void {
    if (this.#replayed >= this.limits.maxReplayedSteps) {
      throw this.exceeded("maxReplayedSteps", stepId);
    }
    this.#replayed++;
  }

  /** The limit error for `limitName`, with both counters and both bounds. */
  exceeded(limitName: keyof StepLimits, stepId: string): WorkflowError {
    const limit = this.limits[limitName];
    const kind = limitName === "maxSteps" ? "executed" : "replayed";
    return new WorkflowError(
      "WORKFLOW_LIMIT_EXCEEDED",
      `Workflow exceeded ${limitName} (${limit} ${kind} steps in one turn); raise limits.${limitName} and resume the same execution id to continue`,
      {
        limit,
        limitName,
        stepId,
        executedSteps: this.#executed,
        replayedSteps: this.#replayed,
        maxSteps: this.limits.maxSteps,
        maxReplayedSteps: this.limits.maxReplayedSteps,
      },
    );
  }
}
