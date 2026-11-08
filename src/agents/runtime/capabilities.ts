/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

export interface AgentRuntimeCapabilities {
  /**
   * The driver hosts ADK tools (`ExternalAgentConfig.tools`) for the runtime.
   * This is about tools provided by the host, not the runtime's own built-in
   * tools (every runtime has those).
   */
  tools?: boolean;
  /** The driver exposes ADK sub-agents (`subAgents`) to the runtime. */
  subagents?: boolean;
  /** The driver can attach MCP servers to the runtime. */
  mcpServers?: boolean;
  /**
   * The driver can route the runtime's permission prompts to the host
   * (`ExternalAgentConfig.confirmation`). Without it, `ask` is enforced by the
   * runtime alone and the host's approver is never consulted.
   */
  approvals?: boolean;
  streaming?: boolean;
  sessions?: boolean;
  permissions?: boolean;
}
