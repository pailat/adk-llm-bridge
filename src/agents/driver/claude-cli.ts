import { warn } from "../../utils/log.js";
import type { ExternalAgentEvent } from "../events.js";
import {
  type ExternalAgentRunRequest,
  resolveAbortSignal,
} from "../external-agent-driver.js";
import { mapPermissionPolicyToFlags } from "../permissions/mapper.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { CLAUDE_PROVIDER } from "../provider/claude.js";
import type { AgentRuntimeCapabilities } from "../runtime/capabilities.js";
import {
  assertClaudeMessageIsolated,
  type ClaudeIsolationPlan,
  claudeCliIsolationArgs,
  planClaudeIsolation,
} from "./claude-isolation.js";
import { collectTail, type LineSource, readLines } from "./lines.js";
import {
  dependencyMissing,
  ExternalAgentPolicyError,
  isCommandNotFound,
  policyErrorEvent,
} from "./policy-errors.js";
import {
  claudeResultSummary,
  type ExternalAgentRunSummary,
} from "./run-summary.js";
import {
  asRecord,
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

/** The running `claude` process as the driver sees it. */
export interface ClaudeCliSubprocess {
  /** Standard output, read line by line as `stream-json`. */
  stdout?: LineSource | null;
  /** Standard error, collected to report a non-zero exit. */
  stderr?: LineSource | null;
  /**
   * Resolves with the exit code. May reject with a missing-binary error, which
   * the driver reports as a dependency error.
   */
  exited: Promise<number>;
  /**
   * Terminates the process. Called when the run is aborted or abandoned
   * before the process exited. Optional for custom spawns; the default spawn
   * always provides it. The driver sends SIGTERM first and, if the process
   * has not exited after `killGraceMs`, SIGKILL.
   */
  kill?: (signal?: NodeJS.Signals) => void;
}

/** Options the driver passes to a {@link ClaudeCliSpawn}. */
export interface ClaudeCliSpawnOptions {
  /** Working directory of the process. */
  cwd?: string;
  /**
   * Environment of the process. The driver builds it from an allowlist, so it
   * never carries the whole parent environment.
   */
  env?: Record<string, string>;
}

/** Source of output lines accepted by the driver, re-exported from `lines.ts`. */
export type { LineSource } from "./lines.js";

/** Function that starts the `claude` process; replaceable for tests. */
export type ClaudeCliSpawn = (
  command: string,
  args: readonly string[],
  options: ClaudeCliSpawnOptions,
) => ClaudeCliSubprocess;

/** Configuration of {@link ClaudeCliDriver}. */
export interface ClaudeCliDriverConfig {
  /**
   * Binary to run.
   *
   * @defaultValue `"claude"`
   */
  command?: string;
  /** Extra arguments appended after the ones the driver builds. */
  args?: readonly string[];
  /**
   * Custom process starter.
   *
   * @defaultValue a subprocess spawn that supports abort and kill
   */
  spawn?: ClaudeCliSpawn;
  /**
   * Environment the allowlisted variables (`PATH`, `HOME`, `USER`, `SHELL`,
   * Claude config dirs) are copied from.
   *
   * @defaultValue `process.env`
   */
  env?: Record<string, string | undefined>;
  /**
   * Milliseconds a cancelled process gets to exit after SIGTERM before it is
   * killed with SIGKILL.
   *
   * @defaultValue 2000 (applied by the process supervisor)
   */
  killGraceMs?: number;
  /**
   * Built-in Claude Code tools the agent gets (`--tools`). Defaults to
   * `DEFAULT_CLAUDE_TOOLS`, minus what the policy removes (write and shell
   * tools under `read-only`, web tools without network). Pass `[]` for none.
   *
   * @defaultValue `DEFAULT_CLAUDE_TOOLS`
   */
  tools?: readonly string[];
  /**
   * Opt-in: inherit the host's Claude Code configuration. When `true` the
   * driver does not pin the tool set (unless `tools` is set) and does not pass
   * `--strict-mcp-config`, `--setting-sources=`, `--disable-slash-commands` or
   * `disableClaudeAiConnectors`, and the isolation checks (the `init`
   * listing and each `tool_use`) are off.
   * Isolated by default, like `ClaudeAgentSdkDriver`.
   *
   * @defaultValue false
   */
  inheritHostConfig?: boolean;
  /**
   * Opt-in: without `allowNetwork: true`, run Bash without the no-network
   * sandbox. Without it the sandbox is on and the run fails at start where the
   * sandbox cannot run. With it, shell commands can reach the network.
   *
   * @defaultValue false
   */
  allowUnsandboxedShell?: boolean;
}

function claudeCliMissing(): ExternalAgentPolicyError {
  return dependencyMissing(
    "binary",
    "Claude Code (claude)",
    "npm install -g @anthropic-ai/claude-code",
    "set command to the path of the claude binary",
  );
}

/**
 * Runs Claude Code through its `claude -p --output-format stream-json` CLI and
 * maps the stream to {@link ExternalAgentEvent}s.
 *
 * @remarks
 * Security and lifecycle rules:
 * - Isolated by default: an explicit tool list, no MCP servers, settings files,
 *   skills or claude.ai connectors. Every stdout line is checked, and the run
 *   stops with an `EXTERNAL_AGENT_ISOLATION_VIOLATED` error event when the CLI
 *   reports, or the model is about to use, a tool outside the configured set.
 * - Without `allowNetwork: true` Bash runs in a no-network sandbox that fails
 *   the run at start where it cannot run, unless `allowUnsandboxedShell` is set.
 * - The child environment is an allowlist, never the whole parent environment.
 * - Abort stops the run: the process gets SIGTERM and, after `killGraceMs`,
 *   SIGKILL; the supervisor is always released.
 * - A missing binary becomes a policy error event with exit code 1.
 * - A non-zero exit becomes an `error` event with code `CLAUDE_CLI_EXIT`,
 *   carrying the stderr tail; auth, billing and quota failures are not
 *   recoverable.
 */
export class ClaudeCliDriver extends SubprocessJsonlDriver {
  readonly #spawn: ClaudeCliSpawn;
  readonly #env: Record<string, string | undefined>;
  readonly #killGraceMs: number | undefined;
  readonly #tools: readonly string[] | undefined;
  readonly #inheritHostConfig: boolean;
  readonly #allowUnsandboxedShell: boolean;

  /**
   * Creates a driver that runs the `claude` CLI.
   *
   * @param config - Driver options; all optional.
   * @throws InputValidationError (from `@google/adk`) when `command` is empty or
   * `killGraceMs` is not a finite number of at least 0.
   */
  constructor(config: ClaudeCliDriverConfig = {}) {
    validateDriverConfig("ClaudeCliDriver", config);
    super({
      providerId: CLAUDE_PROVIDER.id,
      command: config.command ?? CLAUDE_PROVIDER.command ?? "claude",
      args: config.args,
    });
    this.#spawn = config.spawn ?? spawnSubprocess;
    this.#env = config.env ?? process.env;
    this.#killGraceMs = config.killGraceMs;
    this.#tools = config.tools ? [...config.tools] : undefined;
    this.#inheritHostConfig = config.inheritHostConfig ?? false;
    this.#allowUnsandboxedShell = config.allowUnsandboxedShell ?? false;
  }

  /** Features this driver supports: it maps the permission policy onto CLI flags. It emits whole messages, not token deltas. */
  capabilities(): AgentRuntimeCapabilities {
    return { streaming: false, permissions: true };
  }

  /**
   * Starts `claude` for one request and streams its events.
   *
   * @param request - The run request (instruction, context, permissions,
   * credential, working directory and abort signal).
   * @returns Events starting with `started` and, unless aborted, ending with
   * `completed`. An aborted run ends without a `completed` event.
   */
  override async *run(
    request: ExternalAgentRunRequest,
  ): AsyncIterable<ExternalAgentEvent> {
    const isolation = this.isolationPlan(request);
    const args = this.buildArgs(request);
    const env = this.buildEnv(request);

    yield {
      type: "started",
      providerId: this.providerId,
      timestamp: Date.now(),
    };

    const signal = resolveAbortSignal(request);
    if (signal?.aborted) {
      return;
    }

    let child: ClaudeCliSubprocess;
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
      yield policyErrorEvent(claudeCliMissing());
      yield { type: "completed", exitCode: 1, timestamp: Date.now() };
      return;
    }
    const supervisor = superviseSubprocess(child, signal, {
      killGraceMs: this.#killGraceMs,
    });

    try {
      const stderrLines: string[] = [];
      const stderrPromise = child.stderr
        ? collectTail(child.stderr, stderrLines)
        : Promise.resolve();

      // Claude Code repeats the final assistant text in `result.result`.
      // Emit it only when no assistant text was streamed (as the SDK driver
      // does with `emittedOutput`), otherwise the answer appears twice.
      let emittedAssistantText = false;
      // The `result` line reports model, usage, cost, turns and duration;
      // they go on the `completed` event.
      let summary: ExternalAgentRunSummary = {};
      for await (const line of readLines(child.stdout)) {
        if (signal?.aborted) {
          return;
        }
        const raw = parseJsonLine(line);
        if (raw === undefined) {
          continue;
        }
        if (isolation.isolated) {
          // Fail closed when the CLI reports, or the model is about to use,
          // tools or MCP servers outside the configured set (a host or
          // managed setting added them).
          try {
            assertClaudeMessageIsolated(
              raw,
              { tools: isolation.tools ?? [], mcpServers: [] },
              "Claude CLI",
            );
          } catch (error) {
            if (error instanceof ExternalAgentPolicyError) {
              yield policyErrorEvent(error);
              yield {
                type: "completed",
                exitCode: 1,
                timestamp: Date.now(),
              };
              return;
            }
            throw error;
          }
        }
        const parsed = this.parseClaudeStreamLine(raw);
        if (!parsed) {
          continue;
        }
        if (parsed.source === "result") {
          summary = parsed.summary;
        }
        if (!parsed.event) {
          continue;
        }
        if (parsed.source === "assistant" && parsed.event.type === "output") {
          emittedAssistantText = true;
        }
        if (parsed.source === "result" && parsed.event.type === "output") {
          if (emittedAssistantText) {
            continue;
          }
          emittedAssistantText = true;
        }
        yield parsed.event;
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
        yield policyErrorEvent(claudeCliMissing());
        yield { type: "completed", exitCode: 1, timestamp: Date.now() };
        return;
      }
      supervisor.markExited();
      await stderrPromise;
      if (signal?.aborted) {
        return;
      }

      if (exitCode === 0) {
        yield {
          type: "completed",
          exitCode,
          ...summary,
          timestamp: Date.now(),
        };
        return;
      }

      yield exitErrorEvent({
        runtime: "Claude CLI",
        exitCode,
        stderr: stderrLines,
        code: "CLAUDE_CLI_EXIT",
      });
      yield { type: "completed", exitCode, ...summary, timestamp: Date.now() };
    } finally {
      supervisor.release();
    }
  }

  /**
   * CLI arguments for a request: prompt, output format, permission flags,
   * isolation flags, then the configured extra `args`.
   *
   * @param request - The run request.
   * @returns The argument list passed to the process.
   */
  buildArgs(request: ExternalAgentRunRequest): readonly string[] {
    return [
      "-p",
      promptFromRequest(request),
      "--output-format",
      "stream-json",
      "--verbose",
      ...mapClaudePermissionArgs(request.permissions),
      ...claudeCliIsolationArgs(this.isolationPlan(request)),
      ...this.args,
    ];
  }

  /**
   * The same isolation as `ClaudeAgentSdkDriver`: an explicit tool list,
   * no MCP servers, settings files, skills or claude.ai connectors, and the
   * no-network sandbox for Bash without `allowNetwork: true`.
   *
   * @param request - The run request; its permissions drive the plan.
   * @returns The plan for this run.
   */
  isolationPlan(request: ExternalAgentRunRequest): ClaudeIsolationPlan {
    return planClaudeIsolation(request.permissions, {
      tools: this.#tools,
      inheritHostConfig: this.#inheritHostConfig,
      allowUnsandboxedShell: this.#allowUnsandboxedShell,
    });
  }

  /**
   * Environment of the child process: only `PATH`, `HOME`, `USER`, `SHELL` and
   * the Claude config directories from the driver's environment, plus the
   * credential variables the provider allowlists when the credential is an
   * `env` one. Nothing else is inherited.
   *
   * @param request - The run request.
   * @returns The environment to pass to the process.
   */
  buildEnv(request: ExternalAgentRunRequest): Record<string, string> {
    // The config directories let Claude Code use its existing local
    // OAuth/native login cache without the bridge storing secrets.
    return buildChildEnv(
      this.#env,
      ["PATH", "HOME", "USER", "SHELL", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"],
      request,
    );
  }

  /**
   * Maps one `stream-json` line to an event.
   *
   * @param line - One stdout line.
   * @returns The event, or `undefined` for a blank line, a JSON value that is
   * not an object, or a diagnostic (`system`, `rate_limit_event`) that is not
   * shown.
   * @throws `SyntaxError` when the line is not valid JSON.
   */
  parseClaudeLine(line: string): ExternalAgentEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!isJsonObject(parsed)) {
      return undefined;
    }
    return normalizeClaudeEvent(parsed as ClaudeStreamEvent);
  }

  private parseClaudeStreamLine(raw: unknown):
    | {
        event: ExternalAgentEvent | undefined;
        source: ClaudeEventSource;
        summary: ExternalAgentRunSummary;
      }
    | undefined {
    const parsed = asRecord(raw) as ClaudeStreamEvent;
    const event = normalizeClaudeEvent(parsed);
    if (!event) {
      // A `result` line without text still reports the run summary.
      return parsed.type === "result"
        ? {
            event: undefined,
            source: "result",
            summary: claudeResultSummary(parsed),
          }
        : undefined;
    }
    const source: ClaudeEventSource =
      parsed.type === "assistant"
        ? "assistant"
        : parsed.type === "result" ||
            parsed.type === "completed" ||
            parsed.type === "complete"
          ? "result"
          : "other";
    return {
      event,
      source,
      summary: parsed.type === "result" ? claudeResultSummary(parsed) : {},
    };
  }
}

type ClaudeEventSource = "assistant" | "result" | "other";

/**
 * Parses one stdout line. Blank lines give `undefined`; a non-JSON line (a
 * banner or debug print) is logged and skipped instead of ending the run.
 */
function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    warn(
      "CLAUDE_CLI_NON_JSON_LINE",
      `Ignoring a non-JSON line from claude --output-format stream-json: ${trimmed.slice(0, 200)}`,
    );
    return undefined;
  }
}

type ClaudeStreamEvent = {
  type?: string;
  subtype?: string;
  message?: unknown;
  result?: string;
  text?: string;
  content?: unknown;
  name?: string;
  input?: unknown;
  tool_name?: string;
  tool_input?: unknown;
  error?: unknown;
  code?: unknown;
  session_id?: string;
  providerId?: string;
};

/**
 * Translates a permission policy into `claude` CLI flags.
 *
 * @remarks
 * `read-only` maps to `--permission-mode dontAsk`, `ask` to `manual`,
 * `workspace-write` to `acceptEdits` and `full-access` to `bypassPermissions`.
 * `dontAsk` denies every tool that would need a prompt; a tool that settings
 * pre-approve still runs. Read-only holds because the driver pins the read
 * tools (unless `inheritHostConfig` is set without `tools`), always removes
 * the write and shell tools, and denies `mcp__*`, so no write tool is left to
 * approve. `plan` is not
 * used: the CLI's plan mode runs a different model than `--model`.
 * Each allowed path becomes `--add-dir`.
 *
 * @param permissions - Policy of the run. Defaults to mode `ask`.
 * @returns The flag list.
 */
export function mapClaudePermissionArgs(
  permissions?: ExternalAgentPermissionPolicy,
): string[] {
  const policy = permissions ?? { mode: "ask" as const };
  const flags = mapPermissionPolicyToFlags(policy);
  const args: string[] = [];

  if (flags.readOnly) {
    args.push("--permission-mode", "dontAsk");
  } else if (flags.requireApproval) {
    args.push("--permission-mode", "manual");
  } else if (flags.workspaceWrite) {
    args.push("--permission-mode", "acceptEdits");
  } else if (flags.fullAccess) {
    args.push("--permission-mode", "bypassPermissions");
  } else {
    args.push("--permission-mode", "manual");
  }

  for (const path of flags.paths ?? []) {
    args.push("--add-dir", path);
  }

  return args;
}

function normalizeClaudeEvent(
  event: ClaudeStreamEvent,
): ExternalAgentEvent | undefined {
  const bridged = bridgeEvent(event as Record<string, unknown>);
  if (bridged !== undefined) {
    return bridged === "drop" ? undefined : bridged;
  }

  const type = event.type;
  if (type === "system" || type === "rate_limit_event") {
    // Claude Code stream-json emits lifecycle, hook, plugin, and rate-limit
    // diagnostics as system events. The bridge already emits a normalized
    // started/completed lifecycle, so suppress these diagnostics from chat text.
    return undefined;
  }

  if (type === "assistant" || type === "user") {
    const text = extractText(event.message ?? event.content ?? event.text);
    return text
      ? { type: "output", content: text, timestamp: Date.now() }
      : undefined;
  }

  if (type === "result" || type === "completed" || type === "complete") {
    // The run ends when the process exits, so a terminal line from the child
    // never becomes `completed`; only its final text is kept.
    const resultText = stringValue(event.result);
    return resultText
      ? { type: "output", content: resultText, timestamp: Date.now() }
      : undefined;
  }

  const toolName = stringValue(event.name) ?? stringValue(event.tool_name);
  if (toolName && (type === "tool_call" || type === "tool_use")) {
    return {
      type: "tool_call",
      name: toolName,
      input: event.input ?? event.tool_input,
      timestamp: Date.now(),
    };
  }

  if (type === "error") {
    const detail = isJsonObject(event.error) ? event.error : undefined;
    const message =
      (typeof event.error === "string" ? event.error : undefined) ??
      stringValue(detail?.message) ??
      stringValue(event.message) ??
      "Claude CLI error";
    const code = detail ? stringValue(detail.code) : stringValue(event.code);
    return {
      type: "error",
      message,
      code,
      recoverable: isRecoverableMessage(message),
      timestamp: Date.now(),
    };
  }

  const fallbackText = extractText(event);
  return fallbackText
    ? { type: "output", content: fallbackText, timestamp: Date.now() }
    : undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  const record = asRecord(value);
  const direct =
    stringValue(record.text) ??
    stringValue(record.content) ??
    stringValue(record.result) ??
    stringValue(record.message);
  if (direct) {
    return direct;
  }

  const arrayContent = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.parts)
      ? record.parts
      : undefined;
  if (arrayContent) {
    const parts = arrayContent
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((part) => extractText(part))
      .filter((part): part is string => typeof part === "string");
    if (parts.length > 0) {
      return parts.join("");
    }
  }

  return undefined;
}
