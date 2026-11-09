/**
 * How much an external agent may do without asking.
 *
 * @remarks
 * Ordered from most to least restrictive: `read-only` (nothing is writable and
 * no confirmation can change that; with `allowNetwork: true` its web tools
 * run without an approver, so it can still send what it reads to the
 * network), `ask` (every sensitive call needs an
 * approval), `workspace-write` (writes inside the workspace are allowed) and
 * `full-access` (no restriction from the bridge).
 */
export type ExternalAgentPermissionMode =
  | "read-only"
  | "ask"
  | "workspace-write"
  | "full-access";

/**
 * Permission policy of an external agent.
 *
 * @remarks
 * A delegated sub-agent never gets a broader policy than its parent; see
 * {@link deriveSubAgentPermissionPolicy}.
 */
export interface ExternalAgentPermissionPolicy {
  /** Permission mode. */
  mode: ExternalAgentPermissionMode;
  /**
   * Whether the agent may reach the network.
   *
   * @remarks
   * Network is off unless this is `true`: an unset value counts as `false`.
   * Without `true`, web tools, non-bridge MCP tools and unsandboxed shell
   * calls are denied, and drivers that cannot keep the network off refuse
   * the run.
   *
   * Under `read-only`, `true` lets the web tools run without an approver.
   * Read-only does not stop data leaving: the agent can send what it reads
   * (file contents, workspace secrets) to any host through them, for example
   * after a prompt injection. Set it only for agents whose inputs you trust,
   * or use `ask` mode so web calls go to an approver.
   *
   * @defaultValue `false`
   */
  allowNetwork?: boolean;
  /**
   * Roots the agent may touch. When set, any path argument of a tool call
   * outside these roots is denied. When unset, paths are not restricted.
   *
   * @remarks
   * `ClaudeAgentSdkDriver` checks every tool call against them. The Claude
   * CLI, Codex and Gemini CLI drivers run file tools without asking the
   * bridge, so they refuse a run with `allowedPaths` (or inherited
   * `pathBounds`) with `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless built with
   * `allowUnenforcedPaths: true`.
   */
  allowedPaths?: readonly string[];
  /**
   * Root lists every path must also stay inside: a path is allowed only when
   * it is under one root of each list, as well as under `allowedPaths`.
   *
   * @remarks
   * {@link deriveSubAgentPermissionPolicy} sets it to the parent's and the
   * child's absolute roots, so a symlink created or retargeted after the
   * policy was derived cannot take a kept root outside the parent's roots.
   * The guard resolves both the bounds and the request path when a request
   * arrives. It can only narrow a policy; an empty list allows no path.
   */
  pathBounds?: readonly (readonly string[])[];
}

/**
 * Provider-neutral flags derived from a policy, ready to be translated into
 * each runtime's own options.
 */
export interface ProviderPermissionFlags {
  /** The runtime must not write anything. */
  readOnly?: boolean;
  /** Each sensitive call needs an approval. */
  requireApproval?: boolean;
  /** Writes inside the workspace are allowed. */
  workspaceWrite?: boolean;
  /** No restriction from the bridge. */
  fullAccess?: boolean;
  /** Network access: `true` only for `allowNetwork: true`. */
  network?: boolean;
  /** Allowed roots, copied from `allowedPaths`. */
  paths?: readonly string[];
}
