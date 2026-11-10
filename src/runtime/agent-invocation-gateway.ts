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
  isBaseAgent,
  isBaseToolset,
  isFinalResponse,
  isLlmAgent,
  isLlmCallsLimitExceededError,
  isWorkflow,
  type LlmAgent,
  type Session,
  type UserInputKind,
  type UserInputRequest,
} from "@google/adk";
import type { Content } from "@google/genai";
import { inheritSessionPermissions } from "../agents/permissions/inheritance.js";
import { isTempStateKey, withoutTempStateKeys } from "../utils/state.js";

/**
 * Aggregate model usage of one delegated agent run.
 *
 * @remarks
 * The sum of `usageMetadata` over the run's non-partial events (nested agent
 * and workflow events included, since the gateway sees them) plus the function
 * calls requested on those same events. Values are summed as each runtime
 * reports them, so any double counting in a runtime's report carries into the
 * totals. Cost is not computed: the gateway has no price source.
 */
export interface AgentInvocationUsage {
  /** Summed `promptTokenCount`. */
  promptTokens: number;
  /** Summed `candidatesTokenCount`. */
  completionTokens: number;
  /** Summed `totalTokenCount` (prompt + completion when absent). */
  totalTokens: number;
  /**
   * Summed `cachedContentTokenCount`. Cached tokens are part of
   * `promptTokens`, not added on top of it.
   */
  cachedTokens: number;
  /** Function calls requested on non-partial events. */
  toolCalls: number;
  /**
   * Events that carried `usageMetadata`: one per model response for an
   * `LlmAgent`, one per run for an `ExternalAgent` that ends with a final
   * response (it reports usage once, on that event).
   */
  llmCalls: number;
}

/** Counters describing one delegated agent run. */
export interface AgentInvocationExecutionSummary {
  /** Non-partial and partial events the child emitted. */
  events: number;
  /** Non-partial events that carried visible text. */
  textEvents: number;
  /** Function calls the child requested on non-partial events. */
  toolCalls: number;
  /** Errors observed during the run. */
  errors: number;
  /** Wall-clock duration in milliseconds. */
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

/** Kind of input an interrupted delegation is waiting for. */
export type AgentInvocationInterruptKind = UserInputKind | "long-running";

/**
 * The child stopped waiting for a human or an external system: an unanswered
 * ADK `adk_request_input`, `adk_request_confirmation` or
 * `adk_request_credential` function call, or an unanswered long-running tool
 * call (an id in any event's `longRunningToolIds`). A long-running call counts
 * as answered only by a later `functionResponse` with the same id authored by
 * `user` (the resume input); the tool's own immediate response, which ADK 2.4
 * emits before the model continues with more events, does not answer it. ADK
 * `NodeTool` calls are not interrupts themselves (ADK marks them long-running
 * only so a paused node can resume); when the wrapped node pauses, its own
 * interrupt events, which are part of the delegation, carry the ids to answer.
 *
 * To continue, call `run()` again with the same `agentName`,
 * `resume: { events: interrupt.events }` and `input` set to a `user` content whose
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

/** Continuation data for an interrupted delegation. */
export interface AgentInvocationResume {
  /** `interrupt.events` of the interrupted result. */
  events: readonly Event[];
}

/** Result of one delegated agent run; failures are reported in `error`, not thrown. */
export interface AgentInvocationResult {
  /** Name of the agent that ran. */
  agentName: string;
  /**
   * Non-thought text of the last non-partial `isFinalResponse` event that has
   * text (the Runner/`AgentTool` semantics). When no final event has text it
   * falls back to function-response output, then to {@link transcript}.
   */
  output: string;
  /**
   * Every visible non-partial text event joined by newlines, including
   * narration emitted before tool calls.
   */
  transcript: string;
  /** Persisted events the child emitted, in order. */
  events: readonly Event[];
  /** Counters for the run. */
  summary: AgentInvocationExecutionSummary;
  /** Aggregate token and tool-call usage of the run; see {@link AgentInvocationUsage}. */
  usage: AgentInvocationUsage;
  /**
   * Merged state delta of the non-partial events, without ADK `temp:` keys;
   * absent when empty.
   */
  stateDelta?: Record<string, unknown>;
  /** Failure message; absent on success. */
  error?: string;
  /** Classification of `error`. */
  errorKind?: AgentInvocationErrorKind;
  /** Present when the child stopped waiting for input; see the type docs. */
  interrupt?: AgentInvocationInterrupt;
}

/** Request to run a named agent in an isolated child session. */
export interface AgentInvocationRequest {
  /** Name passed to the {@link AgentResolver}. */
  agentName: string;
  /** Content delivered to the child as the user input. */
  input: Content;
  /** Context of the calling agent; supplies the abort signal, session and permissions. */
  parentContext: InvocationContext;
  /** Event branch for the input event. */
  branch?: string;
  /** Extra abort signal, combined with the parent context signal. */
  abortSignal?: AbortSignal;
  /** JSON-safe state projected into the isolated child session only. */
  sessionState?: Readonly<Record<string, unknown>>;
  /**
   * `merge` (default) starts from a deep copy of the parent state plus a deep
   * copy of `sessionState`, so the child never shares mutable objects with the
   * parent or the caller; `replace` uses only the copy of `sessionState` and
   * freezes the child state (its top-level keys). A value that is frozen in
   * the input stays frozen in the copy; a value that cannot be structured-cloned
   * is left out.
   *
   * @defaultValue `"merge"`
   */
  sessionStateMode?: "merge" | "replace";
  /**
   * `replace` (default) starts the child with only the delegated input, like
   * ADK's `AgentTool`; `inherit` also exposes the parent history, like a native
   * `transfer_to_agent` (which shares the session).
   *
   * @defaultValue `"replace"`
   */
  sessionHistoryMode?: "inherit" | "replace";
  /**
   * Whether `input` is appended to the child session as a new user event.
   * With `false` the child only gets it as its `userContent`, as an ADK
   * transfer reuses the invocation's user message that is already in the
   * inherited history. Use `false` only when `input` is in that history.
   *
   * @defaultValue `true`
   */
  appendInput?: boolean;
  /** Continues a previously interrupted delegation. */
  resume?: AgentInvocationResume;
  /** Receives every persisted child event, after the gateway-level sink. */
  eventSink?: AgentInvocationEventSink;
  /**
   * Host authorization fence invoked around agent resolution. Rejections escape
   * as their original typed error rather than becoming agent output.
   */
  validateInvocation?: AgentInvocationValidator;
  /** Hook to adjust the child context before the agent runs; a rejection yields `errorKind` `preparation`. */
  prepareContext?: AgentInvocationContextPreparer;
}

/** Looks up an agent by name; returns undefined for an unknown agent. */
export type AgentResolver = (
  agentName: string,
  parentContext: InvocationContext,
) => BaseAgent | undefined | Promise<BaseAgent | undefined>;

/** Receives each persisted child event as it is produced. */
export type AgentInvocationEventSink = (
  event: Event,
  childContext: InvocationContext,
) => void | Promise<void>;

/** Prepares the child invocation context before the agent runs. */
export type AgentInvocationContextPreparer = (
  childContext: InvocationContext,
  agent: BaseAgent,
) => void | Promise<void>;

/** Points in a delegation at which the host authorization fence runs. */
export type AgentInvocationValidationPhase =
  | "before-resolve"
  | "before-prepare"
  | "before-execute";

/** Host authorization fence; throw to deny the invocation at the given phase. */
export type AgentInvocationValidator = (
  phase: AgentInvocationValidationPhase,
) => void | Promise<void>;

/** Configuration for {@link AgentInvocationGateway}. */
export interface AgentInvocationGatewayConfig {
  /** Resolves agents by name. */
  resolveAgent: AgentResolver;
  /** Sink that sees every child event of every run, before the per-request sink. */
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

  /**
   * Creates a gateway that resolves and runs delegated agents.
   *
   * @param config - Agent resolver and optional event sink.
   */
  constructor(config: AgentInvocationGatewayConfig) {
    this.#resolveAgent = config.resolveAgent;
    this.#eventSink = config.eventSink;
  }

  /**
   * Runs an agent to completion in a child session and aggregates the result.
   *
   * @remarks
   * The child session inherits the caller's permission ceiling in every state
   * and history mode. Resolution, preparation and agent failures, aborts and
   * the LLM call limit are reported in the result, not thrown.
   *
   * @param request - Agent name, input, parent context and options.
   * @returns The aggregated result, including `interrupt` when the child waits for input.
   * @throws The original error of a rejecting `validateInvocation`, so authorization failures keep their type.
   */
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
      const pending = findInterrupt(resumeEvents, agent);
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
    const inputEvent =
      request.appendInput === false
        ? undefined
        : createEvent({
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
    const usage: AgentInvocationUsage = emptyUsage();
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
      throwIfInvocationAborted(signal);
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
          throwIfInvocationAborted(signal);
          // ADK's BaseSessionService.appendEvent semantics: partial events are
          // not persisted and deltas are applied in order.
          const persisted = await child.append(event);
          events.push(persisted);
          if (!persisted.partial) {
            // `temp:` keys stay out of the aggregate even when the installed
            // ADK keeps them on the event, so they never reach a checkpoint.
            Object.assign(
              stateDelta,
              withoutTempStateKeys(persisted.actions?.stateDelta ?? {}),
            );
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
          if (!persisted.partial) {
            // A streamed function call is repeated on the final event.
            toolCalls += getFunctionCalls(persisted).length;
            addUsage(usage, persisted);
          }
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
          // close the agent generator, as `for await` does, so its `finally`
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
    const interrupt = findInterrupt(
      [...resumeEvents, ...(inputEvent ? [inputEvent] : []), ...events],
      agent,
    );

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
      usage: { ...usage, toolCalls },
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
  if (parentContext.session) {
    delegatedSessionParents.set(session, parentContext.session);
  }
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
 * Parent session of each child session built by the gateway. A child context
 * keeps the parent's `sessionService` (spread above), but its session object
 * is a private copy that the service does not own.
 */
const delegatedSessionParents = new WeakMap<Session, Session>();

/**
 * The session a delegated run's events finally reach: the session itself, or,
 * for a child session the gateway built, the first ancestor that is not one.
 * Nothing may append to a child session through the context's
 * `sessionService`; the root session is the one that service owns.
 *
 * @param session - Session of an invocation context.
 * @returns The root session, or `session` when it is not a child session.
 * @internal
 */
export function rootSessionOf(session: Session): Session {
  let current = session;
  for (
    let parent = delegatedSessionParents.get(current);
    parent !== undefined;
    parent = delegatedSessionParents.get(current)
  ) {
    current = parent;
  }
  return current;
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
  inputEvent: Event | undefined;
  priorEvents: readonly Event[];
  sessionState: Readonly<Record<string, unknown>> | undefined;
  sessionStateMode: "merge" | "replace";
  sessionHistoryMode: "inherit" | "replace";
}): ChildSession {
  const frozen = sessionStateMode === "replace";
  // `sessionState` is the caller's object: copy it deeply as well, so no
  // nested value is shared with the caller in either mode.
  const projected = cloneState(sessionState ?? {});
  const baseState = frozen
    ? projected
    : { ...cloneState(parentSession.state), ...projected };
  // Deltas recorded by the events of an interrupted run are part of the
  // delegation's state (they were applied to the previous child session).
  for (const event of priorEvents) {
    if (event.partial) continue;
    for (const [key, value] of Object.entries(
      event.actions?.stateDelta ?? {},
    )) {
      if (!isTempStateKey(key)) {
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
      ...(inputEvent ? [inputEvent] : []),
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
      const cloned = structuredClone(value);
      keepFrozen(value, cloned, new WeakSet());
      copy[key] = cloned;
    } catch {
      // Not cloneable: omit rather than share a mutable reference.
    }
  }
  return copy;
}

/**
 * Freezes each object of `copy` whose counterpart in `source` is frozen, so a
 * deep copy keeps the immutability the caller gave its value (a task
 * projection stays frozen in the child session).
 */
function keepFrozen(source: unknown, copy: unknown, seen: WeakSet<object>) {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof copy !== "object" ||
    copy === null ||
    seen.has(copy)
  ) {
    return;
  }
  seen.add(copy);
  for (const key of Object.keys(copy)) {
    keepFrozen(
      (source as Record<string, unknown>)[key],
      (copy as Record<string, unknown>)[key],
      seen,
    );
  }
  if (Object.isFrozen(source)) Object.freeze(copy);
}

/** `isFinalResponse` tolerant of externally built events without `actions`. */
function isFinal(event: Event): boolean {
  return isFinalResponse(
    event.actions ? event : { ...event, actions: createEventActions() },
  );
}

/**
 * Whether the events end waiting for a human or external system. Uses ADK's
 * own `getPendingUserInputRequests` (unanswered `adk_request_*` calls) plus
 * every unanswered long-running call, wherever its event is: ADK 2.4's
 * `LlmAgent` emits the call, the tool's pending response and then keeps going,
 * so the call is not necessarily on the last event. ADK's `Workflow` likewise
 * marks a node as interrupted by any event carrying `longRunningToolIds`.
 * `NodeTool` calls are skipped, wherever the calling `LlmAgent` sits in the
 * delegated tree: see {@link nodeToolCallIds}.
 */
function findInterrupt(
  allEvents: readonly Event[],
  agent: BaseAgent,
): AgentInvocationInterrupt | undefined {
  const events = allEvents.filter((event) => !event.partial);
  const requests = getPendingUserInputRequests(events);
  const nodeToolCalls = nodeToolCallIds(events, agent);
  const functionCallIds = [
    ...new Set([
      ...requests.map((request) => request.interruptId),
      ...pendingLongRunningCallIds(events).filter(
        (id) => !nodeToolCalls.has(id),
      ),
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
 * Ids in `longRunningToolIds` not answered by a later `user` function response.
 * The response the tool itself returns is authored by the agent, so it never
 * answers the call.
 */
function pendingLongRunningCallIds(events: readonly Event[]): string[] {
  const pending = new Set<string>();
  for (const event of events) {
    if (event.author === "user") {
      for (const part of event.content?.parts ?? []) {
        const id = part.functionResponse?.id;
        if (typeof id === "string") pending.delete(id);
      }
    }
    for (const id of event.longRunningToolIds ?? []) {
      if (typeof id === "string" && id !== "") pending.add(id);
    }
  }
  return [...pending];
}

/** Brand ADK puts on every `NodeTool` (`isNodeTool` is not a public export). */
const NODE_TOOL_BRAND = Symbol.for("google.adk.workflow.nodeTool");

function isNodeTool(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[NODE_TOOL_BRAND] === true
  );
}

/**
 * Long-running call ids whose tool is an ADK `NodeTool`. ADK builds every
 * `NodeTool` with `isLongRunning: true` so a paused node can resume, but the
 * call is not a human request: a completed node returns its output as the
 * function response, and a paused node returns nothing while the node's own
 * interrupt events (with their own `longRunningToolIds`) surface in the stream
 * and are reported instead.
 *
 * A call is resolved in two ways, neither of which does I/O:
 * 1. By tool: the call name is looked up in the `tools` of every `LlmAgent`
 *    named like the event's author, anywhere in the delegated tree (see
 *    {@link llmAgentsByName}). A `NodeTool` there exempts the call; any other
 *    tool with that name keeps it pending, whatever else applies.
 * 2. By run marker, when no listed tool has that name (a tool from a
 *    `BaseToolset`, whose `getTools` may do I/O such as an MCP listing, or an
 *    author the walk cannot see, such as a dynamic or `ParallelWorker` node):
 *    `NodeTool` runs its node on the branch segment `<tool name>@<call id>`, so
 *    an event of this delegation on such a branch shows the call ran a node.
 *    A node that emits no event at all leaves no marker, and the call stays
 *    long-running (a spurious pause, never a missed request).
 */
function nodeToolCallIds(
  events: readonly Event[],
  agent: BaseAgent,
): Set<string> {
  const ids = new Set<string>();
  const owners = llmAgentsByName(agent);
  const branches = events.flatMap((event) =>
    event.branch ? [event.branch] : [],
  );
  for (const event of events) {
    const longRunning = event.longRunningToolIds ?? [];
    if (longRunning.length === 0) continue;
    const candidates = (event.author && owners.get(event.author)) || [];
    for (const call of getFunctionCalls(event)) {
      if (!call.id || !call.name || !longRunning.includes(call.id)) continue;
      const tool = resolveCallTool(candidates, call.name);
      if (
        tool === "node-tool" ||
        (tool === "unlisted" &&
          hasNodeToolRun(branches, `${call.name}@${call.id}`))
      ) {
        ids.add(call.id);
      }
    }
  }
  return ids;
}

/**
 * How a call name resolves on the candidate owners' listed tools. `other` (a
 * listed tool that is not a `NodeTool`) wins over `node-tool`, so a name clash
 * between agents keeps the call pending.
 */
function resolveCallTool(
  candidates: readonly LlmAgent[],
  name: string,
): "node-tool" | "other" | "unlisted" {
  let nodeTool = false;
  for (const candidate of candidates) {
    for (const tool of candidate.tools) {
      if (isBaseToolset(tool)) continue;
      if ((tool as { name?: unknown }).name !== name) continue;
      if (!isNodeTool(tool)) return "other";
      nodeTool = true;
    }
  }
  return nodeTool ? "node-tool" : "unlisted";
}

/**
 * Every `LlmAgent` reachable from `root` without I/O, by name: sub-agents, the
 * node of each listed `NodeTool`, and the graph nodes of each ADK `Workflow`
 * (which are not registered as `subAgents`). Names are only unique within one
 * agent tree, so a name may map to several agents.
 */
function llmAgentsByName(root: BaseAgent): Map<string, LlmAgent[]> {
  const byName = new Map<string, LlmAgent[]>();
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (isWorkflow(node)) {
      for (const child of node.graph?.nodes ?? []) visit(child);
      return;
    }
    if (!isBaseAgent(node)) return;
    if (isLlmAgent(node)) {
      const named = byName.get(node.name);
      if (named) named.push(node);
      else byName.set(node.name, [node]);
      for (const tool of node.tools) {
        if (isNodeTool(tool)) visit((tool as { node?: unknown }).node);
      }
    }
    for (const child of node.subAgents) visit(child);
  };
  visit(root);
  return byName;
}

/**
 * Whether `marker` (`<tool name>@<call id>`) is one whole run segment of some
 * event's branch. Tool names may contain `.`, the branch separator, so the
 * marker is matched at segment boundaries instead of splitting the branch.
 */
function hasNodeToolRun(branches: readonly string[], marker: string): boolean {
  return branches.some(
    (branch) =>
      branch === marker ||
      branch.startsWith(`${marker}.`) ||
      branch.endsWith(`.${marker}`) ||
      branch.includes(`.${marker}.`),
  );
}

/**
 * Combines the active signals with the platform `AbortSignal.any` (Node 22 or later),
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

/**
 * Throws the gateway's abort error for the signal (see `abortError`) when it
 * aborted.
 */
function throwIfInvocationAborted(signal: AbortSignal | undefined): void {
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
    usage: emptyUsage(),
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

function emptyUsage(): AgentInvocationUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    toolCalls: 0,
    llmCalls: 0,
  };
}

function addUsage(usage: AgentInvocationUsage, event: Event): void {
  const meta = event.usageMetadata;
  if (!meta) return;
  const prompt = meta.promptTokenCount ?? 0;
  const completion = meta.candidatesTokenCount ?? 0;
  usage.promptTokens += prompt;
  usage.completionTokens += completion;
  usage.totalTokens += meta.totalTokenCount ?? prompt + completion;
  usage.cachedTokens += meta.cachedContentTokenCount ?? 0;
  usage.llmCalls++;
}
