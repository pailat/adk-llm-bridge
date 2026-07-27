/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { BaseAgent, type Event, type InvocationContext } from "@google/adk";
import { AgentInvocationGateway } from "../runtime/agent-invocation-gateway.js";
import type { TrustedWorkflowDefinition } from "./definition.js";
import { AsyncEventQueue } from "./runtime/async-event-queue.js";
import {
  WorkflowRuntime,
  type WorkflowRuntimeHooks,
} from "./runtime/workflow-runtime.js";

export interface WorkflowAgentConfig {
  name: string;
  description?: string;
  definition: TrustedWorkflowDefinition;
  subAgents?: BaseAgent[];
  /** Optional gateway injection for instrumentation and deterministic tests. */
  gateway?: AgentInvocationGateway;
  /** Internal durability extension point; not required by trusted workflows. */
  runtimeHooks?: WorkflowRuntimeHooks;
}

/** A trusted, versioned workflow that participates in ADK as a BaseAgent. */
export class WorkflowAgent extends BaseAgent {
  readonly definition: TrustedWorkflowDefinition;
  readonly #gateway: AgentInvocationGateway;
  readonly #runtimeHooks?: WorkflowRuntimeHooks;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;

  constructor(config: WorkflowAgentConfig) {
    const subAgents = config.subAgents ?? [];
    super({
      name: config.name,
      description: config.description ?? config.definition.description,
      subAgents,
    });
    this.definition = config.definition;
    this.#runtimeHooks = config.runtimeHooks;
    this.#declaredAgents = new Map(
      subAgents.map((agent) => [agent.name, agent]),
    );
    this.#gateway =
      config.gateway ??
      new AgentInvocationGateway({
        resolveAgent: (name) => this.#declaredAgents.get(name),
      });
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const queue = new AsyncEventQueue<Event>();
    const runtime = new WorkflowRuntime({
      definition: this.definition,
      parentContext: context,
      agentName: this.name,
      declaredAgents: this.#declaredAgents,
      gateway: this.#gateway,
      eventSink: (event) => queue.push(event),
      hooks: this.#runtimeHooks,
    });

    void runtime.execute().then(
      () => queue.close(),
      (error) => queue.fail(error),
    );
    yield* queue;
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }
}
