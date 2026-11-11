import { parseJson } from "../../utils/json.js";
import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import { networkAllowed } from "../permissions/network.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { GEMINI_CLI_PROVIDER } from "../provider/gemini-cli.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import { resolveCliLaunch, validateLaunchConfig } from "./launch.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  assertModelOption,
  envNameIn,
  GEMINI_MODEL_ENV,
  GEMINI_PLAN_MODE_REASON,
  MODEL_ALIAS_DENYLIST,
  modelEnvRefusal,
} from "./model.js";
import {
  batchCommandRefusal,
  dependencyMissing,
  EXTERNAL_AGENT_MODEL_OVERRIDE,
  ExternalAgentPolicyError,
  isCommandNotFound,
  networkUnenforceable,
  policyErrorEvent,
  sessionRefusal,
  unenforceablePathsRefusal,
} from "./policy-errors.js";
import {
  bridgeEvent,
  buildChildEnv,
  exitErrorEvent,
  isJsonObject,
  isRecoverableMessage,
  promptFromRequest,
  stringValue,
  validateDriverConfig,
} from "./shared.js";
import {
  BatchCommandRefusedError,
  spawnSubprocess,
  superviseSubprocess,
} from "./spawn.js";
import { SubprocessJsonlDriver } from "./subprocess-jsonl.js";

/** A running `gemini` process, as the driver sees it. */
export interface GeminiCliSubprocess {
  /** Output lines; the driver parses them as `--output-format stream-json` events. */
  stdout?: LineSource | null;
  /**
   * Diagnostics; drained so the process cannot block. The last lines become
   * the message of the error a non-zero exit reports.
   */
  stderr?: LineSource | null;
  /** Resolves with the exit code; may reject with `ENOENT` when the binary is missing. */
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. Optional for custom spawns; the default spawn
   * always provides it. The driver sends SIGTERM first and, if the process
   * has not exited after `killGraceMs`, SIGKILL.
   */
  kill?: (signal?: NodeJS.Signals) => void;
}

/** Options the driver passes to a {@link GeminiCliSpawn}. */
export interface GeminiCliSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * The complete environment of the process: an allowlisted copy (`PATH`,
   * `HOME` and the credential keys the provider allows), never the whole of
   * `process.env`.
   */
  env?: Record<string, string>;
}

/**
 * Starts the `gemini` process. Replace it in tests or to run Gemini elsewhere.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory and environment.
 * @returns The running process.
 */
export type GeminiCliSpawn = (
  command: string,
  args: readonly string[],
  options: GeminiCliSpawnOptions,
) => GeminiCliSubprocess;

/** Every `?: boolean` option of the driver config, checked when the driver is built. */
const GEMINI_CLI_BOOLEAN_OPTIONS = [
  "allowUnenforcedNetwork",
  "allowUnenforcedPaths",
  "requireExplicitModel",
] as const;

/** Options for {@link GeminiCliDriver}. */
export interface GeminiCliDriverConfig {
  /**
   * The Gemini executable.
   *
   * @defaultValue The command of the Gemini CLI provider (`gemini`).
   */
  command?: string;
  /**
   * Runs the CLI as `<interpreter> <entry> <flags>` instead of `command`, for
   * a CLI that ships as a JavaScript package (Gemini CLI on Windows, where
   * the npm `.cmd` shim is refused). Set it with `entry`, and leave
   * `command` unset.
   *
   * @remarks
   * Security invariants: with the built-in spawn a bare name is looked up
   * like a bare `command` (no `PATH` entry inside the run's working
   * directory or `allowedPaths`, no relative entry; on Windows a native
   * `.exe`/`.com` only, never a `.cmd` or `.bat`). An absolute path is used
   * as given, unless it is inside the run's working directory or an
   * `allowedPaths` root, which refuses the run with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE`. A relative path is rejected by the
   * constructor. Only Node is accepted: the interpreter's real path
   * (symlinks resolved) must be named `node` (`node.exe` on Windows) and be a
   * native executable (PE, Mach-O or ELF header; a script shim such as
   * asdf's or nodenv's is not), or the run is refused with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before any spawn, because other
   * interpreters (Bun, version-manager shims) load configuration from the
   * run's working directory, which the agent writes. The interpreter starts
   * in the entry's directory, never in the run's working directory, and a
   * fixed `--import` preload changes into it before the entry runs; a
   * custom spawn receives that `cwd`, the preload arguments and the
   * `ADK_LLM_BRIDGE_AGENT_CWD` variable and must keep them.
   *
   * @defaultValue unset: the driver runs `command`
   */
  interpreter?: string;
  /**
   * The script `interpreter` runs, as an absolute path: the file the CLI
   * package's `package.json` names under `bin`. It goes before every flag.
   *
   * @remarks
   * Security invariant: a run whose entry is at or under its working
   * directory, an `allowedPaths` root or a temp directory a runtime sandbox
   * keeps writable (symlinks resolved) is refused with
   * `EXTERNAL_AGENT_INTERPRETER_UNSAFE` before anything starts, with the
   * built-in spawn or a custom one: the agent could rewrite it and run code
   * on the host at the next run. With the built-in spawn a missing file is
   * `MISSING_BINARY`.
   *
   * @defaultValue unset
   */
  entry?: string;
  /**
   * Starts the process.
   *
   * With the built-in spawn a bare `command` is looked up on the child's
   * `PATH`, skipping every entry inside the run's working directory or
   * `allowedPaths` (see the class remarks). A custom spawn receives `command`
   * (or `interpreter`, with `entry` as the first argument) as given and does
   * its own lookup.
   *
   * @defaultValue The built-in spawn, which works on Bun and Node.
   */
  spawn?: GeminiCliSpawn;
  /**
   * Ambient environment to copy `PATH` and `HOME` from.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Milliseconds a cancelled process gets to exit after SIGTERM before it is
   * killed with SIGKILL.
   *
   * @defaultValue 2000
   */
  killGraceMs?: number;
  /**
   * Opt-in: run without `allowNetwork: true` although the driver cannot
   * enforce it. Without it every such run is refused with
   * `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE`, in every mode.
   *
   * @remarks
   * Gemini CLI's own web tools (`google_web_search`, `web_fetch`) and the
   * MCP servers in its settings run without the bridge's permission guard,
   * and its sandbox profiles do not reliably block the network. In
   * `full-access` there is no sandbox at all. With this opt-in the run
   * starts anyway and the network stays reachable.
   *
   * @defaultValue false
   */
  allowUnenforcedNetwork?: boolean;
  /**
   * Opt-in: run a policy with `allowedPaths` (or path bounds inherited from a
   * parent agent) although this driver cannot check tool paths against them.
   * Without it such a run is refused with
   * `EXTERNAL_AGENT_PATHS_UNENFORCEABLE`. With it, the runtime's own sandbox
   * alone decides which paths the agent reaches.
   *
   * @defaultValue false
   */
  allowUnenforcedPaths?: boolean;
  /**
   * Model id, sent as `--model=<id>` and reported as `gen_ai.request.model`.
   * A string of 1 to 256 characters without whitespace or control
   * characters, not starting with `-`; anything else is refused with
   * `EXTERNAL_AGENT_MODEL_INVALID` when the driver is built.
   *
   * @remarks
   * A read-only run (`--approval-mode=plan`) with a model is refused with
   * `EXTERNAL_AGENT_MODEL_OVERRIDE`: plan mode may route turns to another
   * model than `--model`. Run read-only without a model, or use another
   * mode.
   *
   * @defaultValue the model of the host `~/.gemini/settings.json`, or Gemini
   * CLI's default
   */
  model?: string;
  /**
   * Refuse to build the driver without a `model`, or with a router alias
   * (`auto`, `auto-*`): `EXTERNAL_AGENT_MODEL_REQUIRED`.
   *
   * @defaultValue false
   */
  requireExplicitModel?: boolean;
}

function geminiCliMissing(): ExternalAgentPolicyError {
  return dependencyMissing(
    "binary",
    "The Gemini CLI (gemini)",
    "npm install -g @google/gemini-cli",
    "set command to the path of the gemini binary",
  );
}

/**
 * Gemini CLI cannot be kept off the network (see
 * `GeminiCliDriverConfig.allowUnenforcedNetwork`), so a run whose policy
 * forbids it is refused unless the driver opted in.
 */
function geminiNetworkRefusal(
  policy: ExternalAgentPermissionPolicy | undefined,
  allowUnenforcedNetwork: boolean,
): ExternalAgentPolicyError | undefined {
  if (networkAllowed(policy) || allowUnenforcedNetwork) {
    return undefined;
  }
  return networkUnenforceable(
    "Gemini CLI cannot keep the network off, and network is off unless the policy sets allowNetwork: true: its web tools and MCP servers run outside the bridge's permission guard, and its sandbox does not reliably block the network. Set allowNetwork: true in the agent's permissions, use another runtime, or build the driver with allowUnenforcedNetwork: true to run anyway.",
  );
}

/**
 * Runs an external agent through the `gemini` CLI in `stream-json` mode.
 *
 * @remarks
 * Security and lifecycle invariants:
 * - Fail closed: Gemini CLI cannot be kept off the network, so any run whose
 *   policy does not set `allowNetwork: true` (including an unset value or no
 *   policy) is refused with `EXTERNAL_AGENT_NETWORK_UNENFORCEABLE` (in every
 *   mode) unless `allowUnenforcedNetwork` is set. A missing binary
 *   ends the run with `MISSING_BINARY`. Refusals are events, not exceptions.
 * - Gemini CLI runs file tools without asking the bridge, so a policy with
 *   `allowedPaths` (or inherited path bounds) is refused with
 *   `EXTERNAL_AGENT_PATHS_UNENFORCEABLE` unless `allowUnenforcedPaths` is set.
 * - The permission policy becomes approval-mode and sandbox flags (see
 *   {@link mapGeminiPermissionArgs}).
 * - With the built-in spawn a bare `command` never resolves through a `PATH`
 *   entry inside the run's working directory or `allowedPaths`, or a
 *   relative one (see `resolveCliCommand`); when nothing is left the run ends
 *   with `MISSING_BINARY`.
 * - The process gets an allowlisted environment (`PATH`, `HOME` and the
 *   credential keys the provider allows), never the whole of `process.env`.
 * - Aborting the run sends SIGTERM, then SIGKILL after `killGraceMs`; the
 *   process is also killed if the consumer stops reading.
 */
export class GeminiCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: GeminiCliSpawn;
  readonly #builtInSpawn: boolean;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #allowUnenforcedNetwork: boolean;
  readonly #allowUnenforcedPaths: boolean;
  readonly #model: string | undefined;
  readonly #requireExplicitModel: boolean;

  /**
   * Creates a driver that runs the `gemini` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty or
   * `killGraceMs` is not a finite number of at least 0.
   * @throws InputValidationError (from `@google/adk`) when a boolean option
   * (see the config's `?: boolean` fields) is set to a non-boolean value such
   * as the string `"false"`.
   * @throws {@link ExternalAgentPolicyError} with code
   * `EXTERNAL_AGENT_MODEL_INVALID` when `model` is not a model id, and
   * `EXTERNAL_AGENT_MODEL_REQUIRED` when `requireExplicitModel` is set and
   * `model` is absent or a router alias.
   */
  constructor(config: GeminiCliDriverConfig = {}) {
    validateDriverConfig("GeminiCliDriver", config, GEMINI_CLI_BOOLEAN_OPTIONS);
    validateLaunchConfig("GeminiCliDriver", config);
    const model = assertModelOption(
      "GeminiCliDriver",
      config.model,
      config.requireExplicitModel ?? false,
      MODEL_ALIAS_DENYLIST["gemini-cli"],
    );
    super({
      providerId: GEMINI_CLI_PROVIDER.id,
      command:
        config.interpreter ??
        config.command ??
        GEMINI_CLI_PROVIDER.command ??
        "gemini",
      entry: config.entry,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#builtInSpawn = config.spawn === undefined;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#allowUnenforcedNetwork = config.allowUnenforcedNetwork ?? false;
    this.#allowUnenforcedPaths = config.allowUnenforcedPaths ?? false;
    this.#model = model;
    this.#requireExplicitModel = config.requireExplicitModel ?? false;
  }

  /** The configured model id (`gen_ai.request.model`), if any. */
  get model(): string | undefined {
    return this.#model;
  }

  /**
   * `false`: the model of Gemini's `init` line goes on `completed.model` for
   * diagnostics, but is not trusted as the model the run used.
   */
  get reportsResolvedModel(): boolean {
    return false;
  }

  /** Features this driver supports: streaming output and the permission policy mapped onto CLI flags. */
  capabilities(): AgentRuntimeCapabilities {
    return { streaming: true, permissions: true };
  }

  /**
   * Spawns `gemini` for one turn and streams normalized events.
   *
   * @remarks
   * The stream starts with `started`. A refused run yields one `error` event
   * with the policy code and `completed` with `exitCode: 1`. A
   * `request.runtimeSession` is refused first (`EXTERNAL_AGENT_SESSIONS_UNSUPPORTED`,
   * this driver cannot resume), then a model variable
   * (`GEMINI_MODEL`) in the run's environment, then a
   * read-only run (plan mode) with a model or `requireExplicitModel`, both
   * with `EXTERNAL_AGENT_MODEL_OVERRIDE`. A read-only run without a model
   * starts with `modelRouting: "plan-mode"` on `started`. A non-zero exit
   * yields a `GEMINI_CLI_EXIT` error carrying the stderr tail before
   * `completed`; it is recoverable unless the text reports an auth, billing,
   * quota or missing-binary failure. If the
   * abort signal fires, the stream ends without a `completed` event after the
   * process is killed. Spawn errors other than a missing binary are thrown.
   *
   * @param request - The run; the prompt is its `instruction` followed by
   *   the user turn's text.
   * @returns Events in order.
   */
  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const prompt = promptFromRequest(request);
    const args = buildGeminiArgs(prompt, request.permissions, this.#model);
    const env = buildGeminiEnv(this.#env, request);
    const envRefusal = modelEnvRefusal(
      "GeminiCliDriver",
      env,
      envNameIn(GEMINI_MODEL_ENV),
    );
    const planMode = isGeminiPlanMode(request.permissions);
    const planModeRefused =
      planMode && (this.#model !== undefined || this.#requireExplicitModel);

    yield {
      type: "started",
      providerId: this.providerId,
      ...(planMode && !planModeRefused && envRefusal === undefined
        ? { modelRouting: "plan-mode" as const }
        : {}),
      timestamp: Date.now(),
    };

    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }
    const refusal =
      sessionRefusal("GeminiCliDriver", request) ??
      envRefusal ??
      (planModeRefused
        ? new ExternalAgentPolicyError(
            EXTERNAL_AGENT_MODEL_OVERRIDE,
            `GeminiCliDriver: ${GEMINI_PLAN_MODE_REASON}, so the model the bridge reports could be wrong. Run read-only without a model, or use the ask or workspace-write mode (both let the agent write files).`,
          )
        : undefined) ??
      unenforceablePathsRefusal(request.permissions, {
        runtime: "Gemini CLI",
        allowUnenforcedPaths: this.#allowUnenforcedPaths,
      }) ??
      geminiNetworkRefusal(request.permissions, this.#allowUnenforcedNetwork);
    if (refusal) {
      yield policyErrorEvent(refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }

    const resolved = resolveCliLaunch({
      command: this.command,
      entry: this.entry,
      env,
      request,
      builtInSpawn: this.#builtInSpawn,
      missing: geminiCliMissing,
    });
    if ("refusal" in resolved) {
      yield policyErrorEvent(resolved.refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const { launch } = resolved;
    let child: GeminiCliSubprocess;
    try {
      child = this.#spawn(launch.command, [...launch.prefix, ...args], {
        cwd: launch.cwd ?? request.workingDirectory,
        env: launch.env ? { ...env, ...launch.env } : env,
      });
    } catch (error) {
      if (error instanceof BatchCommandRefusedError) {
        yield policyErrorEvent(batchCommandRefusal(error, "gemini"));
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      // Bun.spawn throws when the binary does not exist.
      if (!isCommandNotFound(error)) {
        throw error;
      }
      yield policyErrorEvent(geminiCliMissing());
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const supervisor = superviseSubprocess(child, signal, {
      killGraceMs: this.#killGraceMs,
    });

    try {
      // Drain stderr while stdout is read so the process cannot block; the
      // tail explains a non-zero exit.
      const stderrLines: string[] = [];
      const stderrPromise = collectTail(child.stderr, stderrLines).catch(
        () => undefined,
      );

      const toolNames = new Map<string, string>();
      const seen: GeminiRunState = {};
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        const event = this.parseGeminiLine(line, toolNames, seen);
        if (event) {
          yield event;
        }
      }
      if (signal?.aborted) {
        return;
      }

      let exitCode: number;
      try {
        exitCode = await child.exited;
      } catch (error) {
        // Node reports a missing binary through `exited`.
        supervisor.markExited();
        if (!isCommandNotFound(error)) {
          throw error;
        }
        yield policyErrorEvent(geminiCliMissing());
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      supervisor.markExited();
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }
      // The init model is for diagnostics: reportsResolvedModel is false.
      const model =
        seen.initModel === undefined ? {} : { model: seen.initModel };
      if (exitCode === 0) {
        yield { type: "completed", exitCode, ...model, timestamp: Date.now() };
        return;
      }

      yield exitErrorEvent({
        runtime: "Gemini CLI",
        exitCode,
        stderr: stderrLines,
        code: "GEMINI_CLI_EXIT",
      });
      yield { type: "completed", exitCode, ...model, timestamp: Date.now() };
    } finally {
      supervisor.release();
    }
  }

  /**
   * Parses one `stream-json` line.
   *
   * @param line - One line of stdout.
   * @param toolNames - Tool ids seen so far, to name later `tool_result`
   * events; the driver passes one map per run.
   * @param seen - Run state the line may fill in: the `init` line's model.
   * @returns The event, or `undefined` for blank lines, non-JSON lines (logged
   * and skipped), echoed user messages and unknown event types.
   */
  parseGeminiLine(
    line: string,
    toolNames: Map<string, string> = new Map(),
    seen: GeminiRunState = {},
  ): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    const result = parseJson(trimmed);
    const parsed = result.ok ? result.value : undefined;
    // A non-JSON line (a banner, a sandbox notice) or a JSON value that is not
    // an object (`null`, a number) must not end the run.
    if (!isJsonObject(parsed)) {
      warn(
        "GEMINI_CLI_NON_JSON_LINE",
        `Ignoring a non-JSON line from gemini --output-format stream-json: ${trimmed.slice(0, 200)}`,
      );
      return undefined;
    }
    if (parsed.type === "init" && seen.initModel === undefined) {
      seen.initModel = stringValue(parsed.model);
    }
    return normalizeGeminiEvent(parsed as GeminiStreamEvent, toolNames);
  }
}

/** What a Gemini CLI run reads from its output besides events. */
export interface GeminiRunState {
  /** The `model` of the `init` line. */
  initModel?: string;
}

/**
 * Whether a policy maps to Gemini's plan mode (`--approval-mode=plan`, the
 * read-only mapping).
 */
function isGeminiPlanMode(
  permissions: ExternalAgentPermissionPolicy | undefined,
): boolean {
  return (
    mapPermissionPolicyToFlags(permissions ?? { mode: "ask" }).readOnly === true
  );
}

type GeminiStreamEvent = {
  type?: string;
  event?: string;
  role?: string;
  status?: string;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  output?: string;
  severity?: string;
  text?: string;
  content?: string;
  message?: string;
  name?: string;
  input?: unknown;
  toolCall?: { name?: string; input?: unknown };
  error?: unknown;
  code?: unknown;
  providerId?: string;
};

/**
 * Builds the `gemini` arguments for a prompt.
 *
 * @param prompt - The prompt text.
 * @param permissions - The policy; see {@link mapGeminiPermissionArgs}.
 * @param model - The model id, if any.
 * @returns `--prompt=<prompt> --output-format stream-json`, then
 * `--model=<model>` when a model is given, then the permission flags. The
 * prompt and the model are joined to their flags, so a value that starts
 * with `-` (for example `--yolo`) is never read as a flag.
 */
export function buildGeminiArgs(
  prompt: string,
  permissions?: ExternalAgentPermissionPolicy,
  model?: string,
): string[] {
  return [
    `--prompt=${prompt}`,
    "--output-format",
    "stream-json",
    ...(model === undefined ? [] : [`--model=${model}`]),
    ...mapGeminiPermissionArgs(permissions),
  ];
}

/**
 * Maps a permission policy to Gemini CLI approval and sandbox flags.
 *
 * @remarks
 * `read-only` uses plan mode, `ask` uses default approvals and
 * `workspace-write` uses auto-edit, all with `--sandbox`. `full-access` uses
 * `yolo` with no sandbox. Each allowed path adds `--include-directories`.
 * The sandbox does not reliably block the network, which is why the driver
 * refuses runs without `allowNetwork: true` instead of relying on it.
 *
 * @param permissions - The policy; when omitted the `ask` mode applies.
 * @returns The permission arguments.
 */
export function mapGeminiPermissionArgs(
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);
  const args: string[] = [];

  if (flags.readOnly) {
    args.push("--approval-mode=plan", "--sandbox");
  } else if (flags.requireApproval) {
    args.push("--approval-mode=default", "--sandbox");
  } else if (flags.workspaceWrite) {
    args.push("--approval-mode=auto_edit", "--sandbox");
  } else if (flags.fullAccess) {
    args.push("--approval-mode=yolo");
  } else {
    args.push("--approval-mode=default", "--sandbox");
  }

  for (const path of flags.paths ?? []) {
    args.push("--include-directories", path);
  }

  return args;
}

function buildGeminiEnv(
  processEnv: Record<string, string | undefined>,
  request: ExternalAgentRunRequest,
): Record<string, string> {
  return buildChildEnv(processEnv, ["PATH", "HOME"], request);
}

function normalizeGeminiEvent(
  event: GeminiStreamEvent,
  toolNames: Map<string, string> = new Map(),
): ExternalAgentEvent | undefined {
  // `gemini --output-format stream-json` (core/src/output/types.ts) emits
  // init | message | tool_use | tool_result | error | result. A `message`
  // with role "user" echoes the prompt; it is not model output.
  if (isGeminiNativeEvent(event)) {
    return normalizeGeminiNativeEvent(event, toolNames);
  }

  const bridged = bridgeEvent(event as Record<string, unknown>);
  if (bridged !== undefined) {
    return bridged === "drop" ? undefined : bridged;
  }

  const type = event.type ?? event.event;

  if (type === "content" || type === "output" || type === "message") {
    const content = event.text ?? event.content ?? event.message;
    return typeof content === "string"
      ? { type: "output", content, timestamp: Date.now() }
      : undefined;
  }

  if (type === "tool_call" || type === "tool-call") {
    const name = event.name ?? event.toolCall?.name;
    if (typeof name === "string") {
      return {
        type: "tool_call",
        name,
        input: event.input ?? event.toolCall?.input,
        timestamp: Date.now(),
      };
    }
  }

  if (type === "error") {
    const detail = isJsonObject(event.error) ? event.error : undefined;
    const message =
      (typeof event.error === "string" ? event.error : undefined) ??
      stringValue(detail?.message) ??
      stringValue(event.message) ??
      "Gemini CLI error";
    const code = detail ? stringValue(detail.code) : stringValue(event.code);
    return {
      type: "error",
      message,
      code,
      recoverable: isRecoverableMessage(message),
      timestamp: Date.now(),
    };
  }

  // A terminal line (`result`, `complete`) from the child is ignored: the run
  // ends when the process exits, and the driver emits `completed` then.
  return undefined;
}

function isGeminiNativeEvent(event: GeminiStreamEvent): boolean {
  const e = event as {
    type?: string;
    role?: unknown;
    severity?: unknown;
    status?: unknown;
  };
  return (
    e.type === "tool_use" ||
    e.type === "tool_result" ||
    e.type === "init" ||
    (e.type === "message" && typeof e.role === "string") ||
    (e.type === "error" && typeof e.severity === "string") ||
    (e.type === "result" && typeof e.status === "string")
  );
}

function normalizeGeminiNativeEvent(
  event: GeminiStreamEvent,
  toolNames: Map<string, string>,
): ExternalAgentEvent | undefined {
  const e = event as Exclude<GeminiStreamEvent, ExternalAgentEvent>;
  switch (e.type) {
    case "message":
      if (e.role !== "assistant" || typeof e.content !== "string") {
        return undefined;
      }
      return { type: "output", content: e.content, timestamp: Date.now() };
    case "tool_use": {
      if (typeof e.tool_name !== "string") {
        return undefined;
      }
      if (typeof e.tool_id === "string") {
        toolNames.set(e.tool_id, e.tool_name);
      }
      return {
        type: "tool_call",
        name: e.tool_name,
        input: e.parameters,
        callId: e.tool_id,
        timestamp: Date.now(),
      };
    }
    case "tool_result": {
      const errorMessage = isJsonObject(e.error)
        ? stringValue(e.error.message)
        : stringValue(e.error);
      return {
        type: "tool_result",
        name:
          (typeof e.tool_id === "string" && toolNames.get(e.tool_id)) ||
          "unknown",
        result: e.output,
        callId: e.tool_id,
        error:
          e.status === "error"
            ? (errorMessage ?? "Tool execution failed")
            : undefined,
        timestamp: Date.now(),
      };
    }
    case "error":
      return {
        type: "error",
        message: typeof e.message === "string" ? e.message : "Gemini CLI error",
        recoverable: e.severity !== "error",
        timestamp: Date.now(),
      };
    case "result": {
      if (e.status === "error") {
        const err = isJsonObject(e.error) ? e.error : undefined;
        return {
          type: "error",
          message: stringValue(err?.message) ?? "Gemini CLI run failed",
          code: stringValue(err?.type),
          recoverable: false,
          timestamp: Date.now(),
        };
      }
      // Success is reported by the driver once the process exits.
      return undefined;
    }
    default:
      return undefined;
  }
}
