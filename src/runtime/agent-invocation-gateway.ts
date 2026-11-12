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
  isBaseLlm,
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
import { EXTERNAL_AGENT_MODEL_METADATA_KEY } from "../agents/events.js";
import { inheritSessionPermissions } from "../agents/permissions/inheritance.js";
import {
  CACHE_CREATION_METADATA_KEY,
  COST_METADATA_KEY,
} from "../converters/cache-usage.js";
import { isTempStateKey, withoutTempStateKeys } from "../utils/state.js";
import { isWorkflowAgent } from "../workflows/internal/workflow-agent-brand.js";

/**
 * Aggregate model usage of one delegated agent run.
 *
 * @remarks
 * The sum of `usageMetadata` over the run's non-partial events (nested agent
 * and workflow events included, since the gateway sees them) plus the function
 * calls requested on those same events. Values are summed as each runtime
 * reports them, so any double counting in a runtime's report carries into the
 * totals. Cost is not computed here: `costUsd` sums what the providers
 * reported (`customMetadata.costUsd`), and is absent when none did.
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
  /**
   * Summed `customMetadata.cacheCreationTokenCount`: tokens written to the
   * prompt cache. Part of `promptTokens` for providers that count them there
   * (Anthropic); for the others it is as the provider reports. Absent when no
   * event in the run reported a cache write.
   */
  cacheCreationTokens?: number;
  /**
   * Summed `customMetadata.costUsd`: US dollars the providers reported
   * charging for the run's model calls (AI Gateway and OpenRouter `usage.cost`;
   * for a BYOK gateway call, the upstream or market cost the gateway
   * reports, see `COST_METADATA_KEY`). Absent when no event reported one,
   * which includes `ExternalAgent` runs: their cost is on their own usage
   * report and spans, not on the event.
   */
  costUsd?: number;
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
 * - `llm-calls-limit`: the shared `RunConfig.maxLlmCalls` budget was exhausted (a thrown
 *   `LlmCallsLimitExceededError`, or the error event `LlmAgent` yields for it).
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

/**
 * Continuation data for an interrupted delegation.
 *
 * @remarks
 * Trust model: the gateway trusts `events` as given. It does not check that
 * they came from an earlier result of this gateway, and it keeps no record of
 * which interrupts were already answered, so it does not guard against
 * replay: passing the same events and answer twice resumes the delegation
 * twice, and a tool the answer approves can run twice. The caller must
 * consume each interrupt once, and store the events where tools and model
 * output cannot write them (not in session state a tool can change).
 */
export interface AgentInvocationResume {
  /**
   * `interrupt.events` of the interrupted result, unchanged. Trusted as
   * given; see the trust model above.
   */
  events: readonly Event[];
}

/** The first model response of a run that stopped before the model was done. */
export interface AgentInvocationIncomplete {
  /** Finish reason of the response, such as `MAX_TOKENS` or `SAFETY`. */
  finishReason: string;
  /** Name of the agent that produced the response. */
  author: string;
  /** `usageMetadata.candidatesTokenCount` of that response. */
  outputTokens?: number;
  /** `usageMetadata.thoughtsTokenCount`; reasoning counts against the cap. */
  thoughtsTokens?: number;
  /**
   * `generateContentConfig.maxOutputTokens` of the author when exactly one
   * `LlmAgent` has that name and sets one. This is the configured cap, not
   * necessarily the cap that was sent (callbacks and provider defaults can
   * change it).
   */
  maxOutputTokens?: number;
}

/**
 * Finish reasons of a response that stopped before the model was done:
 * the output cap and the content filters.
 */
const INCOMPLETE_FINISH_REASONS: ReadonlySet<string> = new Set([
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
]);

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
   * The models of the run; see {@link AgentInvocationModels}. Absent when the
   * run has no model information and nothing is unknown, such as a plain
   * custom agent.
   */
  models?: AgentInvocationModels;
  /**
   * Merged state delta of the non-partial events, without ADK `temp:` keys;
   * absent when empty.
   */
  stateDelta?: Record<string, unknown>;
  /**
   * `finishReason` of the event that produced `output`: the last final
   * non-partial event with text, else the last final event that has one.
   * Absent when the provider reported none.
   */
  finishReason?: string;
  /**
   * The first incomplete model response of the run; see
   * {@link AgentInvocationIncomplete}. Data only: the gateway still does not
   * fail the run, so delegation tools behave as before.
   */
  incomplete?: AgentInvocationIncomplete;
  /** Failure message; absent on success. */
  error?: string;
  /** Classification of `error`. */
  errorKind?: AgentInvocationErrorKind;
  /** Present when the child stopped waiting for input; see the type docs. */
  interrupt?: AgentInvocationInterrupt;
}

/**
 * The models of one delegated agent run.
 *
 * @remarks
 * Collected over the run's non-partial events, nested agents included. A
 * model id appears once, in first-seen order. `requested` holds the ids the
 * agents were configured with, and `resolved` the ids a trusted runtime
 * reported (an external agent's reported model, or the `modelVersion` of an
 * LLM response). `unknown` is true when a run was not fully explicit and
 * reported: an external run with no requested model, a status other than
 * `reported`, or no model information at all, or an `LlmAgent` whose model is
 * inherited or cannot be read. Agents nested below the delegated agent are
 * read from the `author` of the events they yield, so an agent that yields no
 * event is not seen.
 */
export interface AgentInvocationModels {
  /** Requested model ids, unique, in first-seen order. */
  requested: string[];
  /** Model ids a trusted runtime reported, unique, in first-seen order. */
  resolved: string[];
  /**
   * Every model the step's external runs billed (`externalAgentModel.used`),
   * unique, first-seen order. Present only when at least one run reported
   * `used`.
   */
  used?: string[];
  /**
   * The models of `used` nobody asked for (`externalAgentModel.unexpected`),
   * unique, first-seen order. Present exactly when `used` is.
   */
  unexpected?: string[];
  /**
   * Whether any run was not fully explicit and reported. An external run that
   * reported no `used` (Codex, Gemini, or a Claude run with no model usage)
   * also makes it `true`: its helper models are not known.
   */
  unknown: boolean;
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
  /**
   * Continues a previously interrupted delegation. The events are trusted
   * from the caller and not guarded against replay; see
   * {@link AgentInvocationResume}.
   */
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

    const rejected = validateResume(request, agent, startedAt);
    if (rejected) {
      return rejected;
    }

    const delegation = buildChildSession(request, agent);
    const tally = emptyTally();

    await request.validateInvocation?.("before-prepare");

    let preparationFailed = false;
    try {
      throwIfInvocationAborted(delegation.signal);
      await request.prepareContext?.(delegation.childContext, agent);
    } catch (caught) {
      preparationFailed = true;
      recordFailure(tally, caught, "preparation", delegation.signal);
    }

    if (!preparationFailed) {
      await request.validateInvocation?.("before-execute");
      await this.#driveEvents(request, agent, delegation, tally);
    }

    return aggregateResult(agent, startedAt, delegation, tally);
  }

  /**
   * Streams the agent's events into the child session and the tally.
   *
   * @remarks
   * Each event is persisted with ADK's append rules, its non-`temp:` state
   * delta is merged (non-partial events only), the gateway sink and then the
   * request sink see it, and only then is it counted. A thrown error or an
   * abort is recorded in the tally, never rethrown. On any exit before the
   * generator is exhausted the generator is closed; the close is awaited
   * unless the run was aborted, since an aborted generator may be parked on
   * an await that `return()` would queue behind.
   *
   * @param request - The delegation request (supplies the request sink).
   * @param agent - The resolved agent to run.
   * @param delegation - Child session, context and signal of this run.
   * @param tally - Accumulator updated in place.
   */
  async #driveEvents(
    request: AgentInvocationRequest,
    agent: BaseAgent,
    delegation: ChildDelegation,
    tally: RunTally,
  ): Promise<void> {
    const { child, childContext, signal } = delegation;
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
        tally.events.push(persisted);
        if (!persisted.partial) {
          // `temp:` keys stay out of the aggregate even when the installed
          // ADK keeps them on the event, so they never reach a checkpoint.
          Object.assign(
            tally.stateDelta,
            withoutTempStateKeys(persisted.actions?.stateDelta ?? {}),
          );
        }
        await this.#eventSink?.(persisted, childContext);
        await request.eventSink?.(persisted, childContext);
        countEvent(tally, persisted, childContext, agent);
      }
    } catch (caught) {
      recordFailure(tally, caught, "agent-error", signal);
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
}

/**
 * Checks that a `resume` request answers a pending interrupt of its events.
 *
 * @remarks
 * Passes when the request has no `resume`. Otherwise at least one
 * `functionResponse` id of `request.input` must be among the pending function
 * call ids that {@link findInterrupt} reports for `resume.events`.
 *
 * @param request - The delegation request.
 * @param agent - The resolved agent (used to tell `NodeTool` calls apart).
 * @param startedAt - Start time of the run, for the failed result's duration.
 * @returns An `invalid-resume` failed result, or `undefined` when the resume is valid or absent.
 */
function validateResume(
  request: AgentInvocationRequest,
  agent: BaseAgent,
  startedAt: number,
): AgentInvocationResult | undefined {
  if (!request.resume) {
    return undefined;
  }
  const pending = findInterrupt(request.resume.events ?? [], agent);
  const answered = new Set(
    (request.input.parts ?? [])
      .map((part) => part.functionResponse?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (pending?.functionCallIds.some((id) => answered.has(id))) {
    return undefined;
  }
  return failedResult(
    request.agentName,
    startedAt,
    "Resume input does not answer a pending interrupt",
    "invalid-resume",
  );
}

/** Child session, context and abort signal of one delegation. */
interface ChildDelegation {
  /** Combined parent and request abort signal, if any. */
  signal: AbortSignal | undefined;
  /** Events carried by `resume`, or empty. */
  resumeEvents: readonly Event[];
  /** The appended input event; absent with `appendInput: false`. */
  inputEvent: Event | undefined;
  /** The isolated child session. */
  child: ChildSession;
  /** Invocation context the agent runs in. */
  childContext: InvocationContext;
}

/**
 * Builds the isolated child session and invocation context of a delegation.
 *
 * @remarks
 * Combines the parent and request abort signals, creates the input event
 * (unless `appendInput` is `false`), builds the child session from the
 * state/history modes and the resume events, gives it the caller's
 * permission ceiling, and creates the child invocation context.
 *
 * @param request - The delegation request.
 * @param agent - The resolved agent.
 * @returns The child session, context, signal, input event and resume events.
 */
function buildChildSession(
  request: AgentInvocationRequest,
  agent: BaseAgent,
): ChildDelegation {
  const resumeEvents = request.resume?.events ?? [];
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
  return { signal, resumeEvents, inputEvent, child, childContext };
}

/** Running totals of one delegation, filled while its events stream. */
interface RunTally {
  /** Persisted events, partial ones included, in order. */
  events: Event[];
  /** Visible text of each non-partial text event. */
  text: string[];
  /** Function-response or error output of events without visible text. */
  fallbackOutput: string[];
  /** Merged non-`temp:` state delta of the non-partial events. */
  stateDelta: Record<string, unknown>;
  /** Visible text of the last final event that had text. */
  finalText: string | undefined;
  /** Finish reason of the event behind `finalText`. */
  finishReason: string | undefined;
  /** First incomplete model response. */
  incomplete: AgentInvocationIncomplete | undefined;
  /** Non-partial events with visible text. */
  textEvents: number;
  /** Function calls on non-partial events. */
  toolCalls: number;
  /** Token usage summed over non-partial events. */
  usage: AgentInvocationUsage;
  /** Model ids seen on non-partial events. */
  models: ModelTally;
  /** Errors seen (event errors and thrown errors). */
  errors: number;
  /** Message of the last error. */
  error: string | undefined;
  /** Classification of the last error. */
  errorKind: AgentInvocationErrorKind | undefined;
}

/** Model ids and flags collected from the events of one run. */
interface ModelTally {
  requested: string[];
  resolved: string[];
  /** Union of the runs' `used`; `undefined` until a run reports one. */
  used: string[] | undefined;
  /** Union of the runs' `unexpected`; set together with `used`. */
  unexpected: string[] | undefined;
  /** A run reported a status other than `reported`, no requested model, or no `used`. */
  unknown: boolean;
  /** Authors with at least one well-formed external model info. */
  infoAuthors: Set<string>;
  /** Authors of non-partial events that were already described. */
  describedAuthors: Set<string>;
  /** Described authors that are external agents, whose events must carry info. */
  externalAuthors: Set<string>;
  /** Authors found in no agent tree, which need their own info. */
  unfoundAuthors: Set<string>;
}

/** A tally with nothing counted yet. */
function emptyTally(): RunTally {
  return {
    events: [],
    text: [],
    fallbackOutput: [],
    stateDelta: {},
    finalText: undefined,
    finishReason: undefined,
    incomplete: undefined,
    textEvents: 0,
    toolCalls: 0,
    usage: emptyUsage(),
    models: {
      requested: [],
      resolved: [],
      used: undefined,
      unexpected: undefined,
      unknown: false,
      infoAuthors: new Set(),
      describedAuthors: new Set(),
      externalAuthors: new Set(),
      unfoundAuthors: new Set(),
    },
    errors: 0,
    error: undefined,
    errorKind: undefined,
  };
}

/**
 * Records a thrown error. An aborted signal classifies it `aborted` and an
 * LLM call limit error `llm-calls-limit`, whatever `fallbackKind` says.
 */
function recordFailure(
  tally: RunTally,
  caught: unknown,
  fallbackKind: AgentInvocationErrorKind,
  signal: AbortSignal | undefined,
): void {
  tally.errors++;
  tally.error = errorMessage(caught);
  tally.errorKind = signal?.aborted
    ? "aborted"
    : isLlmCallsLimitExceededError(caught)
      ? "llm-calls-limit"
      : fallbackKind;
}

/** Counts one persisted event's text, fallback output, calls, usage and error. */
function countEvent(
  tally: RunTally,
  persisted: Event,
  context: InvocationContext,
  agent: BaseAgent,
): void {
  const visible = persisted.partial ? undefined : extractVisibleText(persisted);
  if (visible) {
    tally.textEvents++;
    tally.text.push(visible);
    if (isFinal(persisted)) {
      tally.finalText = visible;
      tally.finishReason = persisted.finishReason;
    }
  } else {
    const fallback = extractFallbackOutput(persisted);
    if (fallback) {
      tally.fallbackOutput.push(fallback);
    }
  }
  if (!tally.incomplete) {
    tally.incomplete = incompleteResponse(persisted, agent);
  }
  if (!persisted.partial) {
    if (
      !visible &&
      tally.finalText === undefined &&
      persisted.finishReason &&
      isFinal(persisted)
    ) {
      tally.finishReason = persisted.finishReason;
    }
    // A streamed function call is repeated on the final event.
    tally.toolCalls += getFunctionCalls(persisted).length;
    addUsage(tally.usage, persisted);
    countModels(tally.models, persisted, agent);
  }
  if (persisted.errorMessage) {
    tally.errors++;
    tally.error = persisted.errorMessage;
    tally.errorKind = isLlmCallsLimitEvent(persisted, context)
      ? "llm-calls-limit"
      : "agent-error";
  }
}

/**
 * The incomplete model response an event is, if any.
 *
 * @remarks
 * Only a non-partial event of a model (not the user), without an error and
 * without function calls, whose finish reason is in
 * {@link INCOMPLETE_FINISH_REASONS}. Content is not required: a cut that
 * left only reasoning, or nothing, is incomplete too. An event authored at
 * or under a nested bridge workflow agent is skipped: that workflow decides
 * for its own steps. A name shared by agents inside and outside such a
 * workflow is not skipped.
 */
function incompleteResponse(
  event: Event,
  root: BaseAgent,
): AgentInvocationIncomplete | undefined {
  const { finishReason, author } = event;
  if (
    event.partial ||
    !author ||
    author === "user" ||
    event.errorMessage ||
    typeof finishReason !== "string" ||
    !INCOMPLETE_FINISH_REASONS.has(finishReason) ||
    getFunctionCalls(event).length > 0 ||
    isUnderNestedWorkflow(root, author)
  ) {
    return undefined;
  }
  const owners = llmAgentsByName(root).get(author);
  const cap =
    owners?.length === 1
      ? owners[0]?.generateContentConfig?.maxOutputTokens
      : undefined;
  const usage = event.usageMetadata;
  return {
    finishReason,
    author,
    ...(typeof usage?.candidatesTokenCount === "number"
      ? { outputTokens: usage.candidatesTokenCount }
      : {}),
    ...(typeof usage?.thoughtsTokenCount === "number"
      ? { thoughtsTokens: usage.thoughtsTokenCount }
      : {}),
    ...(typeof cap === "number" ? { maxOutputTokens: cap } : {}),
  };
}

/**
 * Whether every agent named `author` in the tree of `root` is a bridge
 * workflow agent or sits below one (the root itself counts). An author that
 * is not in the tree is not under one.
 */
function isUnderNestedWorkflow(root: BaseAgent, author: string): boolean {
  let found = false;
  let allNested = true;
  const seen = new Set<BaseAgent>();
  const visit = (node: BaseAgent, nested: boolean): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const inside = nested || isWorkflowAgent(node);
    if (node.name === author) {
      found = true;
      if (!inside) allNested = false;
    }
    for (const child of node.subAgents) visit(child, inside);
  };
  visit(root, false);
  return found && allNested;
}

/**
 * Whether an error event is `LlmAgent` reporting an exhausted `maxLlmCalls`.
 *
 * @remarks
 * `LlmAgent` catches the `LlmCallsLimitExceededError` thrown by
 * `incrementLlmCallCount()` and yields an error event instead of rethrowing
 * (ADK 2.4, `LlmAgent.runAndHandleError`). The event has no typed marker, so
 * all three signals must hold: `errorCode` `UNKNOWN_ERROR`, the message
 * `Max number of llm calls limit of <maxLlmCalls> exceeded` with the run's own
 * positive budget, and ADK's shared call counter over that budget (ADK
 * increments it before it throws). The counter is a runtime-only field of the
 * context; when it cannot be read as a number the answer is `false`, so a
 * future ADK that renames it degrades to `agent-error`, never to a false limit.
 */
function isLlmCallsLimitEvent(
  event: Event,
  context: InvocationContext,
): boolean {
  const maxLlmCalls = context.runConfig?.maxLlmCalls;
  if (typeof maxLlmCalls !== "number" || !(maxLlmCalls > 0)) {
    return false;
  }
  if (
    event.errorCode !== "UNKNOWN_ERROR" ||
    event.errorMessage !==
      `Max number of llm calls limit of ${maxLlmCalls} exceeded`
  ) {
    return false;
  }
  const calls = readLlmCallCount(context);
  return calls !== undefined && calls > maxLlmCalls;
}

/** Reads ADK's shared LLM call counter, or `undefined` when it is not there. */
function readLlmCallCount(context: InvocationContext): number | undefined {
  const manager = (context as unknown as Record<string, unknown>)
    .invocationCostManager;
  if (typeof manager !== "object" || manager === null) {
    return undefined;
  }
  const calls = (manager as Record<string, unknown>).numberOfLlmCalls;
  return typeof calls === "number" && Number.isFinite(calls)
    ? calls
    : undefined;
}

/** Appends a model id when it is not in the list yet. */
function addModelId(list: string[], id: string): void {
  if (!list.includes(id)) list.push(id);
}

/**
 * Reads the model info `ExternalAgent` puts on an event, or `undefined` when
 * the value is missing or malformed (so a forged value cannot name a model).
 */
function readExternalModelInfo(event: Event):
  | {
      requested?: string;
      resolved?: string;
      status: string;
      used?: string[];
      unexpected?: string[];
    }
  | undefined {
  const value: unknown =
    event.customMetadata?.[EXTERNAL_AGENT_MODEL_METADATA_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { requested, resolved, status, used, unexpected } = value as Record<
    string,
    unknown
  >;
  const optionalId = (id: unknown) =>
    id === undefined || (typeof id === "string" && id.length > 0);
  if (!optionalId(requested) || !optionalId(resolved)) return undefined;
  const idList = (list: unknown) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every((id) => typeof id === "string" && id.length > 0));
  if (!idList(used) || !idList(unexpected)) return undefined;
  // `unexpected` exists exactly when `used` does.
  if ((used === undefined) !== (unexpected === undefined)) return undefined;
  if (status === "reported") {
    if (resolved === undefined) return undefined;
  } else if (
    (status !== "not-reported" && status !== "unsupported") ||
    resolved !== undefined
  ) {
    return undefined;
  }
  return {
    ...(requested !== undefined ? { requested: requested as string } : {}),
    ...(resolved !== undefined ? { resolved: resolved as string } : {}),
    status,
    ...(used !== undefined
      ? { used: used as string[], unexpected: unexpected as string[] }
      : {}),
  };
}

/**
 * Counts the model ids of one non-partial event: an external run's model info,
 * or the `modelVersion` of an LLM response.
 */
function countModels(models: ModelTally, event: Event, agent: BaseAgent): void {
  const author = event.author ?? "";
  describeAuthor(models, author, agent);
  const info = readExternalModelInfo(event);
  if (info) {
    models.infoAuthors.add(author);
    if (info.requested) addModelId(models.requested, info.requested);
    else models.unknown = true;
    if (info.status === "reported" && info.resolved) {
      addModelId(models.resolved, info.resolved);
    } else {
      models.unknown = true;
    }
    if (info.used === undefined) {
      models.unknown = true;
    } else {
      models.used ??= [];
      models.unexpected ??= [];
      for (const id of info.used) addModelId(models.used, id);
      for (const id of info.unexpected ?? []) addModelId(models.unexpected, id);
    }
    return;
  }
  if (typeof event.modelVersion === "string" && event.modelVersion.length > 0) {
    addModelId(models.resolved, event.modelVersion);
  }
}

/**
 * Describes the author of an event once: an agent below the step's agent (an
 * ADK composite's children, sub-agents) is read like the step's own agent, so
 * its requested id is named and an inherited or unreadable model makes the
 * run unknown. An author found in no tree needs a model info of its own, and
 * an external author must carry one too (checked in {@link runModels}). The
 * step's own agent is described by `runModels`, and the user is not an agent.
 */
function describeAuthor(
  models: ModelTally,
  author: string,
  agent: BaseAgent,
): void {
  if (author === "" || author === agent.name || author === "user") return;
  if (models.describedAuthors.has(author)) return;
  models.describedAuthors.add(author);
  const found = agent.findAgent(author);
  if (!found) {
    models.unfoundAuthors.add(author);
    return;
  }
  const described = describeAgentModel(found);
  if (described.requested) addModelId(models.requested, described.requested);
  if (described.unknown) models.unknown = true;
  if (described.external) models.externalAuthors.add(author);
}

/**
 * What an agent was configured to run, read without running it.
 *
 * @remarks
 * `requested` is the model id the agent names: an external agent's driver
 * `model`, an `LlmAgent`'s string or model instance. An `LlmAgent` without a
 * model of its own inherits one from an ancestor `LlmAgent`: the inherited id
 * is named and `unknown` is true. When no model can be read (`canonicalModel`
 * throws) there is no `requested` and `unknown` is true. `external` marks an
 * agent that has a driver, whose events decide `unknown`.
 *
 * @param agent - The agent to describe.
 * @returns What the agent names.
 * @internal
 */
export function describeAgentModel(agent: BaseAgent): {
  requested?: string;
  unknown: boolean;
  external: boolean;
} {
  if (isLlmAgent(agent)) {
    const model: unknown = agent.model;
    if (typeof model === "string" && model.length > 0) {
      return { requested: model, unknown: false, external: false };
    }
    if (isBaseLlm(model)) {
      const id: unknown = model.model;
      return typeof id === "string" && id.length > 0
        ? { requested: id, unknown: false, external: false }
        : { unknown: true, external: false };
    }
    try {
      const inherited: unknown = agent.canonicalModel.model;
      return typeof inherited === "string" && inherited.length > 0
        ? { requested: inherited, unknown: true, external: false }
        : { unknown: true, external: false };
    } catch {
      return { unknown: true, external: false };
    }
  }
  const driver: unknown = (agent as { driver?: unknown }).driver;
  if (
    typeof driver === "object" &&
    driver !== null &&
    typeof (driver as { providerId?: unknown }).providerId === "string"
  ) {
    const model: unknown = (driver as { model?: unknown }).model;
    return {
      ...(typeof model === "string" && model.length > 0
        ? { requested: model }
        : {}),
      unknown: false,
      external: true,
    };
  }
  return { unknown: false, external: false };
}

/** The run's models, or `undefined` when there is nothing to report. */
function runModels(
  agent: BaseAgent,
  tally: RunTally,
): AgentInvocationModels | undefined {
  const own = describeAgentModel(agent);
  const requested: string[] = [];
  if (own.requested) addModelId(requested, own.requested);
  for (const id of tally.models.requested) addModelId(requested, id);
  const resolved = [...tally.models.resolved];
  const { infoAuthors } = tally.models;
  const unknown =
    tally.models.unknown ||
    own.unknown ||
    (own.external && !infoAuthors.has(agent.name)) ||
    [...tally.models.externalAuthors].some((name) => !infoAuthors.has(name)) ||
    [...tally.models.unfoundAuthors].some((name) => !infoAuthors.has(name));
  if (requested.length === 0 && resolved.length === 0 && !unknown) {
    return undefined;
  }
  return {
    requested,
    resolved,
    ...(tally.models.used !== undefined
      ? {
          used: [...tally.models.used],
          unexpected: [...(tally.models.unexpected ?? [])],
        }
      : {}),
    unknown,
  };
}

/**
 * Builds the public result of a delegation from its tally.
 *
 * @remarks
 * `output` is the last final text, else the transcript; the transcript is the
 * visible text, else the fallback output. The interrupt is computed over the
 * resume events, the input event and the run's events, in that order.
 * Optional keys (`stateDelta`, `error`, `errorKind`, `interrupt`) are present
 * only when they have a value.
 *
 * @param agent - The resolved agent (its name is the result's `agentName`).
 * @param startedAt - Start time of the run.
 * @param delegation - Child session data of the run.
 * @param tally - Totals collected while the events streamed.
 * @returns The aggregated result.
 */
function aggregateResult(
  agent: BaseAgent,
  startedAt: number,
  delegation: ChildDelegation,
  tally: RunTally,
): AgentInvocationResult {
  const { resumeEvents, inputEvent } = delegation;
  const { events, stateDelta, error, errorKind } = tally;
  const transcript =
    tally.text.length > 0
      ? tally.text.join("\n")
      : tally.fallbackOutput.join("\n");
  const interrupt = findInterrupt(
    [...resumeEvents, ...(inputEvent ? [inputEvent] : []), ...events],
    agent,
  );

  return {
    agentName: agent.name,
    output: tally.finalText ?? transcript,
    transcript,
    events,
    summary: {
      events: events.length,
      textEvents: tally.textEvents,
      toolCalls: tally.toolCalls,
      errors: tally.errors,
      durationMs: Date.now() - startedAt,
    },
    usage: { ...tally.usage, toolCalls: tally.toolCalls },
    ...modelsKey(runModels(agent, tally)),
    ...(Object.keys(stateDelta).length > 0 ? { stateDelta } : {}),
    ...(tally.finishReason ? { finishReason: tally.finishReason } : {}),
    ...(tally.incomplete ? { incomplete: tally.incomplete } : {}),
    ...(error ? { error } : {}),
    ...(error && errorKind ? { errorKind } : {}),
    ...(interrupt ? { interrupt } : {}),
  };
}

/** `{ models }`, or nothing when there are no models to report. */
function modelsKey(
  models: AgentInvocationModels | undefined,
): { models: AgentInvocationModels } | Record<string, never> {
  return models ? { models } : {};
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

/**
 * Non-thought, non-empty text parts of one event joined with `"\n"`, as ADK's
 * `AgentTool` merges a final event's parts.
 */
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
    .join("\n");
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
  const written = event.customMetadata?.[CACHE_CREATION_METADATA_KEY];
  if (typeof written === "number" && Number.isFinite(written) && written >= 0) {
    usage.cacheCreationTokens = (usage.cacheCreationTokens ?? 0) + written;
  }
  const cost = event.customMetadata?.[COST_METADATA_KEY];
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
    usage.costUsd = (usage.costUsd ?? 0) + cost;
  }
  usage.llmCalls++;
}
