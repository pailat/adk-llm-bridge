/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { createEvent, type BaseAgent, type Event, type InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import { deriveSubAgentPermissionPolicy } from "../permissions/inheritance.js";
import type { ExternalAgentPermissionPolicy } from "../permissions/schema.js";

export interface RunSubAgentInput {
  agentName: string;
  task: string;
}

export interface RunSubAgentResult {
  agentName: string;
  output: string;
  events: number;
  error?: string;
}

export type ToolGatewayEventSink = (event: Event) => void;

export interface ToolGatewayConfig {
  rootAgent: BaseAgent;
  subAgents: readonly BaseAgent[];
  parentContext: InvocationContext;
  parentPermissions?: ExternalAgentPermissionPolicy;
  eventSink?: ToolGatewayEventSink;
}

export class ToolGateway {
  readonly #rootAgent: BaseAgent;
  readonly #subAgents: readonly BaseAgent[];
  readonly #parentContext: InvocationContext;
  readonly #parentPermissions?: ExternalAgentPermissionPolicy;
  readonly #eventSink?: ToolGatewayEventSink;

  constructor(config: ToolGatewayConfig) {
    this.#rootAgent = config.rootAgent;
    this.#subAgents = config.subAgents;
    this.#parentContext = config.parentContext;
    this.#parentPermissions = config.parentPermissions;
    this.#eventSink = config.eventSink;
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
        error: `Unknown ADK subagent: ${input.agentName}`,
      };
    }

    const callId = createBridgeCallId();
    this.emit(this.createFunctionCallEvent(input, callId));

    const events: Event[] = [];
    const text: string[] = [];
    let error: string | undefined;

    try {
      for await (const event of agent.runAsync(this.createChildContext(agent, input.task))) {
        events.push(event);
        this.emit(event);
        const visible = extractVisibleText(event);
        if (visible) {
          text.push(visible);
        }
        if (event.errorMessage) {
          error = event.errorMessage;
        }
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const result = {
      agentName: agent.name,
      output: text.join("\n"),
      events: events.length,
      error,
    };
    this.emit(this.createFunctionResponseEvent(result, callId));

    return result;
  }

  private findSubAgent(agentName: string): BaseAgent | undefined {
    return this.#subAgents.find((agent) => agent.name === agentName) ??
      this.#rootAgent.findSubAgent(agentName);
  }

  private createChildContext(agent: BaseAgent, task: string): InvocationContext {
    return {
      ...this.#parentContext,
      agent: this.#rootAgent,
      branch: childBranch(this.#parentContext.branch, agent.name),
      userContent: taskToContent(task),
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
      content: {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: callId,
              name: "run_adk_subagent",
              response: { ...result },
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
