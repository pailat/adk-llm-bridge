import type { BaseAgent } from "@google/adk";

/**
 * Brand carried by every agent that runs a workflow of its own
 * (`WorkflowAgent`, `ScriptWorkflowAgent` and their subclasses).
 *
 * @remarks
 * The runtime cannot import those classes: it would create an import cycle
 * and pull the sandbox runtime into every workflow. A symbol on the instance
 * answers the same question as `instanceof`, subclasses included.
 *
 * @internal
 */
export const WORKFLOW_AGENT_BRAND: unique symbol = Symbol.for(
  "adk-llm-bridge.workflow-agent",
);

/**
 * Whether `agent` runs a workflow of its own.
 *
 * @internal
 */
export function isWorkflowAgent(agent: BaseAgent | undefined): boolean {
  return (
    agent !== undefined &&
    (agent as unknown as Record<symbol, unknown>)[WORKFLOW_AGENT_BRAND] === true
  );
}
