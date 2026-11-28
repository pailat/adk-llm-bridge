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
 *   is empty or not JSON.
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
  /** US dollars the runtime reported; see `scope`. Absent when it reported none. */
  costUsd?: number;
  /** Model turns the runtime reported. Absent when it reported none. */
  turns?: number;
  /** Token counters; zeros when the runtime reported none. */
  tokens: AgentRunTokens;
  /**
   * `"session"` when `costUsd` and `tokens` are the runtime session's total
   * so far (a run that resumed a session this process did not run before),
   * `"run"` when they cover this run only. Absent when the driver did not say.
   */
  scope?: "run" | "session";
}

/** Result of {@link runExternalAgentOnce}; failures are reported, not thrown. */
export interface AgentRunOutcome {
  /**
   * The final answer parsed as JSON, when the agent has an `outputSchema`.
   * Integers beyond `Number.MAX_SAFE_INTEGER` are strings of their digits.
   * Not validated against the schema here: the driver checks it when it
   * supports one.
   */
  structured?: unknown;
  /** Text of the final answer; empty when there is none. */
  text: string;
  /** Cost, turns and tokens of the run. */
  usage: AgentRunUsage;
  /**
   * The runtime's session id: the value the run stored under the agent's
   * session state key (`claude_sdk_session:<agent>` for Claude). Pass it as
   * `sessionId` to resume that session. Absent when the run reported none.
   */
  sessionId?: string;
  /** Classification of the failure; absent on success. */
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
  return toOutcome(agent, result, stateKey, options.sessionId);
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
  resumedId: string | undefined,
): AgentRunOutcome {
  const stored = stateKey ? result.stateDelta?.[stateKey] : undefined;
  const sessionId =
    typeof stored === "string" && stored.length > 0 ? stored : resumedId;
  const text = result.output;
  const base: AgentRunOutcome = {
    text,
    usage: usageOf(result),
    ...(sessionId ? { sessionId } : {}),
  };
  if (result.error) {
    return {
      ...base,
      errorKind: result.errorKind ?? "agent-error",
      cause: causeOf(result.events, result.error),
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
  if (!agent.outputSchema) return base;
  const parsed = text.trim() ? parseJson(text) : undefined;
  if (!parsed?.ok) {
    return {
      ...base,
      errorKind: "invalid-output",
      cause: {
        message: `${agent.name} has an outputSchema, but its final answer is not JSON.`,
      },
    };
  }
  return { ...base, structured: parsed.value };
}

function usageOf(result: AgentInvocationResult): AgentRunUsage {
  const report = runReport(result.events);
  const { usage } = result;
  return {
    ...(report.costUsd !== undefined
      ? { costUsd: report.costUsd }
      : usage.costUsd !== undefined
        ? { costUsd: usage.costUsd }
        : {}),
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

/** The last run report on the run's events, or an empty one. */
function runReport(events: readonly Event[]): ExternalAgentRunReport {
  for (let index = events.length - 1; index >= 0; index--) {
    const value =
      events[index]?.customMetadata?.[EXTERNAL_AGENT_RUN_METADATA_KEY];
    if (value && typeof value === "object") {
      return value as ExternalAgentRunReport;
    }
  }
  return {};
}

function causeOf(
  events: readonly Event[],
  message: string,
): AgentRunFailureCause {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.errorCode) {
      return {
        message: event.errorMessage || message,
        code: event.errorCode,
      };
    }
  }
  return { message };
}
