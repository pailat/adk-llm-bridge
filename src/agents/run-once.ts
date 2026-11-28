import { type Event, InvocationContext, PluginManager } from "@google/adk";
import type { Content } from "@google/genai";
import { CACHE_CREATION_METADATA_KEY } from "../converters/cache-usage.js";
import {
  type AgentInvocationErrorKind,
  AgentInvocationGateway,
  type AgentInvocationResult,
} from "../runtime/agent-invocation-gateway.js";
import { parseJson } from "../utils/json.js";
import {
  ClaudeAgentSdkDriver,
  claudeSdkSessionStateKey,
} from "./driver/claude-agent-sdk.js";
import { CodexSdkDriver } from "./driver/codex-sdk.js";
import { FxCliDriver, fxSessionStateKey } from "./driver/fx-cli.js";
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
  /**
   * Token counters, in the same scope as `costUsd`: with scope `"run"` (or
   * none), delegated sub-agents included; with scope `"session"`, the
   * agent's own session total only. Zeros when none were reported.
   */
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
   * is text. When that event is the agent's transfer to a sub-agent (default
   * delegation, where the sub-agent's turn is the final answer), the last
   * text after it of the sub-agent or of an agent below it (a composite
   * sub-agent's children); the agent's own built-in tool calls after the
   * transfer do not change that. Empty when the run ended on a tool call
   * or result, or had no text (a tool's output or an error message is never
   * the answer).
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
   * stopped: a new session (Claude SDK: from its first message; Codex SDK:
   * a new thread), or a resumed Claude SDK session when the run threw. A
   * resumed session that is aborted is not returned, for any driver: the
   * abort ends the run before the driver reports the session it kept. Its
   * absence there does not mean the session is gone: the id you passed is
   * still yours to retry with.
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
   * the key the agent's driver reads, whatever the provider's id:
   * `claude_sdk_session:<name>` (`ClaudeAgentSdkDriver`), the
   * `threadStateKey` of a `CodexSdkDriver` (`codex_thread:<name>` by
   * default) and `fx_session:<name>` (`FxCliDriver`); for another driver,
   * the key of the provider id `claude`, `codex` or `fx`.
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
  // The key the driver reads, whatever the provider's id is.
  const { driver } = agent;
  if (driver instanceof ClaudeAgentSdkDriver) {
    return claudeSdkSessionStateKey(agent.name);
  }
  if (driver instanceof CodexSdkDriver) {
    return driver.threadStateKeyFor(agent.name);
  }
  if (driver instanceof FxCliDriver) return fxSessionStateKey(agent.name);
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
  const own = runReport(agent, result.events);
  const { report } = own;
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
    usage: usageOf(result, own),
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
 * are skipped. When the agent's last such event is its transfer to another
 * agent (`actions.transferToAgent`, as in default delegation, where the
 * coordinator writes nothing after it), the answer is the target's, read
 * the same way from the events after the transfer by any agent of the
 * target's subtree (a SequentialAgent's events are its children's), nested
 * transfers included. Calls and results of the runtime's own tools after
 * the transfer do not end the sub-agent's answer, as they do not for the
 * tool gateway; any other event does.
 */
function finalAnswer(
  agent: ExternalAgent,
  events: readonly Event[],
): FinalAnswer | undefined {
  return finalAnswerOf(agent, new Set([agent.name]), events, 0);
}

function finalAnswerOf(
  agent: ExternalAgent,
  authors: ReadonlySet<string>,
  events: readonly Event[],
  start: number,
): FinalAnswer | undefined {
  // After a built-in tool event, only an earlier transfer gives the answer.
  let afterBuiltin = false;
  for (let index = events.length - 1; index >= start; index--) {
    const event = events[index];
    if (!event || event.partial || !authors.has(event.author ?? "")) continue;
    const target = event.actions?.transferToAgent;
    if (target && !authors.has(target) && !event.errorCode) {
      return finalAnswerOf(
        agent,
        subtreeNames(agent, target),
        events,
        index + 1,
      );
    }
    const parts = event.content?.parts ?? [];
    if (parts.length === 0) continue;
    if (isBuiltinToolEvent(event)) {
      afterBuiltin = true;
      continue;
    }
    if (afterBuiltin || event.errorCode) return undefined;
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

/** Names of the agent `name` and of every agent below it. */
function subtreeNames(agent: ExternalAgent, name: string): Set<string> {
  const names = new Set([name]);
  const pending = [...(agent.rootAgent.findAgent(name)?.subAgents ?? [])];
  for (let next = pending.pop(); next; next = pending.pop()) {
    names.add(next.name);
    pending.push(...next.subAgents);
  }
  return names;
}

/**
 * A call or result of the runtime's own tools (Read, Bash...): the driver
 * marks them `metadata.builtin`, which lands on `customMetadata`.
 */
function isBuiltinToolEvent(event: Event): boolean {
  return (
    event.customMetadata?.builtin === true &&
    (event.content?.parts ?? []).some(
      (part) => part.functionCall || part.functionResponse,
    )
  );
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
  { report, event }: OwnRunReport,
): AgentRunUsage {
  const { usage } = result;
  // The gateway sums every run-scoped cost and token count, delegated
  // sub-agents included. A session total is not a run's, so under scope
  // "session" both are the agent's own report, as one scope.
  const session = report.scope === "session";
  const costUsd = session ? report.costUsd : usage.costUsd;
  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(report.turns !== undefined ? { turns: report.turns } : {}),
    tokens: session ? ownTokens(event) : gatewayTokens(usage),
    ...(report.scope ? { scope: report.scope } : {}),
  };
}

function gatewayTokens(usage: AgentInvocationResult["usage"]): AgentRunTokens {
  return {
    input: usage.promptTokens,
    output: usage.completionTokens,
    cacheRead: usage.cachedTokens,
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreation: usage.cacheCreationTokens }
      : {}),
    total: usage.totalTokens,
  };
}

/** Tokens on the event that carries the agent's own run report. */
function ownTokens(event: Event | undefined): AgentRunTokens {
  const meta = event?.usageMetadata;
  const input = meta?.promptTokenCount ?? 0;
  const output = meta?.candidatesTokenCount ?? 0;
  const written = event?.customMetadata?.[CACHE_CREATION_METADATA_KEY];
  return {
    input,
    output,
    cacheRead: meta?.cachedContentTokenCount ?? 0,
    ...(typeof written === "number" ? { cacheCreation: written } : {}),
    total: meta?.totalTokenCount ?? input + output,
  };
}

/** The agent's own last run report and the event that carries it. */
interface OwnRunReport {
  report: ExternalAgentRunReport;
  event?: Event;
}

/**
 * The agent's own last run report, or an empty one. Reports of delegated
 * sub-agents (other authors) are theirs, not the agent's.
 */
function runReport(
  agent: ExternalAgent,
  events: readonly Event[],
): OwnRunReport {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.author !== agent.name) continue;
    const value = event.customMetadata?.[EXTERNAL_AGENT_RUN_METADATA_KEY];
    if (value && typeof value === "object") {
      return { report: value as ExternalAgentRunReport, event };
    }
  }
  return { report: {} };
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
