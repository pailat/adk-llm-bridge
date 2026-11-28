import { type Event, InvocationContext, PluginManager } from "@google/adk";
import type { Content } from "@google/genai";
import {
  type AgentInvocationErrorKind,
  AgentInvocationGateway,
  type AgentInvocationResult,
} from "../runtime/agent-invocation-gateway.js";
import { parseJson } from "../utils/json.js";
import { claudeSdkSessionStateKey } from "./driver/claude-agent-sdk.js";
import { fxSessionStateKey } from "./driver/fx-cli.js";
import {
  EXTERNAL_AGENT_RUN_METADATA_KEY,
  type ExternalAgentRunReport,
} from "./events.js";
import type { ExternalAgent } from "./external-agent.js";

/**
 * Machine-readable classification of a failed {@link AgentRunOutcome}: the
 * gateway's kinds, plus:
 * - `interrupted`: the run stopped waiting for a human or an external system
 *   (an approval, a long-running tool). A one-shot run cannot answer it.
 * - `invalid-output`: the agent has an `outputSchema` and its final answer
 *   (or the driver's structured output) is empty or not JSON.
 */
export type AgentRunErrorKind =
  | AgentInvocationErrorKind
  | "interrupted"
  | "invalid-output";

/** Why a run failed, as far as the runtime or the helper tells. */
export interface AgentRunFailureCause {
  /** Human-readable message. */
  message: string;
  /** `errorCode` of the run's last error event, when it had one. */
  code?: string;
}

/** Token counters of one run, as the runtime reported them. */
export interface AgentRunTokens {
  /** Prompt tokens, cache reads and cache writes included. */
  input: number;
  /** Tokens the model generated. */
  output: number;
  /** Prompt tokens read from the prompt cache. */
  cacheRead: number;
  /** Prompt tokens written to the prompt cache, when reported. */
  cacheCreation?: number;
  /** `input + output`, as reported. */
  total: number;
}

/** Usage of one run. */
export interface AgentRunUsage {
  /**
   * US dollars the runtimes reported; see `scope`. With scope `"run"` (or
   * none) it sums the run-scoped costs of the agent and of the sub-agents it
   * delegated to. With scope `"session"` it is the agent's own session total
   * only, sub-agents' costs not included. Absent when none was reported.
   */
  costUsd?: number;
  /** Model turns the agent's runtime reported. Absent when it reported none. */
  turns?: number;
  /** Token counters, delegated sub-agents included; zeros when none were reported. */
  tokens: AgentRunTokens;
  /**
   * The agent's own scope: `"session"` when its cost and tokens are the runtime session's total
   * so far (a run that resumed a session this process did not run before),
   * `"run"` when they cover this run only. Absent when the driver did not say.
   */
  scope?: "run" | "session";
}

/** Result of {@link runExternalAgentOnce}; failures are reported, not thrown. */
export interface AgentRunOutcome {
  /**
   * The final answer parsed as JSON, when the agent has an `outputSchema`
   * (integers beyond `Number.MAX_SAFE_INTEGER` are strings of their digits)
   * or the driver marked the answer as its structured output
   * (`metadata.structuredOutput`, for example `ClaudeAgentSdkDriver`'s
   * `outputSchema`; read with `JSON.parse`). Not validated against the
   * schema here: the driver checks it when it supports one. A driver-level
   * schema the driver does not mark (Codex SDK `outputSchema`) is not seen:
   * set the agent's `outputSchema` too.
   */
  structured?: unknown;
  /**
   * Text of the final answer: the agent's last event with content, when it
   * is text. Empty when the run ended on a tool call or result, or had no
   * text (a tool's output or an error message is never the answer).
   */
  text: string;
  /** Cost, turns and tokens of the run. */
  usage: AgentRunUsage;
  /**
   * The agent's runtime session id, as its driver reported it for this run:
   * the value stored under the agent's session state key
   * (`claude_sdk_session:<agent>` for Claude) or the session the driver says
   * the run kept on its `completed` event, a resumed one included
   * (`ClaudeAgentSdkDriver`, `CodexSdkDriver`, `FxCliDriver`). Pass it as
   * `sessionId` to resume that session. A delegated sub-agent's session is
   * never returned.
   *
   * On success it is absent only when the driver resumes nothing
   * (`ClaudeCliDriver`, `CodexCliDriver`, a Claude SDK run with an MCP
   * server secret): when you passed a `sessionId` and get none or another
   * one back, that session was not resumed. A run that failed or was
   * aborted returns the session only when the driver named it before it
   * stopped (Claude SDK: from its first message; Codex SDK: a new thread,
   * not a resumed one, after an abort). Its absence there does not mean the
   * session is gone: the id you passed is still yours to retry with.
   */
  sessionId?: string;
  /**
   * Classification of the failure; absent on success. An error event the
   * run went on after (a permission denial, a session store mirror error)
   * is not a failure when the runtime exited with 0 and an answer follows.
   */
  errorKind?: AgentRunErrorKind;
  /** Details of the failure; present exactly when `errorKind` is. */
  cause?: AgentRunFailureCause;
}

/** Options of {@link runExternalAgentOnce}. */
export interface RunExternalAgentOnceOptions {
  /** The user turn: plain text, or a `user` content. */
  prompt: string | Content;
  /** Aborts the run. The driver stops the runtime and its child process. */
  signal?: AbortSignal;
  /** A {@link AgentRunOutcome.sessionId} of an earlier run, to resume it. */
  sessionId?: string;
  /**
   * Session state key the driver keeps its session id under. Defaults to
   * the key of the agent's provider: `claude_sdk_session:<name>` (Claude),
   * `codex_thread:<name>` (Codex, unless its driver sets `threadStateKey`)
   * and `fx_session:<name>` (fx).
   */
  sessionStateKey?: string;
  /** JSON-safe state the run's session starts with. */
  state?: Readonly<Record<string, unknown>>;
}

const APP_NAME = "adk-llm-bridge";
const USER_ID = "user";

/**
 * Runs an external agent for one prompt and returns its answer, usage and
 * session id, without an ADK `Runner`.
 *
 * @remarks
 * The run goes through {@link AgentInvocationGateway} under a parent
 * invocation context the helper builds, with a fresh in-memory session. To
 * continue a runtime session, pass the returned `sessionId` back: it is
 * written to the session state key the driver resumes from, so a new agent
 * instance (another process, after a restart) resumes it too, from the
 * driver's `sessionStore` when it has one. Session ids are trusted as given.
 *
 * @param agent - The agent to run.
 * @param options - Prompt, abort signal and session to resume.
 * @returns The outcome. Agent errors, aborts and interrupts are reported in
 * `errorKind` and `cause`, not thrown.
 */
export async function runExternalAgentOnce(
  agent: ExternalAgent,
  options: RunExternalAgentOnceOptions,
): Promise<AgentRunOutcome> {
  const stateKey = options.sessionStateKey ?? defaultSessionStateKey(agent);
  const input = toUserContent(options.prompt);
  const parentContext = new InvocationContext({
    invocationId: `run-once-${crypto.randomUUID()}`,
    agent,
    userContent: input,
    session: {
      id: crypto.randomUUID(),
      appName: APP_NAME,
      userId: USER_ID,
      state: {
        ...options.state,
        ...(stateKey && options.sessionId
          ? { [stateKey]: options.sessionId }
          : {}),
      },
      events: [],
      lastUpdateTime: Date.now(),
    },
    pluginManager: new PluginManager(),
    abortSignal: options.signal,
  });
  const gateway = new AgentInvocationGateway({ resolveAgent: () => agent });
  const result = await gateway.run({
    agentName: agent.name,
    input,
    parentContext,
  });
  return toOutcome(agent, result, stateKey);
}

function defaultSessionStateKey(agent: ExternalAgent): string | undefined {
  switch (agent.provider.id) {
    case "claude":
      return claudeSdkSessionStateKey(agent.name);
    case "codex":
      return `codex_thread:${agent.name}`;
    case "fx":
      return fxSessionStateKey(agent.name);
    default:
      return undefined;
  }
}

function toUserContent(prompt: string | Content): Content {
  return typeof prompt === "string"
    ? { role: "user", parts: [{ text: prompt }] }
    : prompt;
}

function toOutcome(
  agent: ExternalAgent,
  result: AgentInvocationResult,
  stateKey: string | undefined,
): AgentRunOutcome {
  const report = runReport(agent, result.events);
  // Only an id the driver reported for this run: a resumed id is not echoed
  // back unless the driver says it kept that session.
  const stored = stateKey ? result.stateDelta?.[stateKey] : undefined;
  const sessionId =
    typeof stored === "string" && stored.length > 0
      ? stored
      : report.sessionId || undefined;
  const answer = finalAnswer(agent, result.events);
  const text = answer?.text ?? "";
  const base: AgentRunOutcome = {
    text,
    usage: usageOf(result, report),
    ...(sessionId ? { sessionId } : {}),
  };
  if (result.error && !recovered(result, report, answer)) {
    return {
      ...base,
      errorKind: result.errorKind ?? "agent-error",
      cause: causeOf(result),
    };
  }
  if (result.interrupt) {
    return {
      ...base,
      errorKind: "interrupted",
      cause: {
        message: `${agent.name} is waiting for ${result.interrupt.kind} input, which a one-shot run cannot give.`,
      },
    };
  }
  if (!agent.outputSchema && !answer?.structured) return base;
  const parsed = text.trim()
    ? parseAnswer(text, answer?.structured)
    : undefined;
  if (!parsed?.ok) {
    return {
      ...base,
      errorKind: "invalid-output",
      cause: {
        message: `${agent.name} has an output schema, but its final answer is not JSON.`,
      },
    };
  }
  return { ...base, structured: parsed.value };
}

/** The final answer of a run: its text, and whether the driver marked it structured. */
interface FinalAnswer {
  text: string;
  structured: boolean;
  index: number;
}

/**
 * The visible text of the agent's last non-partial event with content, when
 * that event is text: not a function call or result (tool output is not the
 * answer), not thought, not an error. `undefined` when the run ended on
 * something else or had no text. Content-less events (state, usage, errors)
 * are skipped.
 */
function finalAnswer(
  agent: ExternalAgent,
  events: readonly Event[],
): FinalAnswer | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event || event.partial || event.author !== agent.name) continue;
    const parts = event.content?.parts ?? [];
    if (parts.length === 0) continue;
    if (event.errorCode) return undefined;
    if (parts.some((part) => part.functionCall || part.functionResponse)) {
      return undefined;
    }
    const text = parts
      .filter((part) => part.thought !== true && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (!text) return undefined;
    return {
      text,
      structured: event.customMetadata?.structuredOutput === true,
      index,
    };
  }
  return undefined;
}

/**
 * The answer parsed as JSON. A driver's structured output is the JSON of a
 * value the runtime already parsed, so it is read with `JSON.parse`, as the
 * agent's node output is; text under an `outputSchema` keeps integers beyond
 * `Number.MAX_SAFE_INTEGER` exact, as strings.
 */
function parseAnswer(
  text: string,
  structured: boolean | undefined,
): { ok: true; value: unknown } | { ok: false } {
  if (!structured) return parseJson(text);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Whether the run's errors were non-fatal: the runtime ended with exit code
 * 0, the error is the gateway's record of an error event (not a thrown
 * error, an abort or a timeout), and a final answer follows every error
 * event. A permission denial or a session store mirror error the run went
 * on after is such a case; an error after the answer (for example the
 * bridge failing the turn closed) is not.
 */
function recovered(
  result: AgentInvocationResult,
  report: ExternalAgentRunReport,
  answer: FinalAnswer | undefined,
): boolean {
  if (report.exitCode !== 0 || !answer) return false;
  if ((result.errorKind ?? "agent-error") !== "agent-error") return false;
  let lastError = -1;
  for (let index = result.events.length - 1; index >= 0; index--) {
    if (result.events[index]?.errorMessage) {
      lastError = index;
      break;
    }
  }
  return (
    lastError >= 0 &&
    result.events[lastError]?.errorMessage === result.error &&
    answer.index > lastError
  );
}

function usageOf(
  result: AgentInvocationResult,
  report: ExternalAgentRunReport,
): AgentRunUsage {
  const { usage } = result;
  // The gateway sums every run-scoped cost, delegated sub-agents included;
  // a session total is not in that sum, so it is the agent's own report.
  const costUsd = report.scope === "session" ? report.costUsd : usage.costUsd;
  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(report.turns !== undefined ? { turns: report.turns } : {}),
    tokens: {
      input: usage.promptTokens,
      output: usage.completionTokens,
      cacheRead: usage.cachedTokens,
      ...(usage.cacheCreationTokens !== undefined
        ? { cacheCreation: usage.cacheCreationTokens }
        : {}),
      total: usage.totalTokens,
    },
    ...(report.scope ? { scope: report.scope } : {}),
  };
}

/**
 * The agent's own last run report, or an empty one. Reports of delegated
 * sub-agents (other authors) are theirs, not the agent's.
 */
function runReport(
  agent: ExternalAgent,
  events: readonly Event[],
): ExternalAgentRunReport {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.author !== agent.name) continue;
    const value = event.customMetadata?.[EXTERNAL_AGENT_RUN_METADATA_KEY];
    if (value && typeof value === "object") {
      return value as ExternalAgentRunReport;
    }
  }
  return {};
}

/**
 * The failure's cause. The code is the one of the error event the gateway
 * reported (its last error event, when `error` is that event's message);
 * a thrown error, an abort or a timeout has no code, even after an earlier
 * error event.
 */
function causeOf(result: AgentInvocationResult): AgentRunFailureCause {
  const message = result.error ?? "";
  const kind = result.errorKind ?? "agent-error";
  if (kind !== "agent-error" && kind !== "llm-calls-limit") return { message };
  for (let index = result.events.length - 1; index >= 0; index--) {
    const event = result.events[index];
    if (!event?.errorMessage) continue;
    return event.errorMessage === message && event.errorCode
      ? { message, code: event.errorCode }
      : { message };
  }
  return { message };
}
