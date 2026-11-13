/**
 * Isolation shared by the two Claude drivers (Agent SDK and CLI): which
 * built-in tools the agent gets, how host configuration is kept out, the
 * no-network sandbox for shell commands, and the fail-closed check of what the
 * runtime reports in `system/init`. Internal: not re-exported from a barrel
 * except `DEFAULT_CLAUDE_TOOLS` through the SDK driver.
 */

import { networkAllowed } from "../permissions/network.js";
import {
  canonicalPath,
  isUnderAny,
  policySetsPaths,
} from "../permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { BRIDGE_TOOL_PREFIX } from "../tools/adk-tool-bridge.js";
import {
  EXTERNAL_AGENT_ISOLATION_VIOLATED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { asRecord, sandboxTempRoots, stringValue } from "./shared.js";

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

/** Tools that read files by path. */
const CLAUDE_FILE_READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
]);

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
export type ClaudeNoNetworkSandbox = Omit<
  typeof CLAUDE_NO_NETWORK_SANDBOX,
  "network"
> & {
  readonly network: Omit<
    (typeof CLAUDE_NO_NETWORK_SANDBOX)["network"],
    "allowLocalBinding"
  > & { readonly allowLocalBinding: boolean };
};

/**
 * {@link CLAUDE_NO_NETWORK_SANDBOX} with loopback port binding allowed
 * (`network.allowLocalBinding: true`), for the `allowLocalBinding` opt-in.
 * Every remote host stays denied.
 */
export const CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX: ClaudeNoNetworkSandbox =
  Object.freeze({
    ...CLAUDE_NO_NETWORK_SANDBOX,
    network: Object.freeze({
      ...CLAUDE_NO_NETWORK_SANDBOX.network,
      allowLocalBinding: true,
    }),
  });

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
  /**
   * Opt-in: let sandboxed shell commands bind local (loopback) ports, for
   * tools that talk to their own workers over a local port (Turbopack, test
   * servers). Only applies while the no-network sandbox is on; macOS only
   * in Claude Code. Loopback services may become reachable.
   *
   * @defaultValue false
   */
  allowLocalBinding?: boolean;
  /**
   * The run's working directory, the base of relative `allowedPaths`.
   *
   * @defaultValue `process.cwd()`
   */
  workingDirectory?: string;
  /**
   * The environment the driver builds the runtime's environment from. Its
   * `TMPDIR` and `CLAUDE_CODE_TMPDIR` count as always-writable temp
   * directories, next to the host process's own.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
}

/** {@link CLAUDE_NO_NETWORK_SANDBOX} with its writable roots pinned. */
export type ClaudeConfinedSandbox = ClaudeNoNetworkSandbox & {
  readonly filesystem: { readonly allowWrite: readonly string[] };
};

/** What a Claude driver passes to the runtime; see {@link planClaudeIsolation}. */
export interface ClaudeIsolationPlan {
  /** True unless `inheritHostConfig` is set. */
  isolated: boolean;
  /**
   * Deny MCP tools other than the bridge's own: always when isolated, and
   * with `inheritHostConfig` under `read-only` or, in every mode, when the
   * policy does not set `allowNetwork: true`. A host MCP server runs outside the shell sandbox,
   * and a tool the host pre-approves would otherwise run without a prompt.
   */
  denyForeignMcpTools: boolean;
  /** Built-in tools to pass; `undefined` keeps the runtime default. */
  tools: string[] | undefined;
  /** Tools removed by the policy (read-only, no network). */
  disallowedTools: string[] | undefined;
  /**
   * The no-network sandbox, when the policy needs it. With `allowedPaths` or
   * `pathBounds` its writable roots are the allowed roots (plus the working
   * directory, which Claude Code always keeps writable and which then lies
   * inside them).
   */
  sandbox: ClaudeNoNetworkSandbox | ClaudeConfinedSandbox | undefined;
  /**
   * Why shell commands cannot be kept inside `allowedPaths` or `pathBounds`,
   * when they cannot; the driver then refuses the run with
   * `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`.
   */
  shellPathsUnenforceable: string | undefined;
  /**
   * How shell commands are kept off the network, reported to the permission
   * guard: `enforced` (sandbox on), `waived` (the opt-in), or `undefined`
   * (the policy does not restrict the network, or no shell tool is offered).
   */
  networkSandbox: "enforced" | "waived" | undefined;
  /**
   * Web tools that run without a prompt, by canonical name: the offered
   * `WebFetch` and `WebSearch` under `read-only` with `allowNetwork: true`.
   * `undefined` when there are none.
   */
  readOnlyWebTools: string[] | undefined;
  /**
   * Web tools named in the configured `tools` while the policy keeps the
   * network off, by canonical name. The driver then refuses the run with
   * `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` instead of dropping them; the
   * default tool list is trimmed without a refusal.
   */
  unenforceableWebTools: string[] | undefined;
  /** Whether a shell tool (`Bash`, `PowerShell`) is offered. */
  shellOffered: boolean;
  /**
   * Whether a file-read tool (`Read`, `Glob`, `Grep`, `LS`, `NotebookRead`)
   * is offered.
   */
  fileReadOffered: boolean;
}

/**
 * What a Claude agent can reach under `policy`.
 *
 * - Isolated (default): an explicit tool list, no host MCP servers, skills,
 *   settings files or claude.ai connectors.
 * - `read-only` removes the write and shell tools; web tools are removed
 *   unless the policy sets `allowNetwork: true` (an unset value, or no
 *   policy, counts as `false`). With it, the offered web tools run without a
 *   prompt (`readOnlyWebTools`).
 * - Web tools named in the configured `tools` while the network is off are
 *   reported in `unenforceableWebTools`, so the driver refuses the run.
 *   Built-in tool names are matched case-insensitively and passed on in
 *   their canonical spelling (`bash` becomes `Bash`), so a shell named in
 *   any case gets the sandbox.
 * - Without `allowNetwork: true`, a shell tool on offer turns on the
 *   no-network sandbox, unless `allowUnsandboxedShell` is set. It denies
 *   binding local ports too, unless `allowLocalBinding` is set.
 * - With `allowedPaths` or `pathBounds` and a shell tool on offer, the
 *   sandbox may write only to the allowed roots (it does not limit reads,
 *   and `readPaths` never become writable).
 *   A working directory outside the allowed roots (Claude Code keeps it
 *   writable), a shell without the sandbox (`allowNetwork: true` or
 *   `allowUnsandboxedShell`), `inheritHostConfig` (host settings widen the
 *   writable paths) and a working directory or allowed root in the
 *   always-writable temp area are reported in `shellPathsUnenforceable`.
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
  // Built-in names are passed on in their canonical spelling: Claude Code
  // matches them case-insensitively, so `bash` offers the shell, and the
  // checks below (shell, web, removals) must see it as `Bash`.
  const tools =
    base === undefined
      ? undefined
      : [
          ...new Set(base.map((name) => canonicalClaudeToolName(name) ?? name)),
        ].filter((name) => !removed.has(name));
  const webTools = (list: readonly string[] | undefined): string[] =>
    CLAUDE_NETWORK_TOOLS.filter(
      (tool) =>
        list === undefined ||
        list.some((name) => canonicalClaudeToolName(name) === tool),
    );
  const readOnlyWebTools =
    policy?.mode === "read-only" && networkAllowed(policy)
      ? webTools(tools)
      : [];
  const unenforceableWebTools =
    options.tools !== undefined && !networkAllowed(policy)
      ? webTools(options.tools)
      : [];
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
      sandbox = options.allowLocalBinding
        ? CLAUDE_NO_NETWORK_LOCAL_BINDING_SANDBOX
        : CLAUDE_NO_NETWORK_SANDBOX;
      networkSandbox = "enforced";
    }
  }

  let shellPathsUnenforceable: string | undefined;
  let confined: ClaudeConfinedSandbox | undefined;
  if (shellOffered && policySetsPaths(policy)) {
    const confinement = confineShellWrites(
      policy,
      sandbox,
      options.workingDirectory ?? process.cwd(),
      options.inheritHostConfig,
      options.env ?? process.env,
    );
    if (typeof confinement === "string") {
      shellPathsUnenforceable = confinement;
    } else {
      confined = confinement;
    }
  }

  return {
    isolated: !options.inheritHostConfig,
    denyForeignMcpTools:
      !options.inheritHostConfig ||
      policy?.mode === "read-only" ||
      !networkAllowed(policy),
    tools,
    disallowedTools: removed.size > 0 ? [...removed] : undefined,
    sandbox: confined ?? sandbox,
    shellPathsUnenforceable,
    networkSandbox,
    readOnlyWebTools:
      readOnlyWebTools.length > 0 ? readOnlyWebTools : undefined,
    unenforceableWebTools:
      unenforceableWebTools.length > 0 ? unenforceableWebTools : undefined,
    shellOffered,
    // Without a pinned list the runtime default applies, which reads files.
    fileReadOffered:
      tools === undefined ||
      tools.some((name) => CLAUDE_FILE_READ_TOOLS.has(name)),
  };
}

/**
 * The sandbox with its writable roots set to the policy's allowed roots, or
 * why shell writes cannot be kept inside them.
 *
 * @remarks Fails closed when the shell is unsandboxed, when host settings
 * merge into the sandbox (`inheritHostConfig`: `Edit(...)` allow rules and a
 * host `sandbox.filesystem.allowWrite` widen it), when the working directory
 * is outside the allowed roots (always writable), and when the working
 * directory or an allowed root lies in the always-writable temp area, where
 * the paths around the allowed roots would stay writable.
 */
function confineShellWrites(
  policy: ExternalAgentPermissionPolicy,
  sandbox: ClaudeNoNetworkSandbox | undefined,
  workingDirectory: string,
  inheritHostConfig: boolean,
  env: Record<string, string | undefined>,
): ClaudeConfinedSandbox | string {
  if (!sandbox) {
    return "shell commands run without the Claude Code sandbox (allowNetwork: true or allowUnsandboxedShell), so nothing keeps their writes inside allowedPaths";
  }
  if (inheritHostConfig) {
    return "with inheritHostConfig, host settings (Edit allow rules, sandbox.filesystem.allowWrite) are merged into the sandbox's writable paths";
  }
  // Writes follow `allowedPaths` and `pathBounds` only; read roots never
  // become writable. A policy with read rules alone allows no write root.
  const writeLists =
    policy.allowedPaths || policy.pathBounds
      ? [
          ...(policy.allowedPaths ? [policy.allowedPaths] : []),
          ...(policy.pathBounds ?? []),
        ]
      : [[]];
  const lists = writeLists.map((list) =>
    list
      .map((root) => canonicalPath(root, workingDirectory))
      .filter((root): root is string => root !== undefined),
  );
  const cwd = canonicalPath(workingDirectory, workingDirectory);
  if (cwd === undefined || !lists.every((roots) => isUnderAny(cwd, roots))) {
    return `the working directory ${workingDirectory} is outside allowedPaths, and the Claude Code sandbox always lets shell commands write there`;
  }
  // A root is writable only when it is inside every list.
  const allowWrite = [
    ...new Set(
      (lists[0] ?? []).filter((root) =>
        lists.every((roots) => isUnderAny(root, roots)),
      ),
    ),
  ];
  const temp = sandboxTempRoots(env);
  const inTemp = [cwd, ...allowWrite].find((path) => isUnderAny(path, temp));
  if (inTemp !== undefined) {
    return `${inTemp} is inside a temp directory that the Claude Code sandbox always keeps writable, so the paths around allowedPaths there stay writable`;
  }
  return Object.freeze({
    ...sandbox,
    filesystem: Object.freeze({ allowWrite: Object.freeze(allowWrite) }),
  });
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
  /**
   * Tool allowlists of declared MCP servers, by server name (tool names
   * without the `mcp__<server>__` prefix). A server listed here is expected
   * with all its tools in `system/init`, but a call to a tool outside its
   * list is denied ({@link isListedClaudeMcpTool}). A server without an entry
   * allows every tool.
   */
  mcpToolAllowlists?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Whether a call to `name` passes the tool allowlist of its declared MCP
 * server: true for a tool that is not of a server with an allowlist, or one
 * its server lists.
 *
 * @param name - The tool name as the runtime reports it.
 * @param expected - The tools and MCP servers the driver configured.
 * @returns False only for an unlisted tool of a server with an allowlist.
 */
export function isListedClaudeMcpTool(
  name: string,
  expected: ClaudeIsolationExpectation,
): boolean {
  let server: string | undefined;
  for (const candidate of Object.keys(expected.mcpToolAllowlists ?? {})) {
    if (
      name.startsWith(`mcp__${candidate}__`) &&
      (server === undefined || candidate.length > server.length)
    ) {
      server = candidate;
    }
  }
  if (server === undefined) {
    return true;
  }
  const tool = name.slice(`mcp__${server}__`.length);
  return expected.mcpToolAllowlists?.[server]?.includes(tool) ?? false;
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
  const tools = (claudeInitTools(message) ?? []).filter(
    (name) => !isExpectedClaudeTool(name, expected),
  );
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
 * The tool names a `system/init` message reports, as the runtime spells them.
 *
 * @param message - One runtime message, any type.
 * @returns The names (empty when the message lists none), or `undefined`
 * when `message` is not `system/init`.
 */
export function claudeInitTools(message: unknown): string[] | undefined {
  const record = asRecord(message);
  if (record.type !== "system" || record.subtype !== "init") {
    return undefined;
  }
  return Array.isArray(record.tools)
    ? record.tools
        .map((tool) => stringValue(tool) ?? stringValue(asRecord(tool).name))
        .filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The canonical spelling of a built-in tool the bridge can offer, matched
 * ASCII case-insensitively (the model or SDK may report `bash` for `Bash`).
 *
 * @param name - The tool name as the runtime reports it.
 * @returns The canonical name, or `undefined` when `name` is not one of the
 * built-ins the bridge knows. Only built-in names are returned and none starts
 * with `mcp__`, so MCP tool names are never folded.
 * @internal
 */
export function canonicalClaudeToolName(name: string): string | undefined {
  const lower = name.toLowerCase();
  return [
    ...DEFAULT_CLAUDE_TOOLS,
    ...CLAUDE_WRITE_TOOLS,
    ...CLAUDE_NETWORK_TOOLS,
  ].find((tool) => tool.toLowerCase() === lower);
}

/**
 * Whether an isolated run may use the tool `name`: a configured built-in
 * tool, or a tool of an expected MCP server (`mcp__<server>__<tool>`).
 *
 * @remarks
 * Built-in names are compared by canonical name, so an offered tool reported
 * as `bash` is accepted; a built-in that was not offered is not.
 *
 * Claude Code writes a server name into tool names with every
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
  const canonical = canonicalClaudeToolName(name);
  if (canonical !== undefined && expected.tools.includes(canonical)) {
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
 * @returns The unexpected tool names (an empty, missing or non-string name
 * counts as unexpected and is reported as `""`); empty for any other message.
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
    .map((block) => (typeof block.name === "string" ? block.name : ""))
    .filter((name) => !isExpectedClaudeTool(name, expected));
}

/**
 * Throws when one runtime message shows something outside the isolated set:
 * a `system/init` listing (see {@link assertClaudeInitIsolated}) or an
 * assistant `tool_use` of a tool outside `expected`.
 *
 * @remarks claude.ai connectors and some MCP servers connect after `init`,
 * so the init listing alone can miss them. Checking each tool the model is
 * about to use closes that gap. The error message states what the bridge
 * saw: a tool the runtime offered at start points to a host or managed
 * setting, a built-in it did not offer to the model inventing a call, an
 * MCP tool it did not offer to the model or to a server that connected
 * later. The code and recoverability are the same in every case.
 * @param message - One runtime message, any type.
 * @param expected - The tools and MCP servers the driver configured.
 * @param runtime - Runtime name used in the error message.
 * @param offered - The tools the session's `system/init` reported (see
 * {@link claudeInitTools}); `undefined` when no `init` was seen yet.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_ISOLATION_VIOLATED` when something outside `expected`
 * appears.
 */
export function assertClaudeMessageIsolated(
  message: unknown,
  expected: ClaudeIsolationExpectation,
  runtime: string,
  offered?: readonly string[],
): void {
  assertClaudeInitIsolated(message, expected, runtime);
  const tools = findToolUseViolations(message, expected);
  if (tools.length > 0) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_ISOLATION_VIOLATED,
      toolUseStopMessage(tools, runtime, offered),
    );
  }
}

/**
 * How many refused calls to tools the model was not offered a run takes: the
 * call that reaches this count stops it.
 */
export const MAX_REFUSED_TOOL_CALLS = 3;

/**
 * Checks the runtime messages of one isolated run and waits for the
 * runtime's answer to a call the model invented.
 *
 * @remarks
 * Security invariant: a tool outside the isolated set that the runtime has,
 * or that ran, stops the run. Prevention is the offered tool list, the
 * `PreToolUse` hook and the permission callback; this check detects what got
 * past them. A `tool_use` outside the set is held, not stopped at once, only
 * when every signal says the runtime has no such tool: `system/init` was
 * seen and did not list it, it is not an MCP tool (a server may connect
 * after start), and it has a name and a call id. The caller stops the run
 * first when the hook or the permission callback was reached for any tool
 * outside the set (the tool exists). A held call is then:
 * - refused, and the run goes on, when its `tool_result` has
 *   `is_error: true` (the runtime answers an unknown tool before any hook);
 *   the {@link MAX_REFUSED_TOOL_CALLS}th refused call stops the run;
 * - a violation when its result is not an error (it ran), or when the run
 *   ends without one ({@link ClaudeToolUseCheck.finish}).
 * The error text is never matched; only the message structure is used.
 */
export class ClaudeToolUseCheck {
  readonly #expected: ClaudeIsolationExpectation;
  readonly #runtime: string;
  /** Held calls: call id to tool name. */
  readonly #held = new Map<string, string>();
  readonly #refused: string[] = [];

  /**
   * @param expected - The tools and MCP servers the driver configured.
   * @param runtime - Runtime name used in the error messages.
   */
  constructor(expected: ClaudeIsolationExpectation, runtime: string) {
    this.#expected = expected;
    this.#runtime = runtime;
  }

  /**
   * Checks one runtime message.
   *
   * @param message - One runtime message, any type.
   * @param offered - The tools the session's `system/init` reported;
   * `undefined` when no `init` was seen yet.
   * @returns The call ids this message answered with a refusal; empty for
   * most messages.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_ISOLATION_VIOLATED` as described on the class.
   */
  check(message: unknown, offered: readonly string[] | undefined): string[] {
    assertClaudeInitIsolated(message, this.#expected, this.#runtime);
    const record = asRecord(message);
    const content = asRecord(record.message).content;
    if (!Array.isArray(content)) return [];
    if (record.type === "assistant") {
      this.#holdInventedCalls(content, offered);
      return [];
    }
    if (record.type !== "user") return [];
    const refused: string[] = [];
    for (const block of content.map(asRecord)) {
      if (block.type !== "tool_result") continue;
      const id = stringValue(block.tool_use_id);
      const name = id === undefined ? undefined : this.#held.get(id);
      if (id === undefined || name === undefined) continue;
      this.#held.delete(id);
      if (block.is_error !== true) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_ISOLATION_VIOLATED,
          `${this.#runtime}: the model requested ${JSON.stringify(name)}, a tool that was not offered, and the runtime ran it instead of refusing it, so the isolation policy stopped the run. A host or managed setting may be adding tools. Pass inheritHostConfig: true to allow the host configuration.`,
        );
      }
      this.#refused.push(name);
      refused.push(id);
      if (this.#refused.length >= MAX_REFUSED_TOOL_CALLS) {
        throw new ExternalAgentPolicyError(
          EXTERNAL_AGENT_ISOLATION_VIOLATED,
          `${this.#runtime}: the model requested ${this.#refused.length} tools it was not offered in one run (${this.#refused.map((tool) => JSON.stringify(tool)).join(", ")}); the runtime refused each one, and the isolation policy stopped the run so a model that keeps asking does not spend the budget.`,
        );
      }
    }
    return refused;
  }

  /**
   * Call at the end of the run (its result message, or the end of the
   * stream).
   *
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_ISOLATION_VIOLATED` when a held call got no result.
   */
  finish(): void {
    if (this.#held.size === 0) return;
    const names = [...new Set(this.#held.values())]
      .map((tool) => JSON.stringify(tool))
      .join(", ");
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_ISOLATION_VIOLATED,
      `${this.#runtime}: the model requested ${names}, a tool that was not offered, and the runtime gave no result for it before the run ended, so the isolation policy stopped the run.`,
    );
  }

  #holdInventedCalls(
    content: readonly unknown[],
    offered: readonly string[] | undefined,
  ): void {
    const outside = content
      .map(asRecord)
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        name: typeof block.name === "string" ? block.name : "",
        id: stringValue(block.id),
      }))
      .filter(({ name }) => !isExpectedClaudeTool(name, this.#expected));
    if (outside.length === 0) return;
    const holdable = (call: {
      name: string;
      id?: string;
    }): call is { name: string; id: string } =>
      offered !== undefined &&
      call.name !== "" &&
      call.id !== undefined &&
      !call.name.startsWith("mcp__") &&
      !wasOffered(call.name, offered);
    const held = outside.filter(holdable);
    if (held.length < outside.length) {
      throw new ExternalAgentPolicyError(
        EXTERNAL_AGENT_ISOLATION_VIOLATED,
        toolUseStopMessage(
          outside.map(({ name }) => name),
          this.#runtime,
          offered,
        ),
      );
    }
    for (const { name, id } of held) {
      this.#held.set(id, name);
    }
  }
}

/** Whether `system/init` listed `tool`, under its own or its canonical name. */
function wasOffered(tool: string, offered: readonly string[]): boolean {
  const canonical = canonicalClaudeToolName(tool);
  return (
    offered.includes(tool) ||
    (canonical !== undefined && offered.includes(canonical))
  );
}

/** The stop message for `tool_use` names outside the isolated set. */
function toolUseStopMessage(
  tools: readonly string[],
  runtime: string,
  offered: readonly string[] | undefined,
): string {
  const names = tools.map((tool) => JSON.stringify(tool)).join(", ");
  const optIn = "Pass inheritHostConfig: true to allow the host configuration.";
  if (offered === undefined) {
    return `${runtime} tried to use ${names}, outside the isolated set, so the isolation policy stopped the run. The runtime had not reported the tools it offers yet. ${optIn}`;
  }
  if (tools.some((tool) => wasOffered(tool, offered))) {
    return `${runtime} tried to use ${names}, outside the isolated set, so the run was stopped. The runtime offered it, so a host or managed setting may be adding tools. ${optIn}`;
  }
  const notOffered = `${runtime}: the model requested ${names}, a tool that was not offered (it is not in the session's system/init tools), so the isolation policy stopped the run.`;
  if (tools.some((tool) => tool.startsWith("mcp__"))) {
    return `${notOffered} An MCP server or claude.ai connector that connects after start may have added it; check host and managed settings, or ${optIn.charAt(0).toLowerCase()}${optIn.slice(1)}`;
  }
  return `${notOffered} This points to the model asking for a tool it was not given, not to a host setting.`;
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
    // Keeps Claude Code from pointing the agent at the host's auto-memory
    // directory, outside the run's isolation.
    settings.autoMemoryEnabled = false;
  }
  if (plan.denyForeignMcpTools) {
    // The CLI has no MCP server of its own, so every MCP tool is foreign: a
    // connector or host server (including one that connects late or that host
    // settings pre-approve) is denied before it runs, in every permission
    // mode. `mcp__*` is the CLI's rule for "all MCP servers' tools" (checked
    // on 2.1.319, bypassPermissions included: the tools leave the init list).
    settings.permissions = { deny: ["mcp__*"] };
  }
  if (plan.readOnlyWebTools) {
    // `dontAsk` (read-only) denies every tool that would prompt; an allow
    // rule lets the web tools through when the policy turns the network on.
    settings.permissions = {
      allow: plan.readOnlyWebTools,
      ...(settings.permissions as Record<string, unknown> | undefined),
    };
  }
  if (plan.sandbox) {
    settings.sandbox = plan.sandbox;
  }
  if (Object.keys(settings).length > 0) {
    args.push(`--settings=${JSON.stringify(settings)}`);
  }
  return args;
}
