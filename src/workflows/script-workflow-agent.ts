/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { BaseAgent, type Event, type InvocationContext } from "@google/adk";
import { AgentInvocationGateway } from "../runtime/agent-invocation-gateway.js";
import type { WorkflowExecutionLimits } from "./contracts.js";
import type {
  ScriptWorkflowDefinition,
  TrustedWorkflowDefinition,
} from "./definition.js";
import type { WorkflowEvent } from "./events.js";
import { isWorkflowEvent } from "./events.js";
import { AsyncEventQueue } from "./runtime/async-event-queue.js";
import { WorkflowRuntime } from "./runtime/workflow-runtime.js";
import { QuickJSSyncGeneratorRuntime } from "./sandbox/quickjs-generator-runtime.js";
import type { WorkflowScriptRuntime } from "./sandbox/types.js";
import { runWorkflowScript } from "./sandbox/workflow-script-runner.js";

export interface ScriptWorkflowAgentConfig {
  name: string;
  description?: string;
  definition: ScriptWorkflowDefinition;
  subAgents?: BaseAgent[];
  /** Optional isolated runtime injection for alternate sandboxes and tests. */
  runtime?: WorkflowScriptRuntime;
  /** Overrides limits declared by the workflow definition. */
  limits?: WorkflowExecutionLimits;
  /** Observes normalized workflow lifecycle events. */
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
  /** Optional gateway injection for instrumentation and deterministic tests. */
  gateway?: AgentInvocationGateway;
}

/** A sandboxed, versioned script workflow that participates in ADK as an agent. */
export class ScriptWorkflowAgent extends BaseAgent {
  readonly definition: ScriptWorkflowDefinition;
  readonly #scriptRuntime: WorkflowScriptRuntime;
  readonly #gateway: AgentInvocationGateway;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;
  readonly #limits: WorkflowExecutionLimits | undefined;
  readonly #onEvent:
    | ((event: WorkflowEvent) => void | Promise<void>)
    | undefined;

  constructor(config: ScriptWorkflowAgentConfig) {
    const subAgents = config.subAgents ?? [];
    super({
      name: config.name,
      description: config.description ?? config.definition.description,
      subAgents,
    });
    this.definition = config.definition;
    this.#limits = mergeLimits(config.definition.limits, config.limits);
    this.#onEvent = config.onEvent;
    this.#scriptRuntime = config.runtime ?? new QuickJSSyncGeneratorRuntime();
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
    const executionDefinition = this.createExecutionDefinition();
    const runtime = new WorkflowRuntime({
      definition: executionDefinition,
      parentContext: context,
      agentName: this.name,
      declaredAgents: this.#declaredAgents,
      gateway: this.#gateway,
      eventSink: async (event) => {
        queue.push(event);
        const workflowEvent = event.customMetadata?.workflowEvent;
        if (this.#onEvent && isWorkflowEvent(workflowEvent)) {
          await this.#onEvent(workflowEvent);
        }
      },
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

  private createExecutionDefinition(): TrustedWorkflowDefinition {
    return {
      kind: "trusted",
      id: this.definition.id,
      version: this.definition.version,
      description: this.definition.description,
      limits: this.#limits,
      handler: async (context) => {
        const execution = await runWorkflowScript(this.#scriptRuntime, {
          source: this.definition.source,
          input: context.input,
          signal: context.signal,
          limits: this.#limits,
          filename: `${this.definition.id}.workflow.js`,
          host: {
            run: (step) => context.run(step),
            parallel: (steps, options) => context.parallel(steps, options),
            emit: (event) => context.emit(event),
          },
        });
        return execution.output;
      },
    };
  }
}

function mergeLimits(
  definitionLimits: WorkflowExecutionLimits | undefined,
  overrides: WorkflowExecutionLimits | undefined,
): WorkflowExecutionLimits | undefined {
  if (!definitionLimits && !overrides) return undefined;
  return { ...definitionLimits, ...overrides };
}
