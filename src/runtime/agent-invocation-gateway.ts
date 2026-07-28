/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  type BaseAgent,
  createEvent,
  type Event,
  InvocationContext,
  type Session,
} from "@google/adk";
import type { Content } from "@google/genai";

export interface AgentInvocationExecutionSummary {
  events: number;
  textEvents: number;
  toolCalls: number;
  errors: number;
  durationMs: number;
}

export interface AgentInvocationResult {
  agentName: string;
  output: string;
  events: readonly Event[];
  summary: AgentInvocationExecutionSummary;
  stateDelta?: Record<string, unknown>;
  error?: string;
}

export interface AgentInvocationRequest {
  agentName: string;
  input: Content;
  parentContext: InvocationContext;
  branch?: string;
  abortSignal?: AbortSignal;
  /** JSON-safe state projected into the isolated child session only. */
  sessionState?: Readonly<Record<string, unknown>>;
  /** Merge is the compatibility default; replace prevents parent-state inheritance. */
  sessionStateMode?: "merge" | "replace";
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

    const combinedAbort = combineAbortSignals([
      request.parentContext.abortSignal,
      request.abortSignal,
    ]);
    const childContext = createChildInvocationContext({
      agent,
      parentContext: request.parentContext,
      input: request.input,
      branch: request.branch,
      abortSignal: combinedAbort.signal,
      sessionState: request.sessionState,
      sessionStateMode: request.sessionStateMode ?? "merge",
    });

    const events: Event[] = [];
    const text: string[] = [];
    const fallbackOutput: string[] = [];
    const stateDelta: Record<string, unknown> = {};
    let terminalText: string | undefined;
    let textEvents = 0;
    let toolCalls = 0;
    let errors = 0;
    let error: string | undefined;

    try {
      await request.validateInvocation?.("before-prepare");
    } catch (caught) {
      combinedAbort.dispose();
      throw caught;
    }

    let preparationFailed = false;
    try {
      throwIfAborted(combinedAbort.signal);
      await request.prepareContext?.(childContext, agent);
    } catch (caught) {
      preparationFailed = true;
      errors++;
      error = errorMessage(caught);
    }

    if (!preparationFailed) {
      try {
        await request.validateInvocation?.("before-execute");
      } catch (caught) {
        combinedAbort.dispose();
        throw caught;
      }

      try {
        for await (const event of agent.runAsync(childContext)) {
          throwIfAborted(combinedAbort.signal);
          childContext.session.events.push(event);
          events.push(event);
          Object.assign(stateDelta, event.actions?.stateDelta ?? {});
          await this.#eventSink?.(event, childContext);
          await request.eventSink?.(event, childContext);

          const visible = event.partial ? undefined : extractVisibleText(event);
          if (visible) {
            textEvents++;
            text.push(visible);
            if (event.turnComplete === true) {
              terminalText = visible;
            }
          } else {
            const fallback = extractFallbackOutput(event);
            if (fallback) {
              fallbackOutput.push(fallback);
            }
          }
          toolCalls += countFunctionCalls(event);
          if (event.errorMessage) {
            errors++;
            error = event.errorMessage;
          }
        }
      } catch (caught) {
        errors++;
        error = errorMessage(caught);
      }
    }
    combinedAbort.dispose();

    return {
      agentName: agent.name,
      output:
        terminalText ??
        (text.length > 0 ? text.join("\n") : fallbackOutput.join("\n")),
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
    };
  }
}

function createChildInvocationContext({
  agent,
  parentContext,
  input,
  branch,
  abortSignal,
  sessionState,
  sessionStateMode,
}: {
  agent: BaseAgent;
  parentContext: InvocationContext;
  input: Content;
  branch: string | undefined;
  abortSignal: AbortSignal | undefined;
  sessionState: Readonly<Record<string, unknown>> | undefined;
  sessionStateMode: "merge" | "replace";
}): InvocationContext {
  const syntheticUserEvent = createEvent({
    invocationId: parentContext.invocationId,
    author: "user",
    branch,
    content: input,
  });

  return new InvocationContext({
    artifactService: parentContext.artifactService,
    sessionService: parentContext.sessionService,
    memoryService: parentContext.memoryService,
    credentialService: parentContext.credentialService,
    invocationId: parentContext.invocationId,
    branch,
    agent,
    userContent: input,
    session: createChildSessionView(
      parentContext.session,
      syntheticUserEvent,
      sessionState,
      sessionStateMode,
    ),
    endInvocation: parentContext.endInvocation,
    transcriptionCache: parentContext.transcriptionCache,
    runConfig: parentContext.runConfig,
    liveRequestQueue: parentContext.liveRequestQueue,
    activeStreamingTools: parentContext.activeStreamingTools,
    pluginManager: parentContext.pluginManager,
    abortSignal,
  });
}

function createChildSessionView(
  parentSession: Session,
  syntheticUserEvent: Event,
  sessionState: Readonly<Record<string, unknown>> | undefined,
  sessionStateMode: "merge" | "replace",
): Session {
  return {
    id: parentSession.id,
    appName: parentSession.appName,
    userId: parentSession.userId,
    state:
      sessionStateMode === "replace"
        ? Object.freeze({ ...sessionState })
        : { ...parentSession.state, ...sessionState },
    events: [...parentSession.events, syntheticUserEvent],
    lastUpdateTime: parentSession.lastUpdateTime,
  };
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal),
  );
  if (active.length === 0) {
    return { signal: undefined, dispose: () => undefined };
  }
  if (active.length === 1) {
    return { signal: active[0], dispose: () => undefined };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of active) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) {
      abort();
      break;
    }
    listeners.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error(
    typeof signal.reason === "string"
      ? signal.reason
      : "Agent invocation aborted",
  );
}

function failedResult(
  agentName: string,
  startedAt: number,
  error: string,
): AgentInvocationResult {
  return {
    agentName,
    output: "",
    events: [],
    summary: {
      events: 0,
      textEvents: 0,
      toolCalls: 0,
      errors: 1,
      durationMs: Date.now() - startedAt,
    },
    error,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

function countFunctionCalls(event: Event): number {
  return event.content?.parts?.filter((part) => part.functionCall).length ?? 0;
}

function extractVisibleText(event: Event): string | undefined {
  const parts = event.content?.parts;
  if (!parts) {
    return undefined;
  }

  const text = parts
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
