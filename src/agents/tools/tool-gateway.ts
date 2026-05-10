/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { BaseAgent, Event, InvocationContext } from "@google/adk";
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

export interface ToolGatewayConfig {
  rootAgent: BaseAgent;
  subAgents: readonly BaseAgent[];
  parentContext: InvocationContext;
  parentPermissions?: ExternalAgentPermissionPolicy;
}

export class ToolGateway {
  readonly #rootAgent: BaseAgent;
  readonly #subAgents: readonly BaseAgent[];
  readonly #parentContext: InvocationContext;
  readonly #parentPermissions?: ExternalAgentPermissionPolicy;

  constructor(config: ToolGatewayConfig) {
    this.#rootAgent = config.rootAgent;
    this.#subAgents = config.subAgents;
    this.#parentContext = config.parentContext;
    this.#parentPermissions = config.parentPermissions;
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

    const events: Event[] = [];
    const text: string[] = [];
    let error: string | undefined;

    try {
      for await (const event of agent.runAsync(this.createChildContext(agent, input.task))) {
        events.push(event);
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

    return {
      agentName: agent.name,
      output: text.join("\n"),
      events: events.length,
      error,
    };
  }

  private findSubAgent(agentName: string): BaseAgent | undefined {
    return this.#subAgents.find((agent) => agent.name === agentName) ??
      this.#rootAgent.findSubAgent(agentName);
  }

  private createChildContext(agent: BaseAgent, task: string): InvocationContext {
    return {
      ...this.#parentContext,
      agent: this.#rootAgent,
      userContent: taskToContent(task),
      externalAgentPermissionOverride: deriveSubAgentPermissionPolicy(
        this.#parentPermissions,
        readAgentPermissions(agent),
      ),
    } as unknown as InvocationContext;
  }
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
