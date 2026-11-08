/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { BaseAgentConfig } from "@google/adk";

/**
 * ADK workflow-node settings accepted by workflow agents.
 *
 * They only take effect when the agent runs as a node of an ADK `Workflow`
 * (or through `ctx.runNode`); as the Runner's root agent they are ignored.
 * A node `timeout` (seconds) cancels the run by closing the event stream, which
 * aborts the underlying workflow runtime.
 */
export type WorkflowNodeConfig = Pick<
  BaseAgentConfig,
  "timeout" | "inputSchema" | "outputSchema" | "stateSchema" | "isolationScope"
>;

/** Picks the node settings to forward to the `BaseAgent` constructor. */
export function pickWorkflowNodeConfig(
  config: WorkflowNodeConfig,
): WorkflowNodeConfig {
  const { timeout, inputSchema, outputSchema, stateSchema, isolationScope } =
    config;
  return { timeout, inputSchema, outputSchema, stateSchema, isolationScope };
}
