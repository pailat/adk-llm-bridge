/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type BaseAgentConfig,
  InvocationContext,
  type NodeContext,
} from "@google/adk";

/**
 * ADK workflow-node settings accepted by workflow agents.
 *
 * They only take effect when the agent runs as a node of an ADK `Workflow`
 * (or through `ctx.runNode`); as the Runner's root agent they are ignored.
 * A node `timeout` (seconds) cancels the run by closing the event stream, which
 * aborts the underlying workflow runtime. A node `retryConfig` re-enters the
 * same execution (same invocation id): completed steps replay and steps whose
 * last attempt failed run again (see `retryFailedSteps`). `rerunOnResume`
 * defaults to `true` here (ADK's default is `false`) because a step waiting for
 * input is resumed by re-entering the workflow.
 */
export type WorkflowNodeConfig = Pick<
  BaseAgentConfig,
  | "timeout"
  | "retryConfig"
  | "rerunOnResume"
  | "inputSchema"
  | "outputSchema"
  | "stateSchema"
  | "isolationScope"
> & {
  /**
   * Re-execute steps whose last attempt failed when the execution is entered
   * again. Defaults to `true` when `retryConfig` is set, otherwise `false`
   * (a failed step then requires `resumePolicy: "retry"`). Steps left
   * `running` by a crash stay `WORKFLOW_INDETERMINATE_STEP` either way.
   */
  retryFailedSteps?: boolean;
};

/** Picks the node settings to forward to the `BaseAgent` constructor. */
export function pickWorkflowNodeConfig(
  config: WorkflowNodeConfig,
): Omit<WorkflowNodeConfig, "retryFailedSteps"> {
  const {
    timeout,
    retryConfig,
    rerunOnResume,
    inputSchema,
    outputSchema,
    stateSchema,
    isolationScope,
  } = config;
  return {
    timeout,
    retryConfig,
    // The agent resumes its own waiting steps, so ADK must re-enter it on
    // resume instead of treating the reply as the node's output.
    rerunOnResume: rerunOnResume ?? true,
    inputSchema,
    outputSchema,
    stateSchema,
    isolationScope,
  };
}

/** Whether re-entering an execution re-runs steps whose last attempt failed. */
export function resolveRetryFailedSteps(
  config: Pick<WorkflowNodeConfig, "retryConfig" | "retryFailedSteps">,
): boolean {
  return config.retryFailedSteps ?? config.retryConfig !== undefined;
}

/**
 * Invocation context to run a workflow agent with when ADK drives it as a node.
 *
 * ADK enforces a node `timeout` (and aborts siblings) through
 * `NodeContext.abortSignal`, which is not part of the agent's invocation
 * context. Without merging it in, the workflow runtime keeps running after the
 * node timed out, and an ADK retry would overlap with it.
 */
export function invocationContextForNode(ctx: NodeContext): InvocationContext {
  const base = ctx.getInvocationContext();
  const nodeSignal = ctx.abortSignal;
  if (!nodeSignal || nodeSignal === base.abortSignal) return base;
  return new InvocationContext({
    ...base,
    abortSignal: base.abortSignal
      ? AbortSignal.any([base.abortSignal, nodeSignal])
      : nodeSignal,
  });
}
