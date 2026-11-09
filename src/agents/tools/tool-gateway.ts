/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

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
import { FinishReason } from "@google/genai";
import {
  AgentInvocationGateway,
  type AgentInvocationInterruptKind,
} from "../../runtime/agent-invocation-gateway.js";
import { stringValue } from "../driver/shared.js";
import {
  deriveSubAgentPermissionPolicy,
  setInheritedPermissions,
} from "../permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";

export interface RunSubAgentInput {
  agentName: string;
  task: string;
}

export interface RunSubAgentExecutionSummary {
  events: number;
  textEvents: number;
  toolCalls: number;
  errors: number;
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
  kind: AgentInvocationInterruptKind;
  /** Ids that must be answered to resume. */
  functionCallIds: readonly string[];
}

export interface RunSubAgentResult {
  agentName: string;
  output: string;
  events: number;
  summary: RunSubAgentExecutionSummary;
  stateDelta?: Record<string, unknown>;
  /**
   * Set when the delegation failed, and also when it paused on the user
   * (`interrupt`): a paused delegation is never reported as a success.
   */
  error?: string;
  interrupt?: RunSubAgentInterrupt;
}

export type ToolGatewayEventSink = (event: Event) => void;

/** What a {@link ToolGatewayDelegationTracer} learns about a delegation. */
export interface ToolGatewayDelegationInfo {
  callId: string;
  agentName: string;
  /** `transfer_to_agent` (native shape) or `run_adk_subagent` (legacy). */
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

export interface DelegationOptions {
  finalAnswer?: DelegationFinalAnswer;
}

export interface ToolGatewayConfig {
  rootAgent: BaseAgent;
  subAgents: readonly BaseAgent[];
  parentContext: InvocationContext;
  parentPermissions?: ExternalAgentPermissionPolicy;
  eventSink?: ToolGatewayEventSink;
  /** Optional wrapper around each delegation (tracing). */
  traceDelegation?: ToolGatewayDelegationTracer;
  exposeSubAgentEvents?: boolean;
  /**
   * When true (default) the gateway emits events shaped like native ADK
   * `transfer_to_agent` delegation: a `transfer_to_agent` functionCall, a
   * functionResponse carrying `actions.transferToAgent`, sub-agent events on
   * the root branch with no external-agent metadata, and a suppressed root
   * re-narration. When false the legacy metadata-rich `run_adk_subagent`
   * shape is emitted instead.
   */
  nativeDelegationShape?: boolean;
  /** Final-answer ownership after a delegation. Default `finalAnswer: "subagent"`. */
  delegation?: DelegationOptions;
  /**
   * Called when a delegation pauses on the user (before `runSubAgent`
   * resolves). `ExternalAgent` uses it to end the coordinator's invocation, as
   * ADK does for a long-running call, so the coordinator does not carry on
   * while the user is being asked.
   */
  onInterrupt?: (result: RunSubAgentResult) => void;
}

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
  /**
   * True while the most recent delegation ended with a terminal sub-agent
   * answer that the coordinator must not repeat. Per gateway instance (one per
   * ExternalAgent invocation), so it is neither context-wide nor shared across
   * bundles. Recomputed by every delegation: a failed or text-less delegation
   * clears it.
   */
  #finalAnswerPending = false;

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
    this.#invocationGateway = new AgentInvocationGateway({
      resolveAgent: (agentName) => this.findSubAgent(agentName),
    });
  }

  listSubAgents(): readonly BaseAgent[] {
    return this.#subAgents;
  }

  /**
   * Returns true (once) when the coordinator's next terminal text turn is a
   * redundant re-narration of a sub-agent answer and must be dropped.
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

  async runSubAgent(input: RunSubAgentInput): Promise<RunSubAgentResult> {
    const agent = this.findSubAgent(input.agentName);
    if (!agent) {
      return {
        agentName: input.agentName,
        output: "",
        events: 0,
        summary: {
          events: 0,
          textEvents: 0,
          toolCalls: 0,
          errors: 1,
          durationMs: 0,
        },
        error: `Unknown ADK subagent: ${input.agentName}`,
      };
    }

    const callId = createBridgeCallId();
    // A new delegation starts: whatever the previous one decided is stale.
    this.#finalAnswerPending = false;
    const run = () => this.delegate(input, agent, callId);
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

  private async delegate(
    input: RunSubAgentInput,
    agent: BaseAgent,
    callId: string,
  ): Promise<RunSubAgentResult> {
    this.emit(this.createFunctionCallEvent(input, callId));

    // In native mode the transfer signal must fire BEFORE the sub-agent runs
    // (native ADK emits the transfer functionResponse carrying
    // actions.transferToAgent immediately, then the sub-agent's turns follow).
    // The codex_thread/resume stateDelta no longer rides on this response; it
    // is surfaced via the sub-agent's own state_delta event instead (see
    // shouldSurfaceSubAgentEvent), so this response stays byte-clean with no
    // stateDelta — identical to native nat_billing#1/nat_support#1.
    if (this.#nativeDelegationShape) {
      this.emit(
        this.createFunctionResponseEvent({ agentName: agent.name }, callId),
      );
    }

    const invocation = await this.#invocationGateway.run({
      agentName: agent.name,
      input: { role: "user", parts: [{ text: input.task }] },
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
        setInheritedPermissions(
          childContext.session,
          deriveSubAgentPermissionPolicy(
            this.#parentPermissions,
            readAgentPermissions(agent),
          ),
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
      ...(interrupt ? { interrupt } : {}),
    };

    // Legacy mode keeps the loop-then-response order with the aggregated
    // stateDelta attached to the response. Native mode already emitted its
    // (clean) transfer response before the loop.
    if (!this.#nativeDelegationShape) {
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
    return result;
  }

  /**
   * Decide whether a sub-agent event should surface on the shared timeline.
   * Legacy mode surfaces everything. Native mode drops content-less events
   * (blank bubbles) EXCEPT those carrying a non-empty `actions.stateDelta`
   * (e.g. the codex driver's `codex_thread` marker emitted the moment the
   * thread starts) or `actions.escalate`. Surfacing the state-only event lets the ADK runner commit
   * its stateDelta to session.state exactly as native sub-agents commit their
   * own state, so codex resume keeps working without the transfer response
   * having to carry the delta.
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
      // so the surfaced timeline matches native exactly. Preserve all other
      // fields (content/actions/finishReason/turnComplete/...) via spread.
      const { customMetadata: _drop, ...rest } = event as Event & {
        customMetadata?: unknown;
      };
      return rest as Event;
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
      // A completed synthetic transfer turn legitimately is STOP/turnComplete,
      // matching native nat_billing#0/nat_support#0 so DevTools renders it as a
      // finished model turn. usageMetadata is intentionally omitted (no real
      // token usage backs a bridge-synthesized transfer).
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
      // { result: "Transfer queued" }. NO stateDelta here — the codex_thread /
      // resume delta rides on the sub-agent's own surfaced state_delta event
      // (see shouldSurfaceSubAgentEvent), keeping this response byte-identical
      // to native nat_billing#1/nat_support#1 (stateDelta absent).
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
  const permissions = (agent as { permissions?: unknown }).permissions;
  return isPermissionPolicy(permissions) ? permissions : undefined;
}

function isPermissionPolicy(
  value: unknown,
): value is ExternalAgentPermissionPolicy {
  return Boolean(
    value &&
      typeof value === "object" &&
      "mode" in value &&
      typeof (value as { mode?: unknown }).mode === "string",
  );
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
    return `${subAgentName}: ${functionCall.name} call${toolDetail(functionCall.args)}`;
  }

  const functionResponse = event.content?.parts?.find(
    (part) => part.functionResponse,
  )?.functionResponse;
  if (functionResponse?.name) {
    return `${subAgentName}: ${functionResponse.name} response${toolDetail(functionResponse.response)}`;
  }

  const itemType = stringValue(
    (event as { customMetadata?: { itemType?: unknown } }).customMetadata
      ?.itemType,
  );
  const status = stringValue(
    (event as { customMetadata?: { status?: unknown } }).customMetadata?.status,
  );
  if (itemType) {
    return `${subAgentName}: ${itemType}${status ? ` ${status}` : ""}`;
  }

  if (event.errorMessage) {
    return `${subAgentName}: error ${event.errorCode ?? "EXTERNAL_AGENT_ERROR"}`;
  }

  return event.partial
    ? `${subAgentName}: progress`
    : `${subAgentName}: final response`;
}

function toolDetail(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const command = stringValue(record.command);
  const status = stringValue(record.status);
  const detail = command ?? status;
  return detail ? `: ${truncate(detail, 72)}` : "";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}
