import { WorkflowError } from "../contracts.js";

/**
 * Error for a run that passes `limits.maxSteps`, shared by the trusted runtime
 * and the sandboxed script runner so both report it the same way.
 *
 * @remarks
 * Replayed steps count toward the limit, so the message tells the caller to
 * raise it when the run is resumed.
 *
 * @internal
 */
export function stepLimitExceeded(
  limit: number,
  stepId: string,
  replayedSteps: number,
): WorkflowError {
  return new WorkflowError(
    "WORKFLOW_LIMIT_EXCEEDED",
    `Workflow exceeded the maximum of ${limit} steps; steps replayed from the checkpoint on a resume count too, so raise limits.maxSteps to resume this run`,
    { limit, stepId, replayedSteps },
  );
}
