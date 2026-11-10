import {
  type BaseAgent,
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
 * input is resumed by re-entering the workflow. `waitForOutput` (ADK's join
 * semantics: wait until every predecessor that could trigger the node has
 * finished) is forwarded as is.
 *
 * The agent fields of ADK's `BaseAgentConfig` are accepted too and behave as
 * in any ADK agent: `beforeAgentCallback` and `afterAgentCallback` run around
 * the whole workflow (a before callback that returns content skips it), and
 * `parentAgent` is the agent's parent (normally set by the parent agent that
 * lists it in `subAgents`).
 */
export type WorkflowNodeConfig = Pick<
  BaseAgentConfig,
  | "timeout"
  | "retryConfig"
  | "rerunOnResume"
  | "waitForOutput"
  | "inputSchema"
  | "outputSchema"
  | "stateSchema"
  | "isolationScope"
  | "beforeAgentCallback"
  | "afterAgentCallback"
  | "parentAgent"
> & {
  /**
   * Re-execute steps whose last attempt failed or was interrupted when the
   * execution is entered again.
   *
   * @remarks
   * A step that threw is otherwise replayed as its recorded failure (it runs
   * again only with `resumePolicy: "retry"`). A step stopped by an abort or a
   * timeout (closed run, node `timeout`, run timeout) is recorded
   * `interrupted`, not failed: with this option, or when the step declares
   * `resumePolicy: "retry"`, it runs again as the next attempt. Otherwise,
   * and on a turn that answers a waiting step, the resume fails with
   * `WORKFLOW_INDETERMINATE_STEP`. A step left `running` by a crash stays
   * indeterminate unless it declares `resumePolicy: "retry"`.
   *
   * @defaultValue `true` when `retryConfig` is set, otherwise `false`.
   */
  retryFailedSteps?: boolean;
};

/**
 * Builds the config a workflow agent passes to the `BaseAgent` constructor.
 *
 * @remarks
 * The whole config is forwarded, not only the fields ADK reads: `BaseAgent`
 * stores it, and `clone()` rebuilds the agent by calling the concrete
 * constructor with that stored config, so the definition and every adapter
 * must be in it.
 *
 * @param config - The workflow agent's config.
 * @param defaults - The `description` to use when the config has none.
 * @returns The config for `super()`.
 * @internal
 */
export function workflowAgentBaseConfig<
  T extends WorkflowNodeConfig & {
    name: string;
    description?: string;
    subAgents?: BaseAgent[];
  },
>(config: T, defaults: { description?: string }): T {
  return {
    ...config,
    description: config.description ?? defaults.description,
    subAgents: config.subAgents ?? [],
    // The agent resumes its own waiting steps, so ADK must re-enter it on
    // resume instead of treating the reply as the node's output.
    rerunOnResume: config.rerunOnResume ?? true,
  };
}

/**
 * Whether re-entering an execution re-runs steps whose last attempt failed.
 *
 * @internal
 */
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
 *
 * @internal
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
