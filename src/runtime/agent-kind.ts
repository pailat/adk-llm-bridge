import {
  type BaseAgent,
  isLlmAgent,
  isLoopAgent,
  isParallelAgent,
  isSequentialAgent,
  isWorkflow,
} from "@google/adk";
import { hasExternalAgentBrand } from "../agents/internal/external-agent-brand.js";
import type { WorkflowAgentKind } from "../workflows/events.js";
import { isWorkflowAgent } from "../workflows/internal/workflow-agent-brand.js";

/** What kind of agent runs a workflow step. See {@link WorkflowAgentKind}. */
export type AgentKind = WorkflowAgentKind;

/** Span attribute that carries the {@link AgentKind} of the agent that ran. */
export const AGENT_KIND_ATTRIBUTE = "gcp.vertex.agent.agent_kind";

/**
 * The {@link AgentKind} of `agent`, derived without running it.
 *
 * @remarks
 * Every check is a brand or a Symbol-keyed ADK signature, never `instanceof`,
 * so an agent built by another copy of this package or of ADK is classified
 * like one from this copy. The order matters: the external brand wins, then
 * the workflow kinds, then `LlmAgent`; anything else is `host`.
 *
 * @param agent - The agent to classify.
 * @returns The agent's kind.
 * @internal
 */
export function describeAgentKind(agent: BaseAgent): AgentKind {
  if (hasExternalAgentBrand(agent)) return "external";
  if (
    isWorkflowAgent(agent) ||
    isWorkflow(agent) ||
    isSequentialAgent(agent) ||
    isParallelAgent(agent) ||
    isLoopAgent(agent)
  ) {
    return "workflow";
  }
  if (isLlmAgent(agent)) return "llm";
  return "host";
}
