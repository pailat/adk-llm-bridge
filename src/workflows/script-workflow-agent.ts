import {
  BaseAgent,
  type Event,
  type InvocationContext,
  type NodeContext,
} from "@google/adk";
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
import { attachCause } from "./internal/error-support.js";
import { WORKFLOW_AGENT_BRAND } from "./internal/workflow-agent-brand.js";
import {
  invocationContextForNode,
  resolveRetryFailedSteps,
  type WorkflowNodeConfig,
  workflowAgentBaseConfig,
} from "./node-config.js";
import {
  ActiveExecutions,
  streamWorkflowRuntime,
} from "./runtime/stream-runtime.js";
import {
  type WorkflowExecutionIdResolver,
  WorkflowRuntime,
  type WorkflowRuntimeHooks,
} from "./runtime/workflow-runtime.js";
import { QuickJSSyncGeneratorRuntime } from "./sandbox/quickjs-generator-runtime.js";
import type { WorkflowScriptRuntime } from "./sandbox/types.js";
import { runWorkflowScript } from "./sandbox/workflow-script-runner.js";
import type { WorkflowWorkspaceConfig } from "./workspace/workspace-adapter.js";

/**
 * Configuration of a {@link ScriptWorkflowAgent}.
 *
 * @remarks
 * The whole object is forwarded to `BaseAgent`, so `clone()` rebuilds the
 * agent from it: the clone shares the definition and any `runtime`,
 * `gateway`, `createAgentFactory`, `checkpointStore`, `runtimeHooks` and
 * `workspace` given here (without `runtime`, each instance creates its own
 * QuickJS runtime), and gets clones of the sub-agents.
 */
export interface ScriptWorkflowAgentConfig extends WorkflowNodeConfig {
  /** ADK agent name. */
  name: string;
  /** Agent description. Defaults to the definition's description. */
  description?: string;
  /** Script workflow this agent runs. */
  definition: ScriptWorkflowDefinition;
  /** Static sub-agents the script may invoke by name. */
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

/**
 * A sandboxed, versioned script workflow that participates in ADK as an agent.
 *
 * @remarks
 * The script runs in an isolated runtime (QuickJS by default) and reaches the
 * host only through yielded step, parallel, emit and dynamic-agent operations.
 */
export class ScriptWorkflowAgent extends BaseAgent {
  /** @internal */
  readonly [WORKFLOW_AGENT_BRAND] = true;
  /** The script workflow definition this agent runs. */
  readonly definition: ScriptWorkflowDefinition;
  readonly #scriptRuntime: WorkflowScriptRuntime;
  readonly #gateway: AgentInvocationGateway | undefined;
  readonly #createAgentFactory:
    | ((
        context: InvocationContext,
      ) => WorkflowAgentFactory | Promise<WorkflowAgentFactory>)
    | undefined;
  readonly #checkpointStore: WorkflowCheckpointStore | undefined;
  readonly #retryFailedSteps: boolean;
  readonly #activeExecutions = new ActiveExecutions();
  readonly #resolveExecutionId: WorkflowExecutionIdResolver | undefined;
  readonly #runtimeHooks: WorkflowRuntimeHooks | undefined;
  readonly #workspace: WorkflowWorkspaceConfig | undefined;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;
  readonly #limits: WorkflowExecutionLimits | undefined;
  readonly #onEvent:
    | ((event: WorkflowEvent) => void | Promise<void>)
    | undefined;

  /**
   * @param config - Agent identity, definition, sub-agents and optional
   * runtime, persistence and dynamic-agent adapters.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when
   * both `createAgentFactory` and `gateway` are set: a custom gateway cannot
   * see agents created dynamically.
   */
  constructor(config: ScriptWorkflowAgentConfig) {
    const subAgents = config.subAgents ?? [];
    super(
      workflowAgentBaseConfig(config, {
        description: config.definition.description,
      }),
    );
    this.definition = config.definition;
    this.#checkpointStore = config.checkpointStore;
    this.#resolveExecutionId = config.resolveExecutionId;
    this.#retryFailedSteps = resolveRetryFailedSteps(config);
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
    try {
      dynamicAgents = await this.createDynamicAgentScope(
        context,
        declaredAgents,
      );
      const executionDefinition = this.createExecutionDefinition(dynamicAgents);
      const gateway =
        this.#gateway ??
        new AgentInvocationGateway({
          resolveAgent: (name) => declaredAgents.get(name),
        });
      yield* streamWorkflowRuntime(
        ({ push, signal }) =>
          new WorkflowRuntime({
            definition: executionDefinition,
            checkpointDefinition: this.definition,
            parentContext: context,
            agentName: this.name,
            declaredAgents,
            gateway,
            eventSink: async (event) => {
              push(event);
              const workflowEvent = event.customMetadata?.workflowEvent;
              if (this.#onEvent && isWorkflowEvent(workflowEvent)) {
                await this.#onEvent(workflowEvent);
              }
            },
            checkpointStore: this.#checkpointStore,
            resolveExecutionId: this.#resolveExecutionId,
            hooks: this.#runtimeHooks,
            workspace: this.#workspace,
            abortSignal: signal,
            structuredOutput: this.outputSchema !== undefined,
            retryFailedSteps: this.#retryFailedSteps,
          }),
        this.#activeExecutions,
      );
    } finally {
      await dynamicAgents?.releaseAll();
    }
  }

  protected override async *runImpl(
    ctx: NodeContext,
    _nodeInput: unknown,
  ): AsyncGenerator<Event, void, void> {
    yield* this.runAsync(invocationContextForNode(ctx));
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
          // The workflow runtime below enforces both step limits per step.
          replaysFromCheckpoint: this.#checkpointStore !== undefined,
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
    } catch (error) {
      throw attachCause(
        new WorkflowError(
          "WORKFLOW_EXECUTION_ERROR",
          "Workflow dynamic agent factory initialization failed",
        ),
        error,
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
