/**
 * Typed, non-recoverable refusals shared by the drivers. A driver that cannot
 * keep a security guarantee, or cannot run at all, stops the run with one of
 * these codes instead of running with less protection than the policy asks
 * for, or throwing out of the agent.
 */

import type { ExternalAgentEvent } from "../events.js";
import { networkAllowed } from "../permissions/network.js";
import { policySetsPaths } from "../permissions/paths.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";

/**
 * The runtime reported tools or MCP servers outside the set the driver
 * configured (host tools, claude.ai connectors, host MCP servers).
 */
export const EXTERNAL_AGENT_ISOLATION_VIOLATED =
  "EXTERNAL_AGENT_ISOLATION_VIOLATED";

/**
 * Not an error: the value of `metadata.isolation` on the `tool_result` event
 * of a call to a tool the model was not offered, which the runtime refused
 * without running it. `ClaudeAgentSdkDriver` reports such a call and goes on;
 * the third one in a run stops it with
 * {@link EXTERNAL_AGENT_ISOLATION_VIOLATED}.
 */
export const EXTERNAL_AGENT_TOOL_NOT_OFFERED =
  "EXTERNAL_AGENT_TOOL_NOT_OFFERED";

/**
 * Not a refusal: the code of the `error` event of a Claude run that reached
 * its result while a background task it started was still running. A
 * headless run cannot wait for the task, so its work is not done; the run
 * ends with exit code 1 instead of reporting success.
 */
export const EXTERNAL_AGENT_BACKGROUND_TASK_PENDING =
  "EXTERNAL_AGENT_BACKGROUND_TASK_PENDING";

/**
 * The policy does not set `allowNetwork: true` (network is off), and the
 * runtime cannot keep its
 * tools (shell commands, web tools, MCP servers) off the network in the
 * requested mode.
 */
export const EXTERNAL_AGENT_NETWORK_UNENFORCEABLE =
  "EXTERNAL_AGENT_NETWORK_UNENFORCEABLE";

/**
 * The policy sets `allowedPaths` or `readPaths` (or inherited path bounds), and the driver
 * cannot check the paths of the runtime's tool calls against them: the
 * runtime never asks the bridge before a file tool runs.
 */
export const EXTERNAL_AGENT_PATHS_UNENFORCEABLE =
  "EXTERNAL_AGENT_PATHS_UNENFORCEABLE";

/**
 * An optional SDK package the driver needs is not installed. The message
 * names it and the install command.
 */
export const EXTERNAL_AGENT_DEPENDENCY_MISSING =
  "EXTERNAL_AGENT_DEPENDENCY_MISSING";

/**
 * The runtime's binary was not found. Same code the error classifier gives
 * an "unable to locate" or `ENOENT` message, so every driver reports a
 * missing binary the same way.
 */
export const EXTERNAL_AGENT_MISSING_BINARY = "MISSING_BINARY";

/**
 * The credential provider returned a credential whose `kind` is neither
 * `"env"` nor `"none"`. No driver can deliver it, so the run is refused
 * instead of falling back to the runtime's own login.
 */
export const EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED =
  "EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED";

/**
 * The driver was configured with an option its runtime cannot honor, for
 * example a `sessionStore` on the Claude CLI driver (only the Claude Agent
 * SDK mirrors transcripts to a store). Thrown when the driver is built, so the
 * option is never silently ignored.
 */
export const EXTERNAL_AGENT_OPTION_UNSUPPORTED =
  "EXTERNAL_AGENT_OPTION_UNSUPPORTED";

/**
 * On Windows, the command resolves to a batch file (`.cmd` or `.bat`), for
 * example an npm shim such as `gemini.cmd`. Running one means going through
 * `cmd.exe`, which re-parses the arguments (a prompt with `&` or `|` would
 * run as a command), so the driver never runs it. Point `command` at the
 * native `.exe` or, for Gemini CLI, set `interpreter` (a native `node.exe`)
 * and `entry` (the package's JavaScript entry).
 */
export const EXTERNAL_AGENT_BATCH_COMMAND_REFUSED =
  "EXTERNAL_AGENT_BATCH_COMMAND_REFUSED";

/**
 * A CLI driver built with `interpreter` and `entry` was asked to start a file
 * the run's agent can write: the entry script, or an interpreter given as a
 * path, or the entry's directory (where the interpreter starts), is at or
 * under the run's working directory, an `allowedPaths` root or a temp
 * directory a runtime sandbox keeps writable (symlinks resolved). The agent could replace it in one run and have the
 * next run execute it on the host, outside the runtime's sandbox, so the run
 * is refused before anything starts. Also used when the interpreter is not
 * the native Node binary (its real path is not named `node` or `node.exe`,
 * or the file is not a native executable, such as a script shim): other
 * interpreters and version-manager shims read configuration from the run's
 * working directory.
 */
export const EXTERNAL_AGENT_INTERPRETER_UNSAFE =
  "EXTERNAL_AGENT_INTERPRETER_UNSAFE";

/**
 * The driver's `model` option is not a usable model id: not a string, empty,
 * longer than 256 characters, with whitespace or a control character, or
 * starting with `-`. Thrown when the driver is built.
 */
export const EXTERNAL_AGENT_MODEL_INVALID = "EXTERNAL_AGENT_MODEL_INVALID";

/**
 * The driver was built with `requireExplicitModel: true` and has no `model`,
 * or its `model` is a router or default alias that lets the runtime choose
 * (Claude `default`, `best`, `opusplan`; Gemini `auto`, `auto-*`). Thrown
 * when the driver is built.
 */
export const EXTERNAL_AGENT_MODEL_REQUIRED = "EXTERNAL_AGENT_MODEL_REQUIRED";

/**
 * Something other than the driver's `model` option would set, remap or route
 * the model: an extra `args` entry or Codex SDK `config` key (thrown when the
 * driver is built), a model variable in the run's environment, or a Gemini
 * CLI read-only run, whose plan mode may route turns to another model
 * (reported as the run's error event). `allowPolicyOverrideArgs` does not
 * lift it.
 */
export const EXTERNAL_AGENT_MODEL_OVERRIDE = "EXTERNAL_AGENT_MODEL_OVERRIDE";

/**
 * `ExternalAgentConfig.tools` was given to an agent whose driver cannot host
 * ADK tools (`capabilities().tools` is not `true`): the tools would never
 * reach the runtime. Thrown when the agent is built. Use `ClaudeAgent` (the
 * Claude Agent SDK driver) or remove `tools`.
 */
export const EXTERNAL_AGENT_TOOLS_UNSUPPORTED =
  "EXTERNAL_AGENT_TOOLS_UNSUPPORTED";

/**
 * The agent has an approver (`confirmation.approver`) or ADK confirmation
 * (`confirmation.adk`), and its driver never asks the host for permission
 * (`capabilities().approvals` is not `true`): the runtime decides alone, so
 * the setting would be ignored silently. Thrown when the agent is built. Use
 * `ClaudeAgent` (the Claude Agent SDK driver), or remove `confirmation`.
 */
export const EXTERNAL_AGENT_APPROVALS_UNSUPPORTED =
  "EXTERNAL_AGENT_APPROVALS_UNSUPPORTED";

/**
 * A `readOnlyTools` entry that cannot attest exactly one tool: it is empty,
 * listed twice, matches no direct tool (when no toolset could add it), or
 * names two or more direct tools. Thrown when the agent is built.
 */
export const EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN =
  "EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN";

/**
 * The agent's own `permissions.mode` is `read-only` and a direct ADK tool is
 * not named in `readOnlyTools`, so the run would drop it silently. Thrown
 * when the agent is built. List the tool if it has no side effects, or
 * remove it.
 */
export const EXTERNAL_AGENT_TOOL_NOT_READ_ONLY =
  "EXTERNAL_AGENT_TOOL_NOT_READ_ONLY";

/** Codes of {@link ExternalAgentPolicyError}. */
export type ExternalAgentPolicyErrorCode =
  | typeof EXTERNAL_AGENT_ISOLATION_VIOLATED
  | typeof EXTERNAL_AGENT_NETWORK_UNENFORCEABLE
  | typeof EXTERNAL_AGENT_PATHS_UNENFORCEABLE
  | typeof EXTERNAL_AGENT_DEPENDENCY_MISSING
  | typeof EXTERNAL_AGENT_MISSING_BINARY
  | typeof EXTERNAL_AGENT_BATCH_COMMAND_REFUSED
  | typeof EXTERNAL_AGENT_INTERPRETER_UNSAFE
  | typeof EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED
  | typeof EXTERNAL_AGENT_OPTION_UNSUPPORTED
  | typeof EXTERNAL_AGENT_MODEL_INVALID
  | typeof EXTERNAL_AGENT_MODEL_REQUIRED
  | typeof EXTERNAL_AGENT_MODEL_OVERRIDE
  | typeof EXTERNAL_AGENT_TOOLS_UNSUPPORTED
  | typeof EXTERNAL_AGENT_APPROVALS_UNSUPPORTED
  | typeof EXTERNAL_AGENT_READ_ONLY_TOOL_UNKNOWN
  | typeof EXTERNAL_AGENT_TOOL_NOT_READ_ONLY;

/**
 * A run the driver refuses to start or continue. Never recoverable: retrying
 * hits the same configuration.
 */
export class ExternalAgentPolicyError extends Error {
  /** Why the run was refused. */
  readonly code: ExternalAgentPolicyErrorCode;
  /** Always `false`: retrying hits the same configuration. */
  readonly recoverable = false;

  /**
   * Creates a policy error.
   *
   * @param code - One of the policy error codes.
   * @param message - What went wrong and how to fix or opt in.
   */
  constructor(code: ExternalAgentPolicyErrorCode, message: string) {
    super(message);
    this.name = "ExternalAgentPolicyError";
    this.code = code;
  }
}

/**
 * The `error` event for a refused run.
 *
 * @param error - The refusal.
 * @returns A non-recoverable error event carrying `error.code`.
 */
export function policyErrorEvent(
  error: ExternalAgentPolicyError,
): ExternalAgentEvent {
  return {
    type: "error",
    message: error.message,
    code: error.code,
    recoverable: false,
    timestamp: Date.now(),
  };
}

/**
 * A runtime whose `full-access` mode has no sandbox cannot keep shell
 * commands off the network. Unless the policy sets `allowNetwork: true` the
 * run is refused,
 * unless the driver was built with `allowUnenforcedNetwork: true`.
 *
 * @param policy - The effective permission policy of the run.
 * @param options - Runtime name for the message, and the driver opt-in.
 * @returns An `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` error to report, or
 * `undefined` when the run may start.
 */
export function unsandboxedShellRefusal(
  policy: ExternalAgentPermissionPolicy | undefined,
  options: { runtime: string; allowUnenforcedNetwork: boolean },
): ExternalAgentPolicyError | undefined {
  if (
    networkAllowed(policy) ||
    policy?.mode !== "full-access" ||
    options.allowUnenforcedNetwork
  ) {
    return undefined;
  }
  return networkUnenforceable(
    `${options.runtime} runs shell commands without a sandbox in full-access mode, so the network cannot be kept off (it is off unless allowNetwork is true). Use the workspace-write or ask mode, set allowNetwork: true, or build the driver with allowUnenforcedNetwork: true to run anyway.`,
  );
}

/**
 * A driver whose runtime runs file tools without asking the bridge cannot keep
 * a run inside `allowedPaths`, `readPaths` or the path bounds. Such a run is refused unless the
 * driver was built with `allowUnenforcedPaths: true`.
 *
 * @param policy - The effective permission policy of the run.
 * @param options - Runtime name for the message, and the driver opt-in.
 * @returns An `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` error to report, or
 * `undefined` when the policy sets no paths or the driver opted in.
 */
export function unenforceablePathsRefusal(
  policy: ExternalAgentPermissionPolicy | undefined,
  options: { runtime: string; allowUnenforcedPaths: boolean },
): ExternalAgentPolicyError | undefined {
  if (!policySetsPaths(policy) || options.allowUnenforcedPaths) {
    return undefined;
  }
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
    `${options.runtime} runs file tools without asking the bridge, so allowedPaths and readPaths (or the path bounds inherited from a parent agent) cannot be enforced. Use ClaudeAgentSdkDriver, remove allowedPaths, or build the driver with allowUnenforcedPaths: true to run anyway (the runtime's own sandbox then decides which paths it reaches).`,
  );
}

/**
 * Why a Claude run that offers web tools with the network off is refused.
 *
 * @param runtime - Runtime name for the message.
 * @param tools - The web tools named in the configured `tools`.
 * @returns The message for {@link networkUnenforceable}.
 */
export function webToolsRefusal(
  runtime: string,
  tools: readonly string[],
): string {
  return `${runtime} was configured with web tools (${tools.join(", ")}), but the network is off (it is off unless allowNetwork is true). Set allowNetwork: true, or remove the web tools from tools.`;
}

/**
 * An `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` refusal.
 *
 * @param message - Why, and how to opt in.
 * @returns The error to report with {@link policyErrorEvent}.
 */
export function networkUnenforceable(
  message: string,
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_NETWORK_UNENFORCEABLE,
    message,
  );
}

/**
 * An error naming what to install: `EXTERNAL_AGENT_DEPENDENCY_MISSING` for
 * an SDK package, `MISSING_BINARY` for a CLI binary.
 *
 * @param kind - `package` or `binary`.
 * @param what - The missing package or binary, as the user would name it.
 * @param install - The command that installs it.
 * @param alternative - Another way to run, if any.
 * @returns The error to report with {@link policyErrorEvent}.
 */
export function dependencyMissing(
  kind: "package" | "binary",
  what: string,
  install: string,
  alternative?: string,
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    kind === "package"
      ? EXTERNAL_AGENT_DEPENDENCY_MISSING
      : EXTERNAL_AGENT_MISSING_BINARY,
    `${what} is not installed. Install it with \`${install}\`${alternative ? `, or ${alternative}` : ""}.`,
  );
}

/** What to do instead, per CLI, when a Windows command resolved to a batch file. */
const BATCH_REMEDY = {
  claude:
    "Set `command` to the native claude.exe from Claude's native installer.",
  codex:
    "Set `command` to the codex.exe inside the @openai/codex package, for example node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe (win32-arm64 uses codex-win32-arm64 and aarch64-pc-windows-msvc).",
  gemini:
    "Gemini CLI has no native .exe: set `interpreter` to node (a native node.exe) and `entry` to the package's JavaScript entry, the file named by `bin.gemini` in @google/gemini-cli's package.json.",
  fx: "Set `command` to a native fx.exe, not a batch shim.",
} as const;

/**
 * The policy error for a Windows command that resolved to a batch file.
 *
 * @param error - The error the spawn threw (an `Error` with the code
 * `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`).
 * @param cli - The CLI the driver runs, for the advice in the message.
 * @returns The error to report with {@link policyErrorEvent}.
 */
export function batchCommandRefusal(
  error: Error,
  cli: keyof typeof BATCH_REMEDY,
): ExternalAgentPolicyError {
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_BATCH_COMMAND_REFUSED,
    `${error.message} ${BATCH_REMEDY[cli]} See docs/external-agent-isolation.md, "Windows: batch files and npm installs".`,
  );
}

/**
 * True for the error a spawn reports when the command does not exist
 * (`ENOENT`, from Node's `error` event or a throwing `Bun.spawn`).
 *
 * @param error - Anything thrown or rejected by a spawn.
 * @returns Whether the command was not found.
 */
export function isCommandNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "ENOENT" ||
    (typeof record.message === "string" &&
      /\bENOENT\b|executable not found|command not found/i.test(record.message))
  );
}
