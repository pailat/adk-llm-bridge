/**
 * Features an external runtime driver supports.
 *
 * @remarks
 * A capability that is `false` or absent means the driver does not provide
 * it. The flags describe the driver to callers through
 * `driver.capabilities()`, the only place they are declared. `tools` and
 * `approvals` are also checked when an `ExternalAgent` is built: tools, an
 * approver or ADK confirmation on a driver that implements `capabilities()`
 * without the flag are refused. Nothing else is gated on them at runtime.
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
   * runtime alone and the host's approver is never consulted, so an agent
   * built with an approver or ADK confirmation on such a driver is refused
   * (`EXTERNAL_AGENT_APPROVALS_UNSUPPORTED`). Set it only when the driver
   * calls `request.requestPermission`.
   */
  approvals?: boolean;
  /** The driver emits partial output (token or chunk deltas) while the run is in progress. */
  streaming?: boolean;
  /** The driver can resume a runtime session across turns. */
  sessions?: boolean;
  /** The driver maps the effective permission policy onto the runtime's own controls. */
  permissions?: boolean;
}
