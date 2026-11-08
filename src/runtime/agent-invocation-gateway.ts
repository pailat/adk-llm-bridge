/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type AppendEventRequest,
  type BaseAgent,
  BaseSessionService,
  createEvent,
  createEventActions,
  type Event,
  getFunctionCalls,
  getPendingUserInputRequests,
  InvocationContext,
  isFinalResponse,
  isLlmCallsLimitExceededError,
  type Session,
  type UserInputKind,
  type UserInputRequest,
} from "@google/adk";
import type { Content } from "@google/genai";
import { inheritSessionPermissions } from "../agents/permissions/inheritance.js";

export interface AgentInvocationExecutionSummary {
  events: number;
  textEvents: number;
  toolCalls: number;
  errors: number;
  durationMs: number;
}

/**
 * Machine-readable classification of {@link AgentInvocationResult.error}.
 * - `aborted`: the parent or request signal fired.
 * - `llm-calls-limit`: the shared `RunConfig.maxLlmCalls` budget was exhausted.
 * - `preparation`: `prepareContext` rejected.
 * - `agent-error`: resolution failed or the agent emitted/threw an error.
 * - `invalid-resume`: `resume` did not match a pending interrupt.
 */
export type AgentInvocationErrorKind =
  | "aborted"
  | "llm-calls-limit"
  | "preparation"
  | "agent-error"
  | "invalid-resume";

export type AgentInvocationInterruptKind = UserInputKind | "long-running";

/**
 * The child stopped waiting for a human or an external system (ADK
 * `adk_request_input`, `adk_request_confirmation`, `adk_request_credential`
 * function calls, or a final event carrying `longRunningToolIds`).
 *
 * To continue, call `run()` again with the same `agentName`, `resume: { events:
 * interrupt.events }` and `input` set to a `user` content whose
 * `functionResponse` parts answer `functionCallIds` (same `id` and `name` as the
 * pending call, see `requests[].interruptId` / `functionCallName`).
 */
export interface AgentInvocationInterrupt {
  /** Kind of the first pending request; `long-running` for bare LRO calls. */
  kind: AgentInvocationInterruptKind;
  /** Ids of the function calls that must be answered to resume. */
  functionCallIds: readonly string[];
  /** ADK's flattened view of the pending requests (empty for bare LRO calls). */
  requests: readonly UserInputRequest[];
  /**
   * Every non-partial event of this delegation (including events carried by
   * `resume` and the input event), in order: the history needed to resume.
   */
  events: readonly Event[];
}

export interface AgentInvocationResume {
  /** `interrupt.events` of the interrupted result. */
  events: readonly Event[];
}

export interface AgentInvocationResult {
  agentName: string;
  /**
   * Non-thought text of the last non-partial `isFinalResponse` event that has
   * text (the Runner/`AgentTool` semantics). When no final event has text it
   * falls back to function-response output, then to {@link transcript}.
   */
  output: string;
  /**
   * Every visible non-partial text event joined by newlines (previous `output`
   * behavior), including narration emitted before tool calls.
   */
  transcript: string;
  events: readonly Event[];
  summary: AgentInvocationExecutionSummary;
  stateDelta?: Record<string, unknown>;
  error?: string;
  errorKind?: AgentInvocationErrorKind;
  /** Present when the child stopped waiting for input; see the type docs. */
  interrupt?: AgentInvocationInterrupt;
}

export interface AgentInvocationRequest {
  agentName: string;
  input: Content;
  parentContext: InvocationContext;
  branch?: string;
  abortSignal?: AbortSignal;
  /** JSON-safe state projected into the isolated child session only. */
  sessionState?: Readonly<Record<string, unknown>>;
  /**
   * `merge` (default) starts from a deep copy of the parent state (so the child
   * never shares mutable objects with it) plus `sessionState`; `replace` uses
   * only `sessionState` and freezes the child state.
   */
  sessionStateMode?: "merge" | "replace";
  /**
   * `replace` (default) starts the child with only the delegated input, like
   * ADK's `AgentTool`; `inherit` also exposes the parent history, like a native
   * `transfer_to_agent` (which shares the session).
   */
  sessionHistoryMode?: "inherit" | "replace";
  /** Continues a previously interrupted delegation. */
  resume?: AgentInvocationResume;
  eventSink?: AgentInvocationEventSink;
  /**
   * Host authorization fence invoked around agent resolution. Rejections escape
   * as their original typed error rather than becoming agent output.
   */
  validateInvocation?: AgentInvocationValidator;
  prepareContext?: AgentInvocationContextPreparer;
}

export type AgentResolver = (
  agentName: string,
  parentContext: InvocationContext,
) => BaseAgent | undefined | Promise<BaseAgent | undefined>;

export type AgentInvocationEventSink = (
  event: Event,
  childContext: InvocationContext,
) => void | Promise<void>;

export type AgentInvocationContextPreparer = (
  childContext: InvocationContext,
  agent: BaseAgent,
) => void | Promise<void>;

export type AgentInvocationValidationPhase =
  | "before-resolve"
  | "before-prepare"
  | "before-execute";

export type AgentInvocationValidator = (
  phase: AgentInvocationValidationPhase,
) => void | Promise<void>;

export interface AgentInvocationGatewayConfig {
  resolveAgent: AgentResolver;
  eventSink?: AgentInvocationEventSink;
}

/**
 * Executes ADK agents behind a runtime-neutral boundary.
 *
 * The gateway owns agent resolution, child context/session construction,
 * streaming and result aggregation. Presentation protocols such as MCP tools
 * or `transfer_to_agent`, and provider-specific permission policy, deliberately
 * remain outside this class.
 */
export class AgentInvocationGateway {
  readonly #resolveAgent: AgentResolver;
  readonly #eventSink?: AgentInvocationEventSink;

  constructor(config: AgentInvocationGatewayConfig) {
    this.#resolveAgent = config.resolveAgent;
    this.#eventSink = config.eventSink;
  }

  async run(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const startedAt = Date.now();
    let agent: BaseAgent | undefined;

    await request.validateInvocation?.("before-resolve");

    try {
      agent = await this.#resolveAgent(
        request.agentName,
        request.parentContext,
      );
    } catch (caught) {
      return failedResult(request.agentName, startedAt, errorMessage(caught));
    }

    if (!agent) {
      return failedResult(
        request.agentName,
        startedAt,
        `Unknown ADK agent: ${request.agentName}`,
      );
    }

    const resumeEvents = request.resume?.events ?? [];
    if (request.resume) {
      const pending = findInterrupt(resumeEvents);
      const answered = new Set(
        (request.input.parts ?? [])
          .map((part) => part.functionResponse?.id)
          .filter((id): id is string => typeof id === "string"),
      );
      if (!pending?.functionCallIds.some((id) => answered.has(id))) {
        return failedResult(
          request.agentName,
          startedAt,
          "Resume input does not answer a pending interrupt",
          "invalid-resume",
        );
      }
    }

    const signal = combineAbortSignals([
      request.parentContext.abortSignal,
      request.abortSignal,
    ]);
    const inputEvent = createEvent({
      invocationId: request.parentContext.invocationId,
      author: "user",
      branch: request.branch,
      content: request.input,
    });
    const child = createChildSession({
      parentSession: request.parentContext.session,
      inputEvent,
      priorEvents: resumeEvents,
      sessionState: request.sessionState,
      sessionStateMode: request.sessionStateMode ?? "merge",
      sessionHistoryMode: request.sessionHistoryMode ?? "replace",
    });
    // Every delegation hop keeps the caller's permission ceiling, whatever the
    // state/history modes: the policy is keyed by session object, not by state.
    inheritSessionPermissions(request.parentContext.session, child.session);
    const childContext = createChildInvocationContext({
      agent,
      parentContext: request.parentContext,
      input: request.input,
      branch: request.branch,
      abortSignal: signal,
      session: child.session,
    });

    const events: Event[] = [];
    const text: string[] = [];
    const fallbackOutput: string[] = [];
    const stateDelta: Record<string, unknown> = {};
    let finalText: string | undefined;
    let textEvents = 0;
    let toolCalls = 0;
    let errors = 0;
    let error: string | undefined;
    let errorKind: AgentInvocationErrorKind | undefined;
    const fail = (caught: unknown, fallbackKind: AgentInvocationErrorKind) => {
      errors++;
      error = errorMessage(caught);
      errorKind = signal?.aborted
        ? "aborted"
        : isLlmCallsLimitExceededError(caught)
          ? "llm-calls-limit"
          : fallbackKind;
    };

    await request.validateInvocation?.("before-prepare");

    let preparationFailed = false;
    try {
      throwIfAborted(signal);
      await request.prepareContext?.(childContext, agent);
    } catch (caught) {
      preparationFailed = true;
      fail(caught, "preparation");
    }

    if (!preparationFailed) {
      await request.validateInvocation?.("before-execute");

      const iterator = agent.runAsync(childContext)[Symbol.asyncIterator]();
      const aborted = abortRejection(signal);
      let exhausted = false;
      try {
        while (true) {
          const next = await (aborted
            ? Promise.race([iterator.next(), aborted.promise])
            : iterator.next());
          if (next.done) {
            exhausted = true;
            break;
          }
          const event = next.value;
          throwIfAborted(signal);
          // ADK's BaseSessionService.appendEvent semantics: partial events are
          // not persisted, `temp:` keys are trimmed and deltas applied in order.
          const persisted = await child.append(event);
          events.push(persisted);
          if (!persisted.partial) {
            Object.assign(stateDelta, persisted.actions?.stateDelta ?? {});
          }
          await this.#eventSink?.(persisted, childContext);
          await request.eventSink?.(persisted, childContext);

          const visible = persisted.partial
            ? undefined
            : extractVisibleText(persisted);
          if (visible) {
            textEvents++;
            text.push(visible);
            if (isFinal(persisted)) {
              finalText = visible;
            }
          } else {
            const fallback = extractFallbackOutput(persisted);
            if (fallback) {
              fallbackOutput.push(fallback);
            }
          }
          toolCalls += getFunctionCalls(persisted).length;
          if (persisted.errorMessage) {
            errors++;
            error = persisted.errorMessage;
            errorKind = "agent-error";
          }
        }
      } catch (caught) {
        fail(caught, "agent-error");
      } finally {
        aborted?.dispose();
        if (!exhausted) {
          // Any abnormal exit (abort, sink/append failure, thrown event) must
          // close the agent generator like `for await` did, so its `finally`
          // blocks (external drivers, workflow runtimes) run. After an abort the
          // generator may be parked on a pending await and return() would queue
          // behind it, so only wait when we were not aborted.
          const closing = Promise.resolve(iterator.return?.()).catch(
            () => undefined,
          );
          if (!signal?.aborted) {
            await closing;
          }
        }
      }
    }

    const transcript =
      text.length > 0 ? text.join("\n") : fallbackOutput.join("\n");
    const interrupt = findInterrupt([...resumeEvents, inputEvent, ...events]);

    return {
      agentName: agent.name,
      output: finalText ?? transcript,
      transcript,
      events,
      summary: {
        events: events.length,
        textEvents,
        toolCalls,
        errors,
        durationMs: Date.now() - startedAt,
      },
      ...(Object.keys(stateDelta).length > 0 ? { stateDelta } : {}),
      ...(error ? { error } : {}),
      ...(error && errorKind ? { errorKind } : {}),
      ...(interrupt ? { interrupt } : {}),
    };
  }
}

function createChildInvocationContext({
  agent,
  parentContext,
  input,
  branch,
  abortSignal,
  session,
}: {
  agent: BaseAgent;
  parentContext: InvocationContext;
  input: Content;
  branch: string | undefined;
  abortSignal: AbortSignal | undefined;
  session: Session;
}): InvocationContext {
  // Same pattern as ADK 2.x BaseAgent.createInvocationContext: the spread keeps
  // the shared LLM-call counter (maxLlmCalls) and the newer fields
  // (isolationScope, nodeToolDepth, a2aMetadata, workflowInstructionScope, ...)
  // that a hand-written field list would drop. parentContext.clone() is not used
  // because the parent context may be a plain object (see withToolGatewaySession).
  return new InvocationContext({
    ...parentContext,
    branch,
    agent,
    userContent: input,
    session,
    abortSignal,
  });
}

/**
 * Minimal session service used only for its inherited `appendEvent`, so the
 * child session follows exactly the ADK Runner's persistence semantics without
 * storing anything (InMemorySessionService would warn about unknown sessions).
 */
class ChildSessionService extends BaseSessionService {
  createSession(): Promise<Session> {
    return Promise.reject(new Error("ChildSessionService is append-only"));
  }
  getSession(): Promise<Session | undefined> {
    return Promise.reject(new Error("ChildSessionService is append-only"));
  }
  listSessions(): Promise<never> {
    return Promise.reject(new Error("ChildSessionService is append-only"));
  }
  deleteSession(): Promise<void> {
    return Promise.reject(new Error("ChildSessionService is append-only"));
  }
}

const childSessionService = new ChildSessionService();

interface ChildSession {
  session: Session;
  /** Persists an event with ADK semantics and returns the stored event. */
  append(event: Event): Promise<Event>;
}

function createChildSession({
  parentSession,
  inputEvent,
  priorEvents,
  sessionState,
  sessionStateMode,
  sessionHistoryMode,
}: {
  parentSession: Session;
  inputEvent: Event;
  priorEvents: readonly Event[];
  sessionState: Readonly<Record<string, unknown>> | undefined;
  sessionStateMode: "merge" | "replace";
  sessionHistoryMode: "inherit" | "replace";
}): ChildSession {
  const frozen = sessionStateMode === "replace";
  const baseState = frozen
    ? { ...sessionState }
    : { ...cloneState(parentSession.state), ...sessionState };
  // Deltas recorded by the events of an interrupted run are part of the
  // delegation's state (they were applied to the previous child session).
  for (const event of priorEvents) {
    if (event.partial) continue;
    for (const [key, value] of Object.entries(
      event.actions?.stateDelta ?? {},
    )) {
      if (!key.startsWith("temp:")) {
        baseState[key] = value;
      }
    }
  }
  const session: Session = {
    id: parentSession.id,
    appName: parentSession.appName,
    userId: parentSession.userId,
    state: frozen ? Object.freeze(baseState) : baseState,
    events: [
      ...(sessionHistoryMode === "inherit" ? parentSession.events : []),
      ...priorEvents,
      inputEvent,
    ],
    lastUpdateTime: parentSession.lastUpdateTime,
  };

  return {
    session,
    async append(event) {
      if (!frozen) {
        return childSessionService.appendEvent({ session, event });
      }
      // `replace` exposes an immutable state: apply the delta on a scratch copy
      // that shares the events array, then publish a new frozen snapshot.
      const scratch: AppendEventRequest["session"] = {
        ...session,
        state: { ...session.state },
      };
      const stored = await childSessionService.appendEvent({
        session: scratch,
        event,
      });
      session.state = Object.freeze({ ...scratch.state });
      session.lastUpdateTime = scratch.lastUpdateTime;
      return stored;
    },
  };
}

/**
 * Deep copy of the parent state so the child never shares mutable objects with
 * it. Values that cannot be structured-cloned (functions, class instances with
 * private slots) are not valid session state either and are left out.
 */
function cloneState(
  state: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    try {
      copy[key] = structuredClone(value);
    } catch {
      // Not cloneable: omit rather than share a mutable reference.
    }
  }
  return copy;
}

/** `isFinalResponse` tolerant of externally built events without `actions`. */
function isFinal(event: Event): boolean {
  return isFinalResponse(
    event.actions ? event : { ...event, actions: createEventActions() },
  );
}

/**
 * Whether the events end waiting for a human or external system. Uses ADK's
 * own `getPendingUserInputRequests` (unanswered `adk_request_*` calls) plus a
 * trailing event that carries `longRunningToolIds`.
 */
function findInterrupt(
  allEvents: readonly Event[],
): AgentInvocationInterrupt | undefined {
  const events = allEvents.filter((event) => !event.partial);
  const requests = getPendingUserInputRequests(events);
  const trailing = events.at(-1)?.longRunningToolIds ?? [];
  const functionCallIds = [
    ...new Set([
      ...requests.map((request) => request.interruptId),
      ...trailing,
    ]),
  ];
  if (functionCallIds.length === 0) {
    return undefined;
  }
  return {
    kind: requests[0]?.kind ?? "long-running",
    functionCallIds,
    requests,
    events,
  };
}

/**
 * Combines the active signals with the platform `AbortSignal.any` (Node >=22),
 * the same primitive ADK's LlmAgent uses; no listeners to dispose.
 */
function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length <= 1) {
    return active[0];
  }
  return AbortSignal.any(active);
}

/**
 * A promise that rejects as soon as `signal` aborts, so a stalled agent
 * generator cannot keep `run()` pending (ADK itself only checks between events).
 */
function abortRejection(
  signal: AbortSignal | undefined,
): { promise: Promise<never>; dispose: () => void } | undefined {
  if (!signal) {
    return undefined;
  }
  let onAbort: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return new Error(
    typeof signal.reason === "string"
      ? signal.reason
      : "Agent invocation aborted",
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function failedResult(
  agentName: string,
  startedAt: number,
  error: string,
  errorKind: AgentInvocationErrorKind = "agent-error",
): AgentInvocationResult {
  return {
    agentName,
    output: "",
    transcript: "",
    events: [],
    summary: {
      events: 0,
      textEvents: 0,
      toolCalls: 0,
      errors: 1,
      durationMs: Date.now() - startedAt,
    },
    error,
    errorKind,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function extractVisibleText(event: Event): string | undefined {
  const parts = event.content?.parts;
  if (!parts) {
    return undefined;
  }

  const text = parts
    .filter((part) => part.thought !== true)
    .map((part) => part.text)
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("");
  return text.length > 0 ? text : undefined;
}

function extractFallbackOutput(event: Event): string | undefined {
  if (event.errorMessage) {
    return event.errorMessage;
  }

  const parts = event.content?.parts;
  if (!parts) {
    return undefined;
  }

  const output = parts
    .map((part) => part.functionResponse?.response)
    .map(stringifyUsefulOutput)
    .filter((value): value is string => Boolean(value));

  return output.length > 0 ? output.join("\n") : undefined;
}

function stringifyUsefulOutput(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const output = (value as { output?: unknown }).output;
    if (typeof output === "string" && output.length > 0) {
      return output;
    }
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized : undefined;
  } catch {
    return String(value);
  }
}
