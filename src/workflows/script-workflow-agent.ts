/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { BaseAgent, type Event, type InvocationContext } from "@google/adk";
import { AgentInvocationGateway } from "../runtime/agent-invocation-gateway.js";
import type {
  WorkflowAgentDescriptor,
  WorkflowAgentFactory,
  WorkflowAgentFactoryRequest,
  WorkflowAgentHandle,
} from "./agents/workflow-agent-factory.js";
import type { WorkflowCheckpointStore } from "./checkpoint/store.js";
import {
  MAX_WORKFLOW_AGENT_REVISION_LENGTH,
  WorkflowError,
  type WorkflowExecutionLimits,
} from "./contracts.js";
import type {
  ScriptWorkflowDefinition,
  TrustedWorkflowDefinition,
} from "./definition.js";
import type { WorkflowEvent } from "./events.js";
import { isWorkflowEvent } from "./events.js";
import { AsyncEventQueue } from "./runtime/async-event-queue.js";
import {
  type WorkflowExecutionIdResolver,
  WorkflowRuntime,
  type WorkflowRuntimeHooks,
} from "./runtime/workflow-runtime.js";
import { QuickJSSyncGeneratorRuntime } from "./sandbox/quickjs-generator-runtime.js";
import type { WorkflowScriptRuntime } from "./sandbox/types.js";
import { runWorkflowScript } from "./sandbox/workflow-script-runner.js";
import type { WorkflowWorkspaceConfig } from "./workspace/workspace-adapter.js";

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
  /** Must create an isolated dynamic-agent factory for each ADK invocation. */
  createAgentFactory?: (
    context: InvocationContext,
  ) => WorkflowAgentFactory | Promise<WorkflowAgentFactory>;
  /** Checkpoint persistence adapter. Defaults to ADK session state deltas. */
  checkpointStore?: WorkflowCheckpointStore;
  /** Stable durable identity. Defaults to the ADK invocation id. */
  resolveExecutionId?: WorkflowExecutionIdResolver;
  /** Durable attempt journal/outbox hooks shared with trusted workflows. */
  runtimeHooks?: WorkflowRuntimeHooks;
  /** Optional host-side coordination for steps that declare write paths. */
  workspace?: WorkflowWorkspaceConfig;
}

/** A sandboxed, versioned script workflow that participates in ADK as an agent. */
export class ScriptWorkflowAgent extends BaseAgent {
  readonly definition: ScriptWorkflowDefinition;
  readonly #scriptRuntime: WorkflowScriptRuntime;
  readonly #gateway: AgentInvocationGateway | undefined;
  readonly #createAgentFactory:
    | ((
        context: InvocationContext,
      ) => WorkflowAgentFactory | Promise<WorkflowAgentFactory>)
    | undefined;
  readonly #checkpointStore: WorkflowCheckpointStore | undefined;
  readonly #resolveExecutionId: WorkflowExecutionIdResolver | undefined;
  readonly #runtimeHooks: WorkflowRuntimeHooks | undefined;
  readonly #workspace: WorkflowWorkspaceConfig | undefined;
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
    this.#checkpointStore = config.checkpointStore;
    this.#resolveExecutionId = config.resolveExecutionId;
    this.#runtimeHooks = config.runtimeHooks;
    this.#workspace = config.workspace;
    this.#limits = mergeLimits(config.definition.limits, config.limits);
    this.#onEvent = config.onEvent;
    this.#scriptRuntime = config.runtime ?? new QuickJSSyncGeneratorRuntime();
    this.#declaredAgents = new Map(
      subAgents.map((agent) => [agent.name, agent]),
    );
    if (config.createAgentFactory && config.gateway) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        "Dynamic workflow agents cannot be combined with a custom gateway",
      );
    }
    this.#gateway = config.gateway;
    this.#createAgentFactory = config.createAgentFactory;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const declaredAgents = new Map(this.#declaredAgents);
    let dynamicAgents: DynamicAgentScope | undefined;
    let executionPromise: Promise<unknown> | undefined;
    let executionSettled = false;
    const invocationAbort = new AbortController();
    try {
      dynamicAgents = await this.createDynamicAgentScope(
        context,
        declaredAgents,
      );
      const queue = new AsyncEventQueue<Event>();
      const executionDefinition = this.createExecutionDefinition(dynamicAgents);
      const gateway =
        this.#gateway ??
        new AgentInvocationGateway({
          resolveAgent: (name) => declaredAgents.get(name),
        });
      const runtime = new WorkflowRuntime({
        definition: executionDefinition,
        checkpointDefinition: this.definition,
        parentContext: context,
        agentName: this.name,
        declaredAgents,
        gateway,
        eventSink: async (event) => {
          queue.push(event);
          const workflowEvent = event.customMetadata?.workflowEvent;
          if (this.#onEvent && isWorkflowEvent(workflowEvent)) {
            await this.#onEvent(workflowEvent);
          }
        },
        checkpointStore: this.#checkpointStore,
        resolveExecutionId: this.#resolveExecutionId,
        hooks: this.#runtimeHooks,
        workspace: this.#workspace,
        abortSignal: invocationAbort.signal,
      });

      executionPromise = runtime.execute();
      void executionPromise.then(
        () => {
          executionSettled = true;
          queue.close();
        },
        (error) => {
          executionSettled = true;
          queue.fail(error);
        },
      );
      yield* queue;
    } finally {
      if (executionPromise && !executionSettled) {
        invocationAbort.abort(
          new WorkflowError(
            "WORKFLOW_ABORTED",
            "Workflow invocation iterator closed before execution completed",
          ),
        );
      }
      await executionPromise?.catch(() => undefined);
      await dynamicAgents?.releaseAll();
    }
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsyncImpl(context);
  }

  private createExecutionDefinition(
    dynamicAgents: DynamicAgentScope | undefined,
  ): TrustedWorkflowDefinition {
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
            ...(dynamicAgents
              ? {
                  spawnAgent: (request) => dynamicAgents.spawn(request),
                  listAgents: () => dynamicAgents.list(),
                  releaseAgent: (name) => dynamicAgents.release(name),
                }
              : {}),
          },
        });
        return execution.output;
      },
    };
  }

  private async createDynamicAgentScope(
    context: InvocationContext,
    declaredAgents: Map<string, BaseAgent>,
  ): Promise<DynamicAgentScope | undefined> {
    if (!this.#createAgentFactory) return undefined;
    let factory: WorkflowAgentFactory;
    try {
      factory = await this.#createAgentFactory(context);
    } catch {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow dynamic agent factory initialization failed",
      );
    }
    if (!isWorkflowAgentFactory(factory)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow dynamic agent factory is invalid",
      );
    }
    return new DynamicAgentScope(factory, declaredAgents);
  }
}

class DynamicAgentScope {
  readonly #factory: WorkflowAgentFactory;
  readonly #declaredAgents: Map<string, BaseAgent>;
  readonly #staticNames: ReadonlySet<string>;
  readonly #handles = new Map<string, ScopedAgentHandle>();
  readonly #releasedNames = new Set<string>();

  constructor(
    factory: WorkflowAgentFactory,
    declaredAgents: Map<string, BaseAgent>,
  ) {
    this.#factory = factory;
    this.#declaredAgents = declaredAgents;
    this.#staticNames = new Set(declaredAgents.keys());
  }

  async spawn(
    request: WorkflowAgentFactoryRequest,
  ): Promise<WorkflowAgentDescriptor> {
    if (this.#staticNames.has(request.name)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Dynamic workflow agent cannot shadow static agent: ${request.name}`,
      );
    }
    if (this.#handles.has(request.name)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Dynamic workflow agent already exists: ${request.name}`,
      );
    }

    let handle: WorkflowAgentHandle;
    try {
      handle = await this.#factory.create(request);
    } catch (error) {
      throw sanitizedFactoryError("spawn", error);
    }
    const validated = validateHandle(handle, request);
    if (!validated) {
      try {
        await this.#factory.release(handle);
      } catch {
        // The invalid handle is never published; cleanup remains best effort.
      }
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow dynamic agent factory returned an invalid handle",
      );
    }

    this.#handles.set(request.name, {
      descriptor: validated.descriptor,
      handle,
    });
    this.#releasedNames.delete(request.name);
    this.#declaredAgents.set(request.name, validated.agent);
    return validated.descriptor;
  }

  list(): readonly WorkflowAgentDescriptor[] {
    return Object.freeze(
      [...this.#handles.values()].map(({ descriptor }) =>
        projectDescriptor(descriptor),
      ),
    );
  }

  async release(name: string): Promise<boolean> {
    if (this.#staticNames.has(name)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Static workflow agent cannot be released: ${name}`,
      );
    }
    const scoped = this.#handles.get(name);
    if (!scoped) {
      if (this.#releasedNames.has(name)) return false;
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Unknown dynamic workflow agent: ${name}`,
      );
    }

    let released: boolean;
    try {
      released = await this.#factory.release(scoped.handle);
    } catch (error) {
      throw sanitizedFactoryError("release", error);
    }
    if (!released) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow dynamic agent factory rejected its active handle",
      );
    }
    this.#handles.delete(name);
    this.#declaredAgents.delete(name);
    this.#releasedNames.add(name);
    return true;
  }

  async releaseAll(): Promise<void> {
    for (const [name, scoped] of [...this.#handles].reverse()) {
      try {
        await this.#factory.release(scoped.handle);
      } catch {
        // Continue releasing every handle even if a custom factory misbehaves.
      } finally {
        this.#handles.delete(name);
        this.#declaredAgents.delete(name);
        this.#releasedNames.add(name);
      }
    }
  }
}

interface ScopedAgentHandle {
  descriptor: WorkflowAgentDescriptor;
  handle: WorkflowAgentHandle;
}

function isWorkflowAgentFactory(value: unknown): value is WorkflowAgentFactory {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as WorkflowAgentFactory).create === "function" &&
      typeof (value as WorkflowAgentFactory).get === "function" &&
      typeof (value as WorkflowAgentFactory).list === "function" &&
      typeof (value as WorkflowAgentFactory).release === "function"
    );
  } catch {
    return false;
  }
}

function validateHandle(
  handle: WorkflowAgentHandle,
  request: WorkflowAgentFactoryRequest,
): { agent: BaseAgent; descriptor: WorkflowAgentDescriptor } | undefined {
  try {
    if (typeof handle !== "object" || handle === null) return undefined;
    const descriptor = handle.descriptor;
    const agent = handle.agent;
    if (
      typeof descriptor !== "object" ||
      descriptor === null ||
      descriptor.providerId !== request.providerId ||
      descriptor.name !== request.name ||
      typeof descriptor.revision !== "string" ||
      descriptor.revision.length === 0 ||
      descriptor.revision !== descriptor.revision.trim() ||
      descriptor.revision.includes("\0") ||
      descriptor.revision.length > MAX_WORKFLOW_AGENT_REVISION_LENGTH ||
      !(agent instanceof BaseAgent) ||
      agent.name !== request.name
    ) {
      return undefined;
    }
    return { agent, descriptor: projectDescriptor(descriptor) };
  } catch {
    return undefined;
  }
}

function projectDescriptor(
  descriptor: WorkflowAgentDescriptor,
): WorkflowAgentDescriptor {
  return Object.freeze({
    providerId: descriptor.providerId,
    name: descriptor.name,
    revision: descriptor.revision,
  });
}

function sanitizedFactoryError(operation: string, error: unknown) {
  const factoryCode = safeFactoryErrorCode(error);
  return new WorkflowError(
    "WORKFLOW_EXECUTION_ERROR",
    `Workflow dynamic agent ${operation} failed`,
    factoryCode ? { factoryCode } : undefined,
  );
}

function safeFactoryErrorCode(error: unknown): string | undefined {
  try {
    return typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^WORKFLOW_AGENT_[A-Z_]+$/u.test(error.code)
      ? error.code
      : undefined;
  } catch {
    return undefined;
  }
}

function mergeLimits(
  definitionLimits: WorkflowExecutionLimits | undefined,
  overrides: WorkflowExecutionLimits | undefined,
): WorkflowExecutionLimits | undefined {
  if (!definitionLimits && !overrides) return undefined;
  return { ...definitionLimits, ...overrides };
}
