/**
 * Isolation shared by the two Claude drivers (Agent SDK and CLI): which
 * built-in tools the agent gets, how host configuration is kept out, the
 * no-network sandbox for shell commands, and the fail-closed check of what the
 * runtime reports in `system/init`. Internal: not re-exported from a barrel
 * except `DEFAULT_CLAUDE_TOOLS` through the SDK driver.
 */

import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { BRIDGE_TOOL_PREFIX } from "../tools/adk-tool-bridge.js";
import {
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { asRecord, stringValue } from "./shared.js";

/**
 * Built-in Claude Code tools an isolated agent gets by default: file reading
 * and editing, search, shell, notebooks, web and the to-do list. Host-level
 * tools of the `claude_code` preset (sub-agents, cron, worktrees, workflows,
 * tool search, messaging, plan mode...) are left out, so the agent only sees
 * what the bridge configures.
 */
export const DEFAULT_CLAUDE_TOOLS: readonly string[] = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
]);

/** Tools that write files or run commands; removed under `read-only`. */
const CLAUDE_WRITE_TOOLS: readonly string[] = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
  "PowerShell",
];

/** Tools that reach the network on their own. */
const CLAUDE_NETWORK_TOOLS: readonly string[] = ["WebFetch", "WebSearch"];

/** Tools that run shell commands. */
const CLAUDE_SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

export {
  BRIDGE_MCP_SERVER,
  BRIDGE_TOOL_PREFIX,
} from "../tools/adk-tool-bridge.js";

/**
 * Claude Code sandbox for shell commands with no network. Every host is
 * denied (`strictAllowlist` with an empty allowlist), commands cannot opt out
 * (`allowUnsandboxedCommands: false`), and the run fails at start when the
 * sandbox cannot run on this machine (`failIfUnavailable`) instead of running
 * commands unsandboxed. `autoAllowBashIfSandboxed: false` keeps the
 * confirmation of an `ask` policy.
 */
export const CLAUDE_NO_NETWORK_SANDBOX = Object.freeze({
  enabled: true,
  failIfUnavailable: true,
  autoAllowBashIfSandboxed: false,
  allowUnsandboxedCommands: false,
  network: Object.freeze({
    allowedDomains: Object.freeze([]) as readonly string[],
    strictAllowlist: true,
    allowLocalBinding: false,
    allowAllUnixSockets: false,
  }),
});

/** Shape of {@link CLAUDE_NO_NETWORK_SANDBOX}. */
export type ClaudeNoNetworkSandbox = typeof CLAUDE_NO_NETWORK_SANDBOX;

/** Driver settings that {@link planClaudeIsolation} reads. */
export interface ClaudeIsolationOptions {
  /** Configured built-in tools; `undefined` uses {@link DEFAULT_CLAUDE_TOOLS}. */
  tools?: readonly string[];
  /** Opt-in: keep the host's Claude Code configuration (tools, MCP, skills). */
  inheritHostConfig: boolean;
  /**
   * Opt-in: without `allowNetwork: true`, run shell commands without the
   * no-network sandbox. Network access of shell commands is then NOT enforced.
   */
  allowUnsandboxedShell: boolean;
}

/** What a Claude driver passes to the runtime; see {@link planClaudeIsolation}. */
export interface ClaudeIsolationPlan {
  /** True unless `inheritHostConfig` is set. */
  isolated: boolean;
  /**
   * Deny MCP tools other than the bridge's own: always when isolated, and
   * under `read-only` even with `inheritHostConfig`, because a tool the host
   * pre-approves would otherwise run without a prompt.
   */
  denyForeignMcpTools: boolean;
  /** Built-in tools to pass; `undefined` keeps the runtime default. */
  tools: string[] | undefined;
  /** Tools removed by the policy (read-only, no network). */
  disallowedTools: string[] | undefined;
  /** The no-network sandbox, when the policy needs it. */
  sandbox: ClaudeNoNetworkSandbox | undefined;
  /**
   * How shell commands are kept off the network, reported to the permission
   * guard: `enforced` (sandbox on), `waived` (the opt-in), or `undefined`
   * (the policy does not restrict the network, or no shell tool is offered).
   */
  networkSandbox: "enforced" | "waived" | undefined;
}

/**
 * What a Claude agent can reach under `policy`.
 *
 * - Isolated (default): an explicit tool list, no host MCP servers, skills,
 *   settings files or claude.ai connectors.
 * - `read-only` removes the write and shell tools; web tools are removed
 *   unless the policy sets `allowNetwork: true` (an unset value, or no
 *   policy, counts as `false`).
 * - Without `allowNetwork: true`, a shell tool on offer turns on the
 *   no-network sandbox, unless `allowUnsandboxedShell` is set.
 *
 * @remarks Network is off unless the policy sets `allowNetwork: true`: an
 * unset value, or no policy, removes the web tools and runs Bash in the
 * no-network sandbox, as `false` does.
 * @param policy - The effective permission policy of the run.
 * @param options - The driver's tool and opt-in settings.
 * @returns The tools, removals, sandbox and guard marker to apply.
 */
export function planClaudeIsolation(
  policy: ExternalAgentPermissionPolicy | undefined,
  options: ClaudeIsolationOptions,
): ClaudeIsolationPlan {
  const removed = new Set<string>();
  if (policy?.mode === "read-only") {
    for (const name of CLAUDE_WRITE_TOOLS) removed.add(name);
  }
  if (!networkAllowed(policy)) {
    for (const name of CLAUDE_NETWORK_TOOLS) removed.add(name);
  }
  const base =
    options.tools ??
    (options.inheritHostConfig ? undefined : DEFAULT_CLAUDE_TOOLS);
  const tools = base?.filter((name) => !removed.has(name));
  // Without a pinned list the runtime default applies, which has a shell.
  const shellOffered =
    tools === undefined
      ? !removed.has("Bash")
      : tools.some((name) => CLAUDE_SHELL_TOOLS.has(name));

  let sandbox: ClaudeNoNetworkSandbox | undefined;
  let networkSandbox: ClaudeIsolationPlan["networkSandbox"];
  if (!networkAllowed(policy) && shellOffered) {
    if (options.allowUnsandboxedShell) {
      networkSandbox = "waived";
    } else {
      sandbox = CLAUDE_NO_NETWORK_SANDBOX;
      networkSandbox = "enforced";
    }
  }

  return {
    isolated: !options.inheritHostConfig,
    denyForeignMcpTools:
      !options.inheritHostConfig || policy?.mode === "read-only",
    tools,
    disallowedTools: removed.size > 0 ? [...removed] : undefined,
    sandbox,
    networkSandbox,
  };
}

/** What an isolated run may report in `system/init`. */
export interface ClaudeIsolationExpectation {
  /** Built-in tools the driver configured. */
  tools: readonly string[];
  /** MCP servers the driver configured (the bridge's own, required ones). */
  mcpServers: readonly string[];
  /**
   * The full names (`mcp__adk_bridge__<tool>`) of the tools the bridge's own
   * server registered. When set, a bridge-prefixed tool is expected only if
   * it is in this list: a host server named `adk_bridge__x` would otherwise
   * pass as the bridge. When unset, any tool with the bridge prefix counts
   * as the bridge's.
   */
  bridgeTools?: readonly string[];
}

/**
 * The tools and MCP servers in a `system/init` message that are outside
 * `expected`. Returns `undefined` for any other message.
 *
 * Extras are violations; a missing expected tool is not (CLI builds add or
 * omit tools, e.g. TodoWrite). The tools of an expected MCP server
 * (`mcp__<server>__*`) are expected with it.
 *
 * @param message - One runtime message, any type.
 * @param expected - The tools and MCP servers the driver configured.
 * @returns The unexpected tools and servers (both empty when isolated), or
 * `undefined` when `message` is not `system/init`.
 */
export function findIsolationViolations(
  message: unknown,
  expected: ClaudeIsolationExpectation,
): { tools: string[]; mcpServers: string[] } | undefined {
  const record = asRecord(message);
  if (record.type !== "system" || record.subtype !== "init") {
    return undefined;
  }
  const allowedServers = new Set(expected.mcpServers);
  const tools = Array.isArray(record.tools)
    ? record.tools
        .map((tool) => stringValue(tool) ?? stringValue(asRecord(tool).name))
        .filter((name): name is string => typeof name === "string")
        .filter((name) => !isExpectedClaudeTool(name, expected))
    : [];
  const mcpServers = Array.isArray(record.mcp_servers)
    ? record.mcp_servers
        .map(
          (server) => stringValue(asRecord(server).name) ?? stringValue(server),
        )
        .filter((name): name is string => typeof name === "string")
        .filter((name) => !allowedServers.has(name))
    : [];
  return { tools, mcpServers };
}

/**
 * Whether an isolated run may use the tool `name`: a configured built-in
 * tool, or a tool of an expected MCP server (`mcp__<server>__<tool>`).
 *
 * @remarks Claude Code writes a server name into tool names with every
 * character outside `[A-Za-z0-9_-]` replaced by `_`, so both spellings match.
 * The bridge's own tools are matched by exact name when
 * {@link ClaudeIsolationExpectation.bridgeTools} is set.
 * @param name - The tool name as the runtime reports it.
 * @param expected - The tools and MCP servers the driver configured.
 * @returns True when the tool is inside the isolated set.
 */
export function isExpectedClaudeTool(
  name: string,
  expected: ClaudeIsolationExpectation,
): boolean {
  if (expected.tools.includes(name)) {
    return true;
  }
  if (!name.startsWith("mcp__")) {
    return false;
  }
  if (expected.bridgeTools && name.startsWith(BRIDGE_TOOL_PREFIX)) {
    return expected.bridgeTools.includes(name);
  }
  return expected.mcpServers.some((server) => {
    const prefixes = new Set([
      `mcp__${server}__`,
      `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`,
    ]);
    return [...prefixes].some((prefix) => name.startsWith(prefix));
  });
}

/**
 * The `tool_use` names in an assistant message that are outside `expected`.
 *
 * @param message - One runtime message, any type.
 * @param expected - The tools and MCP servers the driver configured.
 * @returns The unexpected tool names; empty for any other message.
 */
export function findToolUseViolations(
  message: unknown,
  expected: ClaudeIsolationExpectation,
): string[] {
  const record = asRecord(message);
  if (record.type !== "assistant") {
    return [];
  }
  const content = asRecord(record.message).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .map(asRecord)
    .filter((block) => block.type === "tool_use")
    .map((block) => stringValue(block.name))
    .filter((name): name is string => typeof name === "string")
    .filter((name) => !isExpectedClaudeTool(name, expected));
}

/**
 * Throws when one runtime message shows something outside the isolated set:
 * a `system/init` listing (see {@link assertClaudeInitIsolated}) or an
 * assistant `tool_use` of a tool outside `expected`.
 *
 * @remarks claude.ai connectors and some MCP servers connect after `init`,
 * so the init listing alone can miss them. Checking each tool the model is
 * about to use closes that gap.
 * @param message - One runtime message, any type.
 * @param expected - The tools and MCP servers the driver configured.
 * @param runtime - Runtime name used in the error message.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_ISOLATION_VIOLATED` when something outside `expected`
 * appears.
 */
export function assertClaudeMessageIsolated(
  message: unknown,
  expected: ClaudeIsolationExpectation,
  runtime: string,
): void {
  assertClaudeInitIsolated(message, expected, runtime);
  const tools = findToolUseViolations(message, expected);
  if (tools.length > 0) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_ISOLATION_VIOLATED,
      `${runtime} tried to use ${tools.join(", ")}, outside the isolated set, so the run was stopped. A host or managed setting may be adding tools after start. Pass inheritHostConfig: true to allow the host configuration.`,
    );
  }
}

/**
 * Throws {@link ExternalAgentPolicyError} with
 * `EXTERNAL_AGENT_ISOLATION_VIOLATED` when a `system/init` message reports
 * tools or MCP servers outside `expected`. Other messages pass.
 *
 * @remarks A host admin or managed policy tier can override the flags that
 * keep connectors and host tools out, so the driver checks what the runtime
 * actually loaded instead of trusting the flags.
 * @param message - One runtime message, any type.
 * @param expected - The tools and MCP servers the driver configured.
 * @param runtime - Runtime name used in the error message.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_ISOLATION_VIOLATED` when something outside `expected`
 * appears.
 */
export function assertClaudeInitIsolated(
  message: unknown,
  expected: ClaudeIsolationExpectation,
  runtime: string,
): void {
  const violations = findIsolationViolations(message, expected);
  if (
    !violations ||
    (violations.tools.length === 0 && violations.mcpServers.length === 0)
  ) {
    return;
  }
  const parts = [
    violations.tools.length > 0
      ? `tools: ${violations.tools.join(", ")}`
      : undefined,
    violations.mcpServers.length > 0
      ? `MCP servers: ${violations.mcpServers.join(", ")}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  throw new ExternalAgentPolicyError(
    EXTERNAL_AGENT_ISOLATION_VIOLATED,
    `${runtime} reported ${parts.join("; ")} outside the isolated set, so the run was stopped. A host or managed setting may be adding them. Pass inheritHostConfig: true to allow the host configuration.`,
  );
}

/**
 * CLI flags for `plan`. Each flag uses the `--flag=value` form so a
 * variadic option cannot swallow the next argument. All of them are listed by
 * `claude --help` (2.1.319): `--tools`, `--disallowedTools`,
 * `--strict-mcp-config`, `--setting-sources`, `--disable-slash-commands`,
 * `--settings`.
 *
 * @param plan - The plan from {@link planClaudeIsolation}.
 * @returns Flags to append after the permission flags; empty when nothing
 * is pinned.
 */
export function claudeCliIsolationArgs(plan: ClaudeIsolationPlan): string[] {
  const args: string[] = [];
  if (plan.tools !== undefined) {
    args.push(`--tools=${plan.tools.join(",")}`);
  }
  if (plan.disallowedTools) {
    args.push(`--disallowedTools=${plan.disallowedTools.join(",")}`);
  }
  const settings: Record<string, unknown> = {};
  if (plan.isolated) {
    // No --mcp-config is passed, so strict mode means no MCP servers at all.
    args.push(
      "--strict-mcp-config",
      "--setting-sources=",
      "--disable-slash-commands",
    );
    settings.disableClaudeAiConnectors = true;
  }
  if (plan.denyForeignMcpTools) {
    // The CLI has no MCP server of its own, so every MCP tool is foreign: a
    // connector or host server (including one that connects late or that host
    // settings pre-approve) is denied before it runs, in every permission
    // mode. `mcp__*` is the CLI's rule for "all MCP servers' tools" (checked
    // on 2.1.319, bypassPermissions included: the tools leave the init list).
    settings.permissions = { deny: ["mcp__*"] };
  }
  if (plan.sandbox) {
    settings.sandbox = plan.sandbox;
  }
  if (Object.keys(settings).length > 0) {
    args.push(`--settings=${JSON.stringify(settings)}`);
  }
  return args;
}
