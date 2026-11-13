import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { InputValidationError } from "@google/adk";
import { parseJson } from "../../utils/json.js";
import { type ExternalAgentEvent, isExternalAgentEvent } from "../events.js";
import type {
  ExternalAgentDriver,
  ExternalAgentRunRequest,
} from "../external-agent-driver.js";
import { SUBPROCESS_JSONL_OPTION_KEYS } from "./option-keys.js";
import {
  EXTERNAL_AGENT_OPTION_UNSUPPORTED,
  ExternalAgentPolicyError,
} from "./policy-errors.js";
import {
  agentWritableRoots,
  asRecord,
  assertKnownDriverOptions,
  bridgeEvent,
  childMetadata,
  isSearchableExecutable,
} from "./shared.js";
import { windowsExecutableKind } from "./spawn.js";

const IGNORED_CHILD_LINE: ExternalAgentEvent = Object.freeze({
  type: "output",
  content: "",
});

/**
 * Whether an event is the internal placeholder for an ignored child line.
 *
 * Identity distinguishes it from a legitimate empty final output. The
 * placeholder cannot be constructed by parsing child JSON.
 *
 * @param event - A driver event.
 * @returns Whether the event must be skipped before any processing.
 * @internal
 */
export function isIgnoredChildLine(event: ExternalAgentEvent): boolean {
  return event === IGNORED_CHILD_LINE;
}

/** Options for {@link SubprocessJsonlDriver}. */
export interface SubprocessJsonlDriverConfig {
  /** Provider id reported in `started` events. */
  providerId: string;
  /** Executable to run: the CLI, or the interpreter when `entry` is set. */
  command: string;
  /** Script the `command` interpreter runs, placed before every other argument. */
  entry?: string;
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
  /**
   * Refuses a config override when this returns `true` for its normalized
   * key (lower case, no quotes or spaces), in addition to `configKeys`.
   */
  configKeyMatches?: (key: string) => boolean;
  /**
   * The CLI's one-letter flags that take no value (`-h`, `-p`). Both CLIs
   * read `-pw` as `-p -w`, so a cluster is split through these letters
   * before the match: `-pw` is refused when `-w` is pinned, while `-nwork`
   * (`-n` takes a value) is not.
   */
  booleanShortFlags?: readonly string[];
}

/**
 * Splits a cluster of one-letter flags (`-pvw`, `-hsx`) the way the CLIs'
 * parsers do: each letter that is a boolean flag stands alone, and the first
 * other letter takes the rest of the entry as its attached value.
 */
function expandShortCluster(
  arg: string,
  booleanShortFlags: readonly string[],
): readonly string[] {
  if (booleanShortFlags.length === 0 || !/^-[^-]./.test(arg)) {
    return [arg];
  }
  const parts: string[] = [];
  for (let index = 1; index < arg.length; index++) {
    const flag = `-${arg[index]}`;
    if (!booleanShortFlags.includes(flag)) {
      parts.push(`${flag}${arg.slice(index + 1)}`);
      break;
    }
    parts.push(flag);
  }
  return parts;
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
 * like a pinned flag is refused too, and a cluster of one-letter flags is
 * split through the CLI's boolean flags first (`-pw` is `-p -w`).
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
    for (const part of expandShortCluster(
      arg,
      pinned.booleanShortFlags ?? [],
    )) {
      if (pinned.flags.some((name) => flagValue(part, name) !== undefined)) {
        return arg;
      }
      for (const name of pinned.configFlags ?? []) {
        const attached = flagValue(part, name);
        if (attached === undefined) {
          continue;
        }
        const override = attached === "" ? (args[index + 1] ?? "") : attached;
        const key = configKeyOf(override);
        if (
          (pinned.configKeys ?? []).some(
            (pinnedKey) => key === pinnedKey || key.startsWith(`${pinnedKey}.`),
          ) ||
          pinned.configKeyMatches?.(key) === true
        ) {
          return attached === "" ? `${arg} ${override}` : arg;
        }
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
 * On Windows only a native `.exe`/`.com` file is an answer: a `.cmd` or
 * `.bat` file, an extensionless npm shell shim and a `.ps1` are skipped in
 * favor of a native file later in `PATH` (the spawn never runs a batch file);
 * when only a batch file
 * exists it is returned, and the spawn refuses it with
 * `EXTERNAL_AGENT_BATCH_COMMAND_REFUSED`.
 *
 * @param command - The configured command.
 * @param env - The child's environment, for `PATH` (and `PATHEXT` on Windows).
 * @param request - The run, for its working directory and `allowedPaths`.
 * @param host - Platform and file probes, for tests.
 * @returns The absolute path to start, the command itself when it has a path
 * separator, or `undefined` when no usable executable is left (the caller
 * reports `MISSING_BINARY`).
 * @internal
 */
export function resolveCliCommand(
  command: string,
  env: Record<string, string | undefined>,
  request: Pick<ExternalAgentRunRequest, "workingDirectory" | "permissions">,
  host: CliCommandHost = {},
): string | undefined {
  const platform = host.platform ?? process.platform;
  const windows = platform === "win32";
  const pathApi = windows ? win32 : posix;
  if (command.includes("/") || (windows && command.includes("\\"))) {
    return command;
  }
  const excluded = agentWritableRoots(request);
  const isFile = host.isExecutableFile ?? isExecutableFile;
  const searchable = host.isSearchable ?? isSearchableExecutable;
  const extensions = windows
    ? [...(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";"), ""]
    : [""];
  // A batch file is never the answer while a native one is on offer later in
  // `PATH`; the first one seen is kept, and returned only when no native file
  // exists, so the spawn refuses it with the Windows remedy instead of the
  // run reporting a missing binary.
  let batch: string | undefined;
  for (const dir of (env.PATH ?? "").split(pathApi.delimiter)) {
    // A relative or empty entry names a directory relative to the child's
    // working directory, which the agent controls: never searched.
    if (!pathApi.isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = pathApi.join(dir, `${command}${extension}`);
      if (!searchable(candidate, excluded) || !isFile(candidate)) {
        continue;
      }
      if (windows) {
        // Only a native file is an answer; an extensionless npm shell shim or
        // a `.ps1` is not runnable by itself and must not hide a native file
        // later in `PATH`. The spawn lookup applies the same filter.
        const kind = windowsExecutableKind(candidate);
        if (kind === "batch") {
          batch ??= candidate;
        }
        if (kind !== "native") {
          continue;
        }
      }
      return candidate;
    }
  }
  return batch;
}

/** The parts of {@link resolveCliCommand} that depend on the host, for tests. @internal */
export interface CliCommandHost {
  /** The platform to behave as. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether a path is an executable file. Defaults to a file-system check. */
  isExecutableFile?: (path: string) => boolean;
  /** Whether the lookup may use a candidate (outside the excluded roots). */
  isSearchable?: (path: string, excluded: readonly string[]) => boolean;
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
  /** Executable to run: the CLI, or the interpreter when `entry` is set. */
  readonly command: string;
  /** Script the `command` interpreter runs, when the driver was built with one. */
  readonly entry?: string;
  /** Arguments for the executable. */
  readonly args: readonly string[];

  /** @param config - Provider id, command, entry and arguments. */
  constructor(config: SubprocessJsonlDriverConfig) {
    // Each subclass checks its own keys before calling `super()`.
    if (new.target === SubprocessJsonlDriver) {
      assertKnownDriverOptions(
        "SubprocessJsonlDriver",
        config,
        SUBPROCESS_JSONL_OPTION_KEYS,
      );
    }
    this.providerId = config.providerId;
    this.command = config.command;
    if (config.entry !== undefined) {
      this.entry = config.entry;
    }
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
   * Parses one JSON line with a recognized external agent event tag.
   *
   * @remarks
   * Child-emitted `started`, `completed`, `state_delta` and transport
   * envelopes are ignored: they return an empty `output` event, carrying
   * none of the child payload, so a subclass's read loop continues safely.
   * `ExternalAgent` recognizes the internal placeholder by identity and
   * skips it before delegation, tracing or ADK processing. It produces no
   * message, turn completion or node output; real empty outputs still pass.
   * Other recognized event records retain their fields unchanged, except
   * `metadata`: a JSON object is kept under its `childMetadata` key only
   * (`EXTERNAL_AGENT_CHILD_METADATA_KEY`), so the child cannot set
   * or shadow a `customMetadata` key the bridge writes, and any other value
   * is dropped.
   * A subclass emits driver-owned events by yielding them from its own
   * `run`, never by accepting child lines.
   *
   * @param line - One line of subprocess output.
   * @returns The event.
   * @throws SyntaxError when the line is not JSON.
   * @throws Error when the JSON has no recognized external agent event tag.
   */
  parseLine(line: string): ExternalAgentEvent {
    const parsed = parseJson(line);
    if (!parsed.ok) {
      throw new SyntaxError(parsed.error);
    }
    const record = asRecord(parsed.value);
    if (bridgeEvent(record) === "drop" || record.type === "adk.bridge_event") {
      return IGNORED_CHILD_LINE;
    }
    if (!isExternalAgentEvent(parsed.value)) {
      throw new Error("Invalid external agent JSONL event");
    }
    const event = parsed.value;
    if (!("metadata" in event)) return event;
    const { metadata, ...rest } = event as ExternalAgentEvent & {
      metadata?: unknown;
    };
    const namespaced = childMetadata(metadata);
    return (
      namespaced ? { ...rest, metadata: namespaced } : rest
    ) as ExternalAgentEvent;
  }
}
