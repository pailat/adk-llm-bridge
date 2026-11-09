/**
 * Typed, non-recoverable refusals shared by the drivers. A driver that cannot
 * keep a security guarantee, or cannot run at all, stops the run with one of
 * these codes instead of running with less protection than the policy asks
 * for, or throwing out of the agent.
 */

import type { ExternalAgentEvent } from "../events.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";

/**
 * The runtime reported tools or MCP servers outside the set the driver
 * configured (host tools, claude.ai connectors, host MCP servers).
 */
export const EXTERNAL_AGENT_ISOLATION_VIOLATED =
  "EXTERNAL_AGENT_ISOLATION_VIOLATED";

/**
 * The policy does not set `allowNetwork: true` (network is off), and the
 * runtime cannot keep its
 * tools (shell commands, web tools, MCP servers) off the network in the
 * requested mode.
 */
export const EXTERNAL_AGENT_NETWORK_UNENFORCEABLE =
  "EXTERNAL_AGENT_NETWORK_UNENFORCEABLE";

/**
 * The policy sets `allowedPaths` (or inherited `pathBounds`), and the driver
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

/** Codes of {@link ExternalAgentPolicyError}. */
export type ExternalAgentPolicyErrorCode =
  | typeof EXTERNAL_AGENT_ISOLATION_VIOLATED
  | typeof EXTERNAL_AGENT_NETWORK_UNENFORCEABLE
  | typeof EXTERNAL_AGENT_PATHS_UNENFORCEABLE
  | typeof EXTERNAL_AGENT_DEPENDENCY_MISSING
  | typeof EXTERNAL_AGENT_MISSING_BINARY
  | typeof EXTERNAL_AGENT_CREDENTIAL_UNSUPPORTED
  | typeof EXTERNAL_AGENT_OPTION_UNSUPPORTED;

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
 * a run inside `allowedPaths` or `pathBounds`. Such a run is refused unless the
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
  if (
    (policy?.allowedPaths === undefined && policy?.pathBounds === undefined) ||
    options.allowUnenforcedPaths
  ) {
    return undefined;
  }
  return new ExternalAgentPolicyError(
    EXTERNAL_AGENT_PATHS_UNENFORCEABLE,
    `${options.runtime} runs file tools without asking the bridge, so allowedPaths (or the path bounds inherited from a parent agent) cannot be enforced. Use ClaudeAgentSdkDriver, remove allowedPaths, or build the driver with allowUnenforcedPaths: true to run anyway (the runtime's own sandbox then decides which paths it reaches).`,
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
