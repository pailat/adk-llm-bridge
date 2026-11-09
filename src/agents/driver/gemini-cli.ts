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
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  dependencyMissing,
  type ExternalAgentPolicyError,
  isCommandNotFound,
  networkUnenforceable,
  policyErrorEvent,
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
import { spawnSubprocess, superviseSubprocess } from "./spawn.js";
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

/** Options for {@link GeminiCliDriver}. */
export interface GeminiCliDriverConfig {
  /**
   * The Gemini executable.
   *
   * @defaultValue The command of the Gemini CLI provider (`gemini`).
   */
  command?: string;
  /**
   * Starts the process.
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
 * - The permission policy becomes approval-mode and sandbox flags (see
 *   {@link mapGeminiPermissionArgs}).
 * - The process gets an allowlisted environment (`PATH`, `HOME` and the
 *   credential keys the provider allows), never the whole of `process.env`.
 * - Aborting the run sends SIGTERM, then SIGKILL after `killGraceMs`; the
 *   process is also killed if the consumer stops reading.
 */
export class GeminiCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: GeminiCliSpawn;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #allowUnenforcedNetwork: boolean;

  /**
   * Creates a driver that runs the `gemini` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty or
   * `killGraceMs` is not a finite number of at least 0.
   */
  constructor(config: GeminiCliDriverConfig = {}) {
    validateDriverConfig("GeminiCliDriver", config);
    super({
      providerId: GEMINI_CLI_PROVIDER.id,
      command: config.command ?? GEMINI_CLI_PROVIDER.command ?? "gemini",
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#allowUnenforcedNetwork = config.allowUnenforcedNetwork ?? false;
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
   * with the policy code and `completed` with `exitCode: 1`. A non-zero exit
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
    const args = buildGeminiArgs(prompt, request.permissions);
    const env = buildGeminiEnv(this.#env, request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }
    const refusal = geminiNetworkRefusal(
      request.permissions,
      this.#allowUnenforcedNetwork,
    );
    if (refusal) {
      yield policyErrorEvent(refusal);
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }

    let child: GeminiCliSubprocess;
    try {
      child = this.#spawn(this.command, args, {
        cwd: request.workingDirectory,
        env,
      });
    } catch (error) {
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
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        const event = this.parseGeminiLine(line, toolNames);
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
      if (exitCode === 0) {
        yield { type: "completed", exitCode, timestamp: Date.now() };
        return;
      }

      yield exitErrorEvent({
        runtime: "Gemini CLI",
        exitCode,
        stderr: stderrLines,
        code: "GEMINI_CLI_EXIT",
      });
      yield { type: "completed", exitCode, timestamp: Date.now() };
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
   * @returns The event, or `undefined` for blank lines, non-JSON lines (logged
   * and skipped), echoed user messages and unknown event types.
   */
  parseGeminiLine(
    line: string,
    toolNames: Map<string, string> = new Map(),
  ): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    // A non-JSON line (a banner, a sandbox notice) or a JSON value that is not
    // an object (`null`, a number) must not end the run.
    if (!isJsonObject(parsed)) {
      warn(
        "GEMINI_CLI_NON_JSON_LINE",
        `Ignoring a non-JSON line from gemini --output-format stream-json: ${trimmed.slice(0, 200)}`,
      );
      return undefined;
    }
    return normalizeGeminiEvent(parsed as GeminiStreamEvent, toolNames);
  }
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
 * @returns `-p <prompt> --output-format stream-json` followed by the permission flags.
 */
export function buildGeminiArgs(
  prompt: string,
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  return [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
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
