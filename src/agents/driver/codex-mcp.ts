/**
 * Turns off Codex's host MCP servers when the policy forbids the network.
 *
 * MCP servers configured in `~/.codex/config.toml` (or a project config) run
 * as separate processes outside the Codex sandbox, so they can reach the
 * network even when the sandbox cannot. Without `allowNetwork: true` the
 * drivers list them with `codex mcp list --json` (same `CODEX_HOME`, env and
 * working directory as the run) and pass `-c mcp_servers.<name>.enabled=false`
 * for each one. Overriding the whole table (`-c mcp_servers={}`) does not
 * work: Codex merges config overrides, so the host entries survive.
 *
 * Internal: not part of the public API.
 */

import { warn } from "../../utils/log.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { type LineSource, readAll } from "./lines.js";
import {
  batchCommandRefusal,
  type ExternalAgentPolicyError,
  isCommandNotFound,
  networkUnenforceable,
} from "./policy-errors.js";
import {
  BatchCommandRefusedError,
  type SupervisedSubprocess,
  spawnSubprocess,
  superviseSubprocess,
} from "./spawn.js";

/** Output of a listing process: a web stream or an async iterable. */
type ListingOutput = LineSource;

/**
 * The spawn the listing uses. A driver passes its own spawn, so a custom
 * spawn (a container, a remote host) lists the servers where Codex runs.
 */
export type CodexMcpListSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: Record<string, string> },
) => SupervisedSubprocess & {
  stdout?: ListingOutput | null;
  stderr?: ListingOutput | null;
  exited: Promise<number>;
};

/** Where and how to run the listing: the same as the run itself. */
export interface CodexMcpListOptions {
  /** The Codex binary, or the interpreter that runs `entry`. */
  command: string;
  /**
   * Arguments before `mcp list --json` when the driver runs an interpreter
   * (`CodexCliDriverConfig.interpreter` and `entry`): Node's `--import`
   * preload and the entry. `cwd` is then the entry's directory and `env`
   * carries the run's working directory for the preload. A custom lister
   * must run the listing the same way.
   */
  prefixArgs?: readonly string[];
  /** The environment of the run (carries `CODEX_HOME`). */
  env: Record<string, string>;
  /** The working directory of the run (project config is resolved from it). */
  cwd?: string;
}

/**
 * Lists the names of the MCP servers Codex would start, enabled or not.
 * Rejects when the listing cannot be trusted.
 */
export type CodexMcpLister = (
  options: CodexMcpListOptions,
) => Promise<readonly string[]>;

/** How long the listing may take before the run is refused. */
export const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;

/**
 * A server name that can be written as an unquoted TOML key in a `-c`
 * override. Codex does not accept quoted keys or dots there.
 */
const SAFE_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The default {@link CodexMcpLister}: runs `<command> mcp list --json`, or
 * `<command> <prefixArgs> mcp list --json` when `prefixArgs` is set.
 *
 * @param options - Binary, environment and working directory of the run.
 * @param spawn - How to start the process.
 * @defaultValue spawn - {@link spawnSubprocess}
 * @returns The server names, in listing order.
 * @throws Error when the command fails, times out, or prints something that
 * is not a JSON array of servers.
 */
export async function listCodexMcpServers(
  options: CodexMcpListOptions,
  spawn: CodexMcpListSpawn = spawnSubprocess,
): Promise<readonly string[]> {
  const prefix = options.prefixArgs ?? [];
  const child = spawn(options.command, [...prefix, "mcp", "list", "--json"], {
    cwd: options.cwd,
    env: options.env,
  });
  const controller = new AbortController();
  const supervisor = superviseSubprocess(child, controller.signal, {
    killGraceMs: 500,
  });
  const timer = setTimeout(() => controller.abort(), CODEX_MCP_LIST_TIMEOUT_MS);
  try {
    const [stdout, exitCode] = await Promise.all([
      readAll(child.stdout),
      child.exited,
      readAll(child.stderr),
    ]);
    supervisor.markExited();
    if (controller.signal.aborted) {
      throw new Error(
        `codex mcp list timed out after ${CODEX_MCP_LIST_TIMEOUT_MS} ms`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(`codex mcp list exited with code ${exitCode}`);
    }
    return parseCodexMcpList(stdout);
  } finally {
    clearTimeout(timer);
    supervisor.release();
  }
}

/**
 * Reads the server names from `codex mcp list --json` output: a JSON array
 * of objects with a `name`.
 *
 * @param stdout - The command's output.
 * @returns The server names.
 * @throws Error when the output is not that shape.
 */
export function parseCodexMcpList(stdout: string): readonly string[] {
  const parsed: unknown = JSON.parse(stdout.trim() || "null");
  if (!Array.isArray(parsed)) {
    throw new Error("codex mcp list --json did not print a JSON array");
  }
  return parsed.map((entry) => {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("codex mcp list --json printed a server without a name");
    }
    return name;
  });
}

/** Result of {@link codexMcpDisableOverrides}. */
export type CodexMcpDisableResult =
  | { overrides: readonly string[]; refusal?: undefined }
  | { overrides?: undefined; refusal: ExternalAgentPolicyError };

/**
 * The `-c` values that turn off every host MCP server, for a run whose
 * policy does not set `allowNetwork: true`.
 *
 * @remarks
 * Fails closed: when the listing fails, or a name cannot be written as an
 * override, the run is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`.
 * With `allowUnenforcedNetwork` a listing failure is logged instead and the
 * run goes on with the servers that could be named.
 *
 * @param policy - The effective permission policy of the run.
 * @param options - How to list, extra names the driver itself configures,
 * and the opt-in.
 * @returns No overrides when the policy sets `allowNetwork: true`; otherwise the overrides (values for `-c`, without the flag) or a
 * refusal.
 */
export async function codexMcpDisableOverrides(
  policy: ExternalAgentPermissionPolicy | undefined,
  options: CodexMcpListOptions & {
    lister?: CodexMcpLister;
    /** Servers configured by the driver (for example its `config.mcp_servers`). */
    configuredNames?: readonly string[];
    allowUnenforcedNetwork: boolean;
    runtime: string;
    /** Reported instead of the refusal when the Codex binary is missing. */
    commandNotFound?: () => ExternalAgentPolicyError;
  },
): Promise<CodexMcpDisableResult> {
  if (networkAllowed(policy)) {
    return { overrides: [] };
  }
  const lister = options.lister ?? listCodexMcpServers;
  let listed: readonly string[] = [];
  try {
    listed = await lister({
      command: options.command,
      ...(options.prefixArgs === undefined
        ? {}
        : { prefixArgs: options.prefixArgs }),
      env: options.env,
      cwd: options.cwd,
    });
  } catch (error) {
    if (error instanceof BatchCommandRefusedError) {
      return { refusal: batchCommandRefusal(error, "codex") };
    }
    if (options.commandNotFound && isCommandNotFound(error)) {
      return { refusal: options.commandNotFound() };
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (!options.allowUnenforcedNetwork) {
      return {
        refusal: networkUnenforceable(
          `${options.runtime} could not list its MCP servers (${reason}), so they cannot be turned off and the network cannot be kept off (it is off unless allowNetwork is true). Fix the Codex install or config, set allowNetwork: true, or build the driver with allowUnenforcedNetwork: true to run anyway.`,
        ),
      };
    }
    warn(
      "CODEX_MCP_LIST_FAILED",
      `${options.runtime} could not list its MCP servers (${reason}); running anyway because allowUnenforcedNetwork is set.`,
    );
  }
  const names = [...new Set([...listed, ...(options.configuredNames ?? [])])];
  const unsafe = names.filter((name) => !SAFE_SERVER_NAME.test(name));
  if (unsafe.length > 0 && !options.allowUnenforcedNetwork) {
    return {
      refusal: networkUnenforceable(
        `${options.runtime} has MCP servers whose names cannot be turned off with a config override (${unsafe.map((name) => JSON.stringify(name)).join(", ")}). Rename them to letters, digits, "_" and "-", set allowNetwork: true, or build the driver with allowUnenforcedNetwork: true to run anyway.`,
      ),
    };
  }
  return {
    overrides: names
      .filter((name) => SAFE_SERVER_NAME.test(name))
      .map((name) => `mcp_servers.${name}.enabled=false`),
  };
}

/**
 * The `-c` override that pins Codex's approvals reviewer to the user outside
 * `full-access`.
 *
 * @remarks
 * Security invariant: Codex reads `approvals_reviewer` from
 * `~/.codex/config.toml`. Set to `"auto_review"` there, it turns the CLI's
 * `--ask-for-approval never` into `on-request` with a model reviewer
 * (observed with codex-cli 0.167.0), so a sandboxed run could ask for, and
 * be granted, a command outside the sandbox; under `ask` the reviewer would
 * answer instead of the user. Both Codex drivers pass this override after
 * every other config value, so the host config and a driver `config` object
 * cannot change it. `full-access` has no sandbox to keep, so it adds none.
 *
 * @param policy - The run's policy; omitted means `read-only`.
 * @returns The raw overrides, empty under `full-access`.
 * @internal
 */
export function codexApprovalsReviewerOverrides(
  policy: ExternalAgentPermissionPolicy | undefined,
): readonly string[] {
  return policy?.mode === "full-access" ? [] : ['approvals_reviewer="user"'];
}
