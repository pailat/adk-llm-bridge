/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  createEvent,
  createEventActions,
  type BaseAgent,
  type Event,
  type InvocationContext,
  type Session,
} from "@google/adk";
import type { Content } from "@google/genai";
import { deriveSubAgentPermissionPolicy } from "../permissions/inheritance.js";
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

export interface RunSubAgentResult {
  agentName: string;
  output: string;
  events: number;
  summary: RunSubAgentExecutionSummary;
  stateDelta?: Record<string, unknown>;
  error?: string;
}

export type ToolGatewayEventSink = (event: Event) => void;

export interface ToolGatewayConfig {
  rootAgent: BaseAgent;
  subAgents: readonly BaseAgent[];
  parentContext: InvocationContext;
  parentPermissions?: ExternalAgentPermissionPolicy;
  eventSink?: ToolGatewayEventSink;
  exposeSubAgentEvents?: boolean;
}

export class ToolGateway {
  readonly #rootAgent: BaseAgent;
  readonly #subAgents: readonly BaseAgent[];
  readonly #parentContext: InvocationContext;
  readonly #parentPermissions?: ExternalAgentPermissionPolicy;
  readonly #eventSink?: ToolGatewayEventSink;
  readonly #exposeSubAgentEvents: boolean;

  constructor(config: ToolGatewayConfig) {
    this.#rootAgent = config.rootAgent;
    this.#subAgents = config.subAgents;
    this.#parentContext = config.parentContext;
    this.#parentPermissions = config.parentPermissions;
    this.#eventSink = config.eventSink;
    this.#exposeSubAgentEvents = config.exposeSubAgentEvents ?? true;
  }

  listSubAgents(): readonly BaseAgent[] {
    return this.#subAgents;
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
    this.emit(this.createFunctionCallEvent(input, callId));

    const startedAt = Date.now();
    const events: Event[] = [];
    const text: string[] = [];
    const fallbackOutput: string[] = [];
    const stateDelta: Record<string, unknown> = {};
    let textEvents = 0;
    let toolCalls = 0;
    let errors = 0;
    let error: string | undefined;

    try {
      const childContext = this.createChildContext(agent, input.task);
      for await (const event of agent.runAsync(childContext)) {
        childContext.session.events.push(event);
        events.push(event);
        if (this.#exposeSubAgentEvents) {
          this.emit(enrichSubAgentEvent({
            event,
            rootAgentName: this.#rootAgent.name,
            subAgentName: agent.name,
            parentToolCallId: callId,
          }));
        }
        Object.assign(stateDelta, event.actions?.stateDelta ?? {});
        const visible = extractVisibleText(event);
        if (visible) {
          textEvents++;
          text.push(visible);
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
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const result: RunSubAgentResult = {
      agentName: agent.name,
      output: text.length > 0 ? text.join("\n") : fallbackOutput.join("\n"),
      events: events.length,
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
    this.emit(this.createFunctionResponseEvent(result, callId));

    return result;
  }

  private findSubAgent(agentName: string): BaseAgent | undefined {
    return this.#subAgents.find((agent) => agent.name === agentName) ??
      this.#rootAgent.findSubAgent(agentName);
  }

  private createChildContext(agent: BaseAgent, task: string): InvocationContext {
    const branch = childBranch(this.#parentContext.branch, agent.name);
    const userContent = taskToContent(task);
    const syntheticUserEvent = createDelegatedTaskEvent({
      invocationId: this.#parentContext.invocationId,
      branch,
      content: userContent,
    });

    return {
      ...this.#parentContext,
      agent: this.#rootAgent,
      branch,
      userContent,
      session: createChildSessionView(this.#parentContext.session, syntheticUserEvent),
      externalAgentPermissionOverride: deriveSubAgentPermissionPolicy(
        this.#parentPermissions,
        readAgentPermissions(agent),
      ),
    } as unknown as InvocationContext;
  }

  private createFunctionCallEvent(input: RunSubAgentInput, callId: string): Event {
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
    result: RunSubAgentResult,
    callId: string,
  ): Event {
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

function childBranch(parentBranch: string | undefined, agentName: string): string {
  return parentBranch ? `${parentBranch}.${agentName}` : agentName;
}

function taskToContent(task: string): Content {
  return { role: "user", parts: [{ text: task }] };
}

function createDelegatedTaskEvent({
  invocationId,
  branch,
  content,
}: {
  invocationId: string;
  branch: string;
  content: Content;
}): Event {
  return createEvent({
    invocationId,
    author: "user",
    branch,
    content,
    customMetadata: {
      externalAgent: true,
      delegatedTask: true,
      toolName: "run_adk_subagent",
    },
  });
}

function createChildSessionView(parentSession: Session | undefined, syntheticUserEvent: Event): Session {
  return {
    id: parentSession?.id ?? "tool-gateway-child-session",
    appName: parentSession?.appName ?? "tool-gateway",
    userId: parentSession?.userId ?? "tool-gateway-user",
    state: parentSession?.state ?? {},
    events: [...(parentSession?.events ?? []), syntheticUserEvent],
    lastUpdateTime: parentSession?.lastUpdateTime ?? Date.now(),
  };
}

function readAgentPermissions(agent: BaseAgent): ExternalAgentPermissionPolicy | undefined {
  const permissions = (agent as { permissions?: unknown }).permissions;
  return isPermissionPolicy(permissions) ? permissions : undefined;
}

function isPermissionPolicy(value: unknown): value is ExternalAgentPermissionPolicy {
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
  const metadata = (event as { customMetadata?: Record<string, unknown> }).customMetadata ?? {};
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

function readableSubAgentEventTitle(event: Event, subAgentName: string): string {
  const functionCall = event.content?.parts?.find((part) => part.functionCall)?.functionCall;
  if (functionCall?.name) {
    return `${subAgentName}: ${functionCall.name} call${toolDetail(functionCall.args)}`;
  }

  const functionResponse = event.content?.parts?.find((part) => part.functionResponse)?.functionResponse;
  if (functionResponse?.name) {
    return `${subAgentName}: ${functionResponse.name} response${toolDetail(functionResponse.response)}`;
  }

  const itemType = stringValue((event as { customMetadata?: { itemType?: unknown } }).customMetadata?.itemType);
  const status = stringValue((event as { customMetadata?: { status?: unknown } }).customMetadata?.status);
  if (itemType) {
    return `${subAgentName}: ${itemType}${status ? ` ${status}` : ""}`;
  }

  if (event.errorMessage) {
    return `${subAgentName}: error ${event.errorCode ?? "EXTERNAL_AGENT_ERROR"}`;
  }

  return event.partial ? `${subAgentName}: progress` : `${subAgentName}: final response`;
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
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    .filter((part): part is string => typeof part === "string" && part.length > 0)
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
