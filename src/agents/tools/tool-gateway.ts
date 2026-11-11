import {
  type BaseAgent,
  createEvent,
  createEventActions,
  createSession,
  type Event,
  InvocationContext,
  type InvocationContextParams,
  PluginManager,
} from "@google/adk";
import { type Content, FinishReason } from "@google/genai";
import {
  type AgentInvocationErrorKind,
  AgentInvocationGateway,
  type AgentInvocationInterruptKind,
} from "../../runtime/agent-invocation-gateway.js";
import {
  errorTitle,
  itemTitle,
  stringOrEmpty,
  textTitle,
  toolCallTitle,
  toolResponseTitle,
} from "../event-titles.js";
import {
  EXTERNAL_AGENT_MODEL_METADATA_KEY,
  EXTERNAL_AGENT_TRANSFER_FAILED,
} from "../events.js";
import { delegatePermissions } from "../permissions/inheritance.js";
import { snapshotPermissionPolicy } from "../permissions/policy.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";
import { EXTERNAL_AGENT_TOOLS_METADATA_KEY } from "./adk-tool-bridge.js";

/** A request to run one ADK sub-agent. */
export interface RunSubAgentInput {
  /** Name of the sub-agent to run. */
  agentName: string;
  /** The task, sent to the sub-agent as a user message. */
  task: string;
}

/** Counts and timing of one sub-agent run. */
export interface RunSubAgentExecutionSummary {
  /** Events the sub-agent produced. */
  events: number;
  /** Events that carried text. */
  textEvents: number;
  /** Tool calls the sub-agent made. */
  toolCalls: number;
  /** Error events the sub-agent produced. */
  errors: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * A delegation that paused on a human: the sub-agent emitted an
 * `adk_request_confirmation` / `adk_request_input` / `adk_request_credential`
 * call or a long-running tool call (see `AgentInvocationResult.interrupt`).
 * The request event was already surfaced on the timeline; the user answers it
 * with a `functionResponse` on the next turn.
 */
export interface RunSubAgentInterrupt {
  /** Why the delegation paused: the kind of request the sub-agent raised. */
  kind: AgentInvocationInterruptKind;
  /** Ids that must be answered to resume. */
  functionCallIds: readonly string[];
}

/** Outcome of one sub-agent run. */
export interface RunSubAgentResult {
  /** Name of the sub-agent that ran. */
  agentName: string;
  /** The sub-agent's final text. */
  output: string;
  /** Number of events the sub-agent produced. */
  events: number;
  /** Counts and timing of the run. */
  summary: RunSubAgentExecutionSummary;
  /** Session-state changes the sub-agent made. */
  stateDelta?: Record<string, unknown>;
  /**
   * Set when the delegation failed, and also when it paused on the user
   * (`interrupt`): a paused delegation is never reported as a success.
   */
  error?: string;
  /**
   * Why the sub-agent run failed (`"aborted"`, `"llm-calls-limit"`,
   * `"preparation"`, `"agent-error"` or `"invalid-resume"`). Absent on
   * success and on a pause.
   */
  errorKind?: AgentInvocationErrorKind;
  /** Set when the delegation paused on the user. */
  interrupt?: RunSubAgentInterrupt;
}

/** Receives the events the gateway surfaces on the coordinator's timeline. */
export type ToolGatewayEventSink = (event: Event) => void;

/** What a {@link ToolGatewayDelegationTracer} learns about a delegation. */
export interface ToolGatewayDelegationInfo {
  /** Id of the delegation call on the timeline. */
  callId: string;
  /** Name of the sub-agent that receives the task. */
  agentName: string;
  /** `transfer_to_agent` (native shape) or `run_adk_subagent` (metadata-rich shape). */
  toolName: string;
  /** The call arguments as emitted on the timeline. */
  args: Record<string, unknown>;
}

/**
 * Wraps one delegation, from its call event to its result. `ExternalAgent`
 * uses it to run the sub-agent inside the delegation's `execute_tool` span.
 * It must call `run` once and return (or throw) what `run` does.
 */
export type ToolGatewayDelegationTracer = (
  info: ToolGatewayDelegationInfo,
  run: () => Promise<RunSubAgentResult>,
) => Promise<RunSubAgentResult>;

/**
 * Who owns the final answer after a delegation succeeds with a terminal text.
 *
 * - `"subagent"` (default, ADK-like): after `transfer_to_agent` the transferred
 *   agent's turn is the answer and the coordinator stays silent. The transfer
 *   functionResponse carries `actions.skipSummarization`, and the coordinator's
 *   next terminal text turn is dropped.
 * - `"coordinator"`: the coordinator may synthesize after one or several
 *   delegations (fan-out/aggregation); nothing is suppressed.
 */
export type DelegationFinalAnswer = "subagent" | "coordinator";

/** Delegation behavior of an `ExternalAgent` that has sub-agents. */
export interface DelegationOptions {
  /**
   * Who owns the final answer after a successful delegation.
   *
   * @defaultValue `"subagent"`
   */
  finalAnswer?: DelegationFinalAnswer;
}

/** Options for {@link ToolGateway}. */
export interface ToolGatewayConfig {
  /** Root agent of the invocation; sub-agents are looked up in its tree as a fallback. */
  rootAgent: BaseAgent;
  /** Sub-agents the runtime may delegate to. */
  subAgents: readonly BaseAgent[];
  /** Invocation context of the delegating agent. */
  parentContext: InvocationContext;
  /**
   * Effective permission policy of the delegating agent. Each sub-agent's
   * policy is derived from it and can only narrow it.
   */
  parentPermissions?: ExternalAgentPermissionPolicy;
  /** Receives the delegation and sub-agent events to put on the timeline. */
  eventSink?: ToolGatewayEventSink;
  /** Optional wrapper around each delegation (tracing). */
  traceDelegation?: ToolGatewayDelegationTracer;
  /**
   * Surface the sub-agent's own events on the timeline.
   *
   * @defaultValue `true`
   */
  exposeSubAgentEvents?: boolean;
  /**
   * When true the gateway emits events shaped like native ADK
   * `transfer_to_agent` delegation: a `transfer_to_agent` functionCall, a
   * functionResponse carrying `actions.transferToAgent`, sub-agent events on
   * the root branch with no external-agent metadata, and a suppressed root
   * re-narration. When false the metadata-rich `run_adk_subagent`
   * shape is emitted instead. `ExternalAgent` always uses the default.
   *
   * @defaultValue `true`
   */
  nativeDelegationShape?: boolean;
  /**
   * Final-answer ownership after a delegation.
   *
   * @defaultValue `{ finalAnswer: "subagent" }`
   */
  delegation?: DelegationOptions;
  /**
   * Called when a delegation pauses on the user (before `runSubAgent`
   * resolves). `ExternalAgent` uses it to end the coordinator's invocation, as
   * ADK does for a long-running call, so the coordinator does not carry on
   * while the user is being asked.
   */
  onInterrupt?: (result: RunSubAgentResult) => void;
  /**
   * Awaited before a delegation or transfer runs its target, after the
   * gateway emitted its own call events. `ExternalAgent` resolves it once the
   * runner has stored every event the agent yielded, so the target's view of
   * the session holds the coordinator's latest events, as in a native ADK
   * transfer.
   */
  waitForTimeline?: () => Promise<void>;
}

/**
 * Runs ADK sub-agents on behalf of an external runtime and surfaces the
 * delegation on the coordinator's timeline.
 *
 * @remarks
 * Each sub-agent inherits the parent's permission policy and can only narrow
 * it, so a delegation never grants more access than the delegating agent has.
 * One gateway serves one `ExternalAgent` invocation.
 */
export class ToolGateway {
  readonly #rootAgent: BaseAgent;
  readonly #subAgents: readonly BaseAgent[];
  readonly #parentContext: InvocationContext;
  readonly #parentPermissions?: ExternalAgentPermissionPolicy;
  readonly #eventSink?: ToolGatewayEventSink;
  readonly #traceDelegation?: ToolGatewayDelegationTracer;
  readonly #exposeSubAgentEvents: boolean;
  readonly #nativeDelegationShape: boolean;
  readonly #invocationGateway: AgentInvocationGateway;
  readonly #finalAnswer: DelegationFinalAnswer;
  readonly #onInterrupt?: (result: RunSubAgentResult) => void;
  readonly #waitForTimeline?: () => Promise<void>;
  /**
   * True while the most recent delegation ended with a terminal sub-agent
   * answer that the coordinator must not repeat. Per gateway instance (one per
   * ExternalAgent invocation), so it is neither context-wide nor shared across
   * bundles. Recomputed by every delegation: a failed or text-less delegation
   * clears it.
   */
  #finalAnswerPending = false;

  /** @param config - The agents, context and hooks the gateway works with. */
  constructor(config: ToolGatewayConfig) {
    this.#rootAgent = config.rootAgent;
    this.#subAgents = config.subAgents;
    this.#parentContext = config.parentContext;
    this.#parentPermissions = config.parentPermissions;
    this.#eventSink = config.eventSink;
    this.#traceDelegation = config.traceDelegation;
    this.#exposeSubAgentEvents = config.exposeSubAgentEvents ?? true;
    this.#nativeDelegationShape = config.nativeDelegationShape ?? true;
    this.#finalAnswer = config.delegation?.finalAnswer ?? "subagent";
    this.#onInterrupt = config.onInterrupt;
    this.#waitForTimeline = config.waitForTimeline;
    this.#invocationGateway = new AgentInvocationGateway({
      resolveAgent: (agentName) => this.findSubAgent(agentName),
    });
  }

  /**
   * Reports whether the coordinator's next terminal text turn repeats a
   * sub-agent answer and must be dropped. Reading it clears it.
   *
   * @returns `true` once after a delegation that ended with a terminal answer.
   */
  consumeFinalAnswer(): boolean {
    const pending = this.#finalAnswerPending;
    this.#finalAnswerPending = false;
    return pending;
  }

  /** The coordinator started new activity (e.g. another tool call): nothing to suppress. */
  resetFinalAnswer(): void {
    this.#finalAnswerPending = false;
  }

  /**
   * Runs a sub-agent and emits the delegation events.
   *
   * @remarks
   * Never throws for a sub-agent failure: an unknown agent, a failed run and
   * a run paused on the user (`interrupt`) all come back as a result with
   * `error` set, so a paused delegation is never reported as a success.
   *
   * @param input - The sub-agent name and task.
   * @returns The sub-agent's outcome.
   */
  async runSubAgent(input: RunSubAgentInput): Promise<RunSubAgentResult> {
    const agent = this.findSubAgent(input.agentName);
    if (!agent) {
      return unknownAgentResult(
        input.agentName,
        `Unknown ADK subagent: ${input.agentName}`,
      );
    }

    const callId = createBridgeCallId();
    // A new delegation starts: whatever the previous one decided is stale.
    this.#finalAnswerPending = false;
    const run = async (): Promise<RunSubAgentResult> => {
      const { surfacedError: _surfaced, ...result } = await this.delegate(
        input,
        agent,
        callId,
      );
      return result;
    };
    if (!this.#traceDelegation) {
      return run();
    }
    return this.#traceDelegation(
      {
        callId,
        agentName: agent.name,
        ...(this.#nativeDelegationShape
          ? { toolName: "transfer_to_agent", args: { agent_name: agent.name } }
          : { toolName: "run_adk_subagent", args: { ...input } }),
      },
      run,
    );
  }

  /**
   * Runs the agent an ADK tool transferred to (`toolContext.actions.transferToAgent`),
   * as ADK's `LlmAgent` does after the tool call.
   *
   * @remarks
   * The tool's own function response already carries `transferToAgent`, so
   * no `transfer_to_agent` call or response is emitted here. The target gets
   * the delegating agent's policy as a ceiling, like any delegation. It sees
   * the session history and gets `input` as its `userContent`. When `input`
   * is the invocation's own user message (already in the history), no new
   * user event is added, as in an ADK transfer; any other input is appended
   * as a user event, so the target's prompt holds it.
   * The target may be any agent of the tree except the delegating one. A run
   * that throws is reported as an error event with code
   * `EXTERNAL_AGENT_TRANSFER_FAILED`; error events of the target itself are
   * surfaced as they are.
   *
   * @param agentName - Name of the target agent.
   * @param input - User content the target runs on: the invocation's
   * `userContent`, or a message of its own when the invocation has none.
   * @returns The target's outcome; `error` is set for an unknown target.
   */
  async transferToAgent(
    agentName: string,
    input: Content,
  ): Promise<RunSubAgentResult> {
    const agent = this.findTransferTarget(agentName);
    if (!agent) {
      return unknownAgentResult(agentName, `Unknown ADK agent: ${agentName}`);
    }
    this.#finalAnswerPending = false;
    const result = await this.delegate(
      { agentName: agent.name, task: "" },
      agent,
      createBridgeCallId(),
      {
        input,
        synthetic: false,
        // The invocation's own user message is already in the history; any
        // other input (no user message to reuse) must be added to it.
        appendInput: input !== this.#parentContext.userContent,
      },
    );
    if (result.error && !result.interrupt && !result.surfacedError) {
      this.emit(
        createEvent({
          invocationId: this.#parentContext.invocationId,
          author: this.#parentContext.agent?.name ?? this.#rootAgent.name,
          branch: this.#parentContext.branch,
          errorCode: EXTERNAL_AGENT_TRANSFER_FAILED,
          errorMessage: `Transfer to ${agent.name} failed: ${result.error}`,
        }),
      );
    }
    const { surfacedError: _surfaced, ...rest } = result;
    return rest;
  }

  /**
   * Whether `agentName` is a valid transfer target: a known agent of the tree
   * other than the delegating agent.
   *
   * @param agentName - Name of the target agent.
   * @returns `true` when {@link ToolGateway.transferToAgent} can run it.
   */
  canTransferTo(agentName: string): boolean {
    return this.findTransferTarget(agentName) !== undefined;
  }

  private findTransferTarget(agentName: string): BaseAgent | undefined {
    const self = this.#parentContext.agent;
    if (self && agentName === self.name) return undefined;
    if (agentName === this.#rootAgent.name) return this.#rootAgent;
    return this.findSubAgent(agentName);
  }

  private async delegate(
    input: RunSubAgentInput,
    agent: BaseAgent,
    callId: string,
    options: {
      input?: Content;
      synthetic?: boolean;
      appendInput?: boolean;
    } = {},
  ): Promise<RunSubAgentResult & { surfacedError?: boolean }> {
    const synthetic = options.synthetic ?? true;
    if (synthetic) {
      this.emit(this.createFunctionCallEvent(input, callId));
    }

    // In native mode the transfer signal must fire BEFORE the sub-agent runs:
    // native ADK emits the transfer functionResponse carrying
    // actions.transferToAgent immediately, then the sub-agent's turns follow.
    // The Codex thread/resume stateDelta travels on the sub-agent's own
    // state_delta event (see shouldSurfaceSubAgentEvent), so this response
    // carries no stateDelta, exactly like a native transfer response.
    if (synthetic && this.#nativeDelegationShape) {
      this.emit(
        this.createFunctionResponseEvent({ agentName: agent.name }, callId),
      );
    }

    await this.#waitForTimeline?.();

    const invocation = await this.#invocationGateway.run({
      agentName: agent.name,
      input: options.input ?? { role: "user", parts: [{ text: input.task }] },
      // A transfer reuses the user message already in the history.
      appendInput: options.appendInput ?? synthetic,
      parentContext: withToolGatewaySession(this.#parentContext),
      // Native transfer shares the session: the child sees the parent's state
      // and history, and its state changes merge back. Explicit because the
      // gateway defaults are not ours to rely on.
      sessionStateMode: "merge",
      sessionHistoryMode: "inherit",
      branch: this.#nativeDelegationShape
        ? this.#parentContext.branch
        : childBranch(this.#parentContext.branch, agent.name),
      prepareContext: (childContext) => {
        delegatePermissions(
          childContext.session,
          this.#parentPermissions,
          readAgentPermissions(agent),
          agent,
        );
        if (!this.#nativeDelegationShape) {
          const delegatedTaskEvent = childContext.session.events.at(-1) as
            | (Event & { customMetadata?: Record<string, unknown> })
            | undefined;
          if (delegatedTaskEvent) {
            delegatedTaskEvent.customMetadata = {
              externalAgent: true,
              delegatedTask: true,
              toolName: "run_adk_subagent",
            };
          }
        }
      },
      eventSink: (event) => {
        if (
          this.#exposeSubAgentEvents &&
          this.shouldSurfaceSubAgentEvent(event)
        ) {
          this.emit(
            this.prepareSubAgentEvent({
              event,
              subAgentName: agent.name,
              parentToolCallId: callId,
            }),
          );
        }
      },
    });

    const interrupt: RunSubAgentInterrupt | undefined = invocation.interrupt
      ? {
          kind: invocation.interrupt.kind,
          functionCallIds: [...invocation.interrupt.functionCallIds],
        }
      : undefined;
    const error =
      invocation.error ??
      (interrupt
        ? `Sub-agent ${agent.name} is waiting for user input (${interrupt.kind}). Stop now; the task resumes after the user answers.`
        : undefined);
    const result: RunSubAgentResult = {
      agentName: agent.name,
      output: invocation.output,
      events: invocation.summary.events,
      summary: invocation.summary,
      ...(invocation.stateDelta ? { stateDelta: invocation.stateDelta } : {}),
      ...(error ? { error } : {}),
      ...(invocation.errorKind ? { errorKind: invocation.errorKind } : {}),
      ...(interrupt ? { interrupt } : {}),
    };

    // Legacy mode keeps the loop-then-response order with the aggregated
    // stateDelta attached to the response. Native mode already emitted its
    // (clean) transfer response before the loop.
    if (synthetic && !this.#nativeDelegationShape) {
      this.emit(this.createFunctionResponseEvent(result, callId));
    }

    // In native-shape mode, a successful delegation that produced a terminal
    // sub-agent answer is the final answer. Signal the ExternalAgent to drop
    // the root model's redundant re-narration turn (native coordinators stay
    // silent after transfer).
    // A paused delegation has no final answer yet.
    this.#finalAnswerPending =
      this.#nativeDelegationShape &&
      this.#finalAnswer === "subagent" &&
      !error &&
      invocation.summary.textEvents > 0;

    if (interrupt) {
      this.#onInterrupt?.(result);
    }
    return {
      ...result,
      surfacedError: invocation.events.some((event) => event.errorMessage),
    };
  }

  /**
   * Decides whether a sub-agent event surfaces on the shared timeline.
   * Legacy mode surfaces everything. Native mode drops content-less events
   * (blank bubbles) except those carrying a non-empty `actions.stateDelta`
   * (for example the Codex driver's `codex_thread` marker, emitted when the
   * thread starts) or `actions.escalate`. Surfacing the state-only event lets
   * the ADK runner commit its stateDelta to `session.state` as it does for
   * native sub-agents, so Codex resume works without the transfer response
   * carrying the delta.
   */
  private shouldSurfaceSubAgentEvent(event: Event): boolean {
    if (!this.#nativeDelegationShape) {
      return true;
    }
    if (event.errorMessage) {
      return true;
    }
    const parts = event.content?.parts ?? [];
    const hasRenderableContent = parts.some(
      (part) =>
        (typeof part.text === "string" && part.text.length > 0) ||
        part.functionCall ||
        part.functionResponse ||
        part.inlineData,
    );
    if (hasRenderableContent) {
      return true;
    }
    // Keep content-less events that still carry a control signal: a child's
    // `escalate` must reach enclosing LoopAgents.
    return (
      Object.keys(event.actions?.stateDelta ?? {}).length > 0 ||
      event.actions?.escalate === true
    );
  }

  private findSubAgent(agentName: string): BaseAgent | undefined {
    return (
      this.#subAgents.find((agent) => agent.name === agentName) ??
      this.#rootAgent.findSubAgent(agentName)
    );
  }

  /**
   * In native mode, sub-agent events are surfaced verbatim on the root branch
   * with no external-agent metadata so DevTools renders them as the
   * sub-agent's own turns on the shared timeline. Legacy mode enriches them
   * with run_adk_subagent titles/flags.
   */
  private prepareSubAgentEvent({
    event,
    subAgentName,
    parentToolCallId,
  }: {
    event: Event;
    subAgentName: string;
    parentToolCallId: string;
  }): Event {
    if (this.#nativeDelegationShape) {
      // Native sub-agent events carry no customMetadata. Strip any leaked from
      // nested ExternalAgent/CodexAgent self-stamping (metadataForExternalEvent)
      // so the surfaced timeline matches native exactly, except the child's
      // own model and tools reports: the host must still see them, and the
      // event's `author` (the child) keeps them attributable. Preserve all
      // other fields (content/actions/finishReason/turnComplete/...) via
      // spread.
      const { customMetadata, ...rest } = event as Event & {
        customMetadata?: Record<string, unknown>;
      };
      const reports = Object.fromEntries(
        [
          EXTERNAL_AGENT_MODEL_METADATA_KEY,
          EXTERNAL_AGENT_TOOLS_METADATA_KEY,
        ].flatMap((key) =>
          customMetadata?.[key] === undefined
            ? []
            : [[key, customMetadata[key]]],
        ),
      );
      return (
        Object.keys(reports).length > 0
          ? { ...rest, customMetadata: reports }
          : rest
      ) as Event;
    }
    return enrichSubAgentEvent({
      event,
      rootAgentName: this.#rootAgent.name,
      subAgentName,
      parentToolCallId,
    });
  }

  private createFunctionCallEvent(
    input: RunSubAgentInput,
    callId: string,
  ): Event {
    if (this.#nativeDelegationShape) {
      // Native `transfer_to_agent` call: single { agent_name } arg (ADK >= 2.1
      // wire format, see agent_transfer_llm_request_processor), no metadata.
      // A completed synthetic transfer turn is STOP/turnComplete, like a
      // native one, so DevTools renders it as a finished model turn.
      // usageMetadata is omitted: no real token usage backs a
      // bridge-synthesized transfer.
      return createEvent({
        invocationId: this.#parentContext.invocationId,
        author: this.#parentContext.agent?.name ?? this.#rootAgent.name,
        branch: this.#parentContext.branch,
        finishReason: FinishReason.STOP,
        turnComplete: true,
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: callId,
                name: "transfer_to_agent",
                args: { agent_name: input.agentName },
              },
            },
          ],
        },
      });
    }
    return createEvent({
      invocationId: this.#parentContext.invocationId,
      author: this.#parentContext.agent?.name ?? this.#rootAgent.name,
      branch: this.#parentContext.branch,
      customMetadata: {
        title: `run_adk_subagent → ${input.agentName}`,
        externalAgent: true,
        toolName: "run_adk_subagent",
        subAgentName: input.agentName,
      },
      content: {
        role: "model",
        parts: [
          {
            functionCall: {
              id: callId,
              name: "run_adk_subagent",
              args: { ...input },
            },
          },
        ],
      },
    });
  }

  private createFunctionResponseEvent(
    result: Pick<RunSubAgentResult, "agentName"> & Partial<RunSubAgentResult>,
    callId: string,
  ): Event {
    if (this.#nativeDelegationShape) {
      // Native `transfer_to_agent` response: actions.transferToAgent is the
      // only agent-switch signal DevTools reads; response is just
      // { result: "Transfer queued" }. No stateDelta here: the codex_thread /
      // resume delta rides on the sub-agent's own surfaced state_delta event
      // (see shouldSurfaceSubAgentEvent), which keeps this response identical
      // to a native transfer response.
      return createEvent({
        invocationId: this.#parentContext.invocationId,
        author: this.#parentContext.agent?.name ?? this.#rootAgent.name,
        branch: this.#parentContext.branch,
        actions: createEventActions({
          transferToAgent: result.agentName,
          // ADK-like: the transferred agent's turn is the final answer, so
          // `isFinalResponse` treats the transfer response as final.
          ...(this.#finalAnswer === "subagent"
            ? { skipSummarization: true }
            : {}),
        }),
        content: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: callId,
                name: "transfer_to_agent",
                response: { result: "Transfer queued" },
              },
            },
          ],
        },
      });
    }
    const { stateDelta: _stateDelta, ...response } = result;
    return createEvent({
      invocationId: this.#parentContext.invocationId,
      author: this.#parentContext.agent?.name ?? this.#rootAgent.name,
      branch: this.#parentContext.branch,
      customMetadata: {
        title: `run_adk_subagent ← ${result.agentName}`,
        externalAgent: true,
        toolName: "run_adk_subagent",
        subAgentName: result.agentName,
        error: result.error,
      },
      actions: result.stateDelta
        ? createEventActions({ stateDelta: result.stateDelta })
        : undefined,
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: callId,
              name: "run_adk_subagent",
              response,
            },
          },
        ],
      },
    });
  }

  private emit(event: Event): void {
    this.#eventSink?.(event);
  }
}

function unknownAgentResult(
  agentName: string,
  error: string,
): RunSubAgentResult {
  return {
    agentName,
    output: "",
    events: 0,
    summary: {
      events: 0,
      textEvents: 0,
      toolCalls: 0,
      errors: 1,
      durationMs: 0,
    },
    error,
    // Resolution failed, as the invocation gateway classifies it.
    errorKind: "agent-error",
  };
}

function createBridgeCallId(): string {
  return `adk-run-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function childBranch(
  parentBranch: string | undefined,
  agentName: string,
): string {
  return parentBranch ? `${parentBranch}.${agentName}` : agentName;
}

/**
 * Guarantees the parent context carries a session. Real contexts are cloned
 * with ADK's own `clone()` (keeps the shared LLM-call counter); duck-typed
 * contexts (tests, ad-hoc callers) are promoted to a real `InvocationContext`.
 */
function withToolGatewaySession(context: InvocationContext): InvocationContext {
  if (context.session) {
    return context;
  }
  const session = createSession({
    id: "tool-gateway-child-session",
    appName: "tool-gateway",
    userId: "tool-gateway-user",
  });
  if (context instanceof InvocationContext) {
    return context.clone({ session });
  }
  const fields: Partial<InvocationContextParams> = context;
  return new InvocationContext({
    invocationId: `e-${crypto.randomUUID()}`,
    pluginManager: new PluginManager(),
    ...fields,
    session,
  });
}

function readAgentPermissions(
  agent: BaseAgent,
): ExternalAgentPermissionPolicy | undefined {
  const policy = snapshotPermissionPolicy(
    (agent as { permissions?: unknown }).permissions,
  );
  // A malformed policy on a sub-agent must not widen anything: it counts as
  // the most restrictive mode.
  return policy === null ? { mode: "read-only" } : policy;
}

function enrichSubAgentEvent({
  event,
  rootAgentName,
  subAgentName,
  parentToolCallId,
}: {
  event: Event;
  rootAgentName: string;
  subAgentName: string;
  parentToolCallId: string;
}): Event {
  const metadata =
    (event as { customMetadata?: Record<string, unknown> }).customMetadata ??
    {};
  return {
    ...event,
    customMetadata: {
      ...metadata,
      title: readableSubAgentEventTitle(event, subAgentName),
      externalAgent: true,
      subAgentEvent: true,
      parentToolName: "run_adk_subagent",
      parentToolCallId,
      rootAgentName,
      subAgentName,
    },
  };
}

function readableSubAgentEventTitle(
  event: Event,
  subAgentName: string,
): string {
  const functionCall = event.content?.parts?.find(
    (part) => part.functionCall,
  )?.functionCall;
  if (functionCall?.name) {
    return toolCallTitle(subAgentName, functionCall.name, functionCall.args);
  }

  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionResponse?.name) {
    return toolResponseTitle(
      subAgentName,
      functionResponse.name,
      functionResponse.response,
    );
  }

  const metadata =
    (event as { customMetadata?: Record<string, unknown> }).customMetadata ??
    {};
  const itemType = stringOrEmpty(metadata.itemType);
  if (itemType) {
    return itemTitle(subAgentName, itemType, stringOrEmpty(metadata.status));
  }

  if (event.errorMessage) {
    return errorTitle(subAgentName, event.errorCode);
  }

  return textTitle(subAgentName, Boolean(event.partial));
}
