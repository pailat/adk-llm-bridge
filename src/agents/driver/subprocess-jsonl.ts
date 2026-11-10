import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { InputValidationError } from "@google/adk";
import { parseJson } from "../../utils/json.js";
import { type ExternalAgentEvent, isExternalAgentEvent } from "../events.js";
import type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "../external-agent-driver.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import { agentWritableRoots, isSearchableExecutable } from "./shared.js";

/** Options for {@link SubprocessJsonlDriver}. */
export interface SubprocessJsonlDriverConfig {
  /** Provider id reported in `started` events. */
  providerId: string;
  /** Executable to run. */
  command: string;
  /**
   * Arguments for the executable.
   *
   * @defaultValue []
   */
  args?: readonly string[];
}

/**
 * The command-line flags a driver sets itself from the permission policy and
 * its isolation, which the configured extra `args` must not override.
 *
 * @internal
 */
export interface PinnedFlags {
  /**
   * Flags refused in every form: `--name`, `--name=value`, and for a
   * one-letter flag (`-s`) also `-svalue`.
   */
  flags: readonly string[];
  /**
   * Flags that take a `key=value` config override (Codex `-c`/`--config`).
   * Such an override is refused only when its key is one of `configKeys`
   * or below one (`mcp_servers` covers `mcp_servers.x.enabled`).
   */
  configFlags?: readonly string[];
  /** Config keys the driver pins; see `configFlags`. */
  configKeys?: readonly string[];
}

function flagValue(arg: string, name: string): string | undefined {
  if (arg === name) {
    return "";
  }
  if (name.startsWith("--")) {
    return arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
  }
  // A one-letter flag also takes its value attached: `-sread-only`, `-c=k=v`.
  if (name.length === 2 && !arg.startsWith("--") && arg.startsWith(name)) {
    const rest = arg.slice(2);
    return rest.startsWith("=") ? rest.slice(1) : rest;
  }
  return undefined;
}

function configKeyOf(override: string): string {
  // TOML dotted keys may quote a part (`"mcp_servers".x`); compare the bare path.
  return (override.split("=", 1)[0] ?? "").replace(/["'\s]/g, "").toLowerCase();
}

/**
 * Finds the first extra argument that would override a pinned flag.
 *
 * @remarks
 * Security invariant: the drivers append `args` after the flags they build
 * from the policy, so a CLI that reads a repeated flag last-wins would let an
 * entry such as `--permission-mode bypassPermissions` or
 * `-c sandbox_workspace_write.network_access=true` undo the policy. Matching
 * fails closed: an entry that is the value of another flag but is spelled
 * like a pinned flag is refused too.
 *
 * @param args - The configured extra arguments.
 * @param pinned - The driver's pinned flags.
 * @returns The offending entry (with its config value, if any), or
 * `undefined` when no entry overrides a pinned flag.
 * @internal
 */
export function findPinnedArgOverride(
  args: readonly string[],
  pinned: PinnedFlags,
): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (pinned.flags.some((name) => flagValue(arg, name) !== undefined)) {
      return arg;
    }
    for (const name of pinned.configFlags ?? []) {
      const attached = flagValue(arg, name);
      if (attached === undefined) {
        continue;
      }
      const override = attached === "" ? (args[index + 1] ?? "") : attached;
      const key = configKeyOf(override);
      if (
        (pinned.configKeys ?? []).some(
          (pinnedKey) => key === pinnedKey || key.startsWith(`${pinnedKey}.`),
        )
      ) {
        return attached === "" ? `${arg} ${override}` : arg;
      }
    }
  }
  return undefined;
}

/**
 * Refuses extra `args` that override a pinned flag, unless the driver was
 * built with `allowPolicyOverrideArgs: true`.
 *
 * @param driver - Driver name for the message.
 * @param args - The configured extra arguments.
 * @param pinned - The driver's pinned flags.
 * @param allowPolicyOverrideArgs - The driver opt-in.
 * @throws InputValidationError (from `@google/adk`) when `args` is not an
 * array of strings.
 * @throws {@link ExternalAgentPolicyError} with code
 * `EXTERNAL_AGENT_OPTION_UNSUPPORTED` when an entry overrides a pinned flag
 * and the driver did not opt in.
 * @internal
 */
export function assertNoPinnedArgOverride(
  driver: string,
  args: unknown,
  pinned: PinnedFlags,
  allowPolicyOverrideArgs: boolean,
): void {
  if (args === undefined) {
    return;
  }
  if (
    !Array.isArray(args) ||
    !args.every((arg): arg is string => typeof arg === "string")
  ) {
    throw new InputValidationError(
      `${driver}: args must be an array of strings.`,
    );
  }
  if (allowPolicyOverrideArgs) {
    return;
  }
  const override = findPinnedArgOverride(args, pinned);
  if (override !== undefined) {
    throw new ExternalAgentPolicyError(
      EXTERNAL_AGENT_OPTION_UNSUPPORTED,
      `${driver}: the args entry "${override}" overrides a flag the driver sets from the permission policy or its isolation (sandbox, network, permission mode, settings, tools, MCP servers, directories), so the run would not keep the policy. Remove it, use the matching driver option or policy field, or build the driver with allowPolicyOverrideArgs: true to pass it anyway.`,
    );
  }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      accessSync(path, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a CLI driver's `command` to the executable the built-in spawn
 * starts.
 *
 * @remarks
 * Security invariant: a bare command (no path separator) is looked up on the
 * child environment's `PATH` the way the spawn would, but every `PATH` entry
 * whose candidate is at or under the run's {@link agentWritableRoots} (its
 * working directory, the process directory when that is unset, and its
 * `allowedPaths`) is skipped, symlinks resolved. Under `npm run` / `bun run`
 * `PATH` starts with `<cwd>/node_modules/.bin`, so without this a binary the
 * agent planted there in one run would start the next run on the host.
 * Relative and empty `PATH` entries (relative to the child's working
 * directory) are never searched. A command with a path separator was chosen
 * by the host and is returned unchanged.
 *
 * @param command - The configured command.
 * @param env - The child's environment, for `PATH` (and `PATHEXT` on Windows).
 * @param request - The run, for its working directory and `allowedPaths`.
 * @returns The absolute path to start, the command itself when it has a path
 * separator, or `undefined` when no usable executable is left (the caller
 * reports `MISSING_BINARY`).
 * @internal
 */
export function resolveCliCommand(
  command: string,
  env: Record<string, string | undefined>,
  request: Pick<ExternalAgentRunRequest, "workingDirectory" | "permissions">,
): string | undefined {
  if (
    command.includes("/") ||
    (process.platform === "win32" && command.includes("\\"))
  ) {
    return command;
  }
  const excluded = agentWritableRoots(request);
  const extensions =
    process.platform === "win32"
      ? [...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";"), ""]
      : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    // A relative or empty entry names a directory relative to the child's
    // working directory, which the agent controls: never searched.
    if (!isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(dir, `${command}${extension}`);
      if (
        isSearchableExecutable(candidate, excluded) &&
        isExecutableFile(candidate)
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Base class for drivers that read JSON lines from a subprocess.
 *
 * @remarks
 * The base `run` does not spawn anything: it yields one recoverable `error`
 * event. Subclasses such as `CodexCliDriver` override `run`. The class
 * performs no work until `run` is called, which keeps imports free of CLI
 * execution, auth prompts and other side effects.
 */
export class SubprocessJsonlDriver implements ExternalAgentDriver {
  /** Provider id reported in `started` events. */
  readonly providerId: string;
  /** Executable to run. */
  readonly command: string;
  /** Arguments for the executable. */
  readonly args: readonly string[];

  /** @param config - Provider id, command and arguments. */
  constructor(config: SubprocessJsonlDriverConfig) {
    this.providerId = config.providerId;
    this.command = config.command;
    this.args = config.args ?? [];
  }

  /**
   * Placeholder run: yields a recoverable `error` event and ends.
   *
   * @param _request - Ignored by the base class.
   * @returns A single `error` event.
   */
  async *run(
    _request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    yield {
      type: "error",
      message:
        "Subprocess JSONL execution is a provider-driver concern and is not implemented in the foundation layer.",
      recoverable: true,
    };
  }

  /**
   * Parses one JSON line as an external agent event.
   *
   * @param line - One line of subprocess output.
   * @returns The event.
   * @throws SyntaxError when the line is not JSON.
   * @throws Error when the JSON is not a valid external agent event.
   */
  parseLine(line: string): ExternalAgentEvent {
    const parsed = parseJson(line);
    if (!parsed.ok) {
      throw new SyntaxError(parsed.error);
    }
    if (!isExternalAgentEvent(parsed.value)) {
      throw new Error("Invalid external agent JSONL event");
    }
    return parsed.value;
  }
}
