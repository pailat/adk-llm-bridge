import {
  BaseAgent,
  type Event,
  type InvocationContext,
  type NodeContext,
} from "@google/adk";
import { AgentInvocationGateway } from "../runtime/agent-invocation-gateway.js";
import type { WorkflowCheckpointStore } from "./checkpoint/store.js";
import type { TrustedWorkflowDefinition } from "./definition.js";
import {
  invocationContextForNode,
  pickWorkflowNodeConfig,
  resolveRetryFailedSteps,
  type WorkflowNodeConfig,
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
import type { WorkflowWorkspaceConfig } from "./workspace/workspace-adapter.js";

/** Configuration of a {@link WorkflowAgent}. */
export interface WorkflowAgentConfig extends WorkflowNodeConfig {
  /** ADK agent name. */
  name: string;
  /** Agent description. Defaults to the definition's description. */
  description?: string;
  /** Trusted workflow this agent runs. */
  definition: TrustedWorkflowDefinition;
  /** Sub-agents the workflow steps may invoke by name. */
  subAgents?: BaseAgent[];
  /** Optional gateway injection for instrumentation and deterministic tests. */
  gateway?: AgentInvocationGateway;
  /** Checkpoint persistence adapter. Defaults to ADK session state deltas. */
  checkpointStore?: WorkflowCheckpointStore;
  /** Stable durable identity. Defaults to the ADK invocation id. */
  resolveExecutionId?: WorkflowExecutionIdResolver;
  /** Internal durability extension point; not required by trusted workflows. */
  runtimeHooks?: WorkflowRuntimeHooks;
  /** Optional host-side coordination for steps that declare write paths. */
  workspace?: WorkflowWorkspaceConfig;
}

/**
 * A trusted, versioned workflow that participates in ADK as a BaseAgent.
 *
 * @example
 * ```ts
 * const agent = new WorkflowAgent({
 *   name: "pipeline",
 *   definition: defineWorkflow({
 *     id: "pipeline",
 *     version: "1",
 *     handler: async (ctx) =>
 *       (await ctx.run({ id: "s1", agentName: "writer", input: ctx.inputText }))
 *         .output,
 *   }),
 *   subAgents: [writer],
 * });
 * ```
 */
export class WorkflowAgent extends BaseAgent {
  /** The workflow definition this agent runs. */
  readonly definition: TrustedWorkflowDefinition;
  readonly #gateway: AgentInvocationGateway;
  readonly #checkpointStore?: WorkflowCheckpointStore;
  readonly #retryFailedSteps: boolean;
  readonly #activeExecutions = new ActiveExecutions();
  readonly #resolveExecutionId?: WorkflowExecutionIdResolver;
  readonly #runtimeHooks?: WorkflowRuntimeHooks;
  readonly #workspace?: WorkflowWorkspaceConfig;
  readonly #declaredAgents: ReadonlyMap<string, BaseAgent>;

  /**
   * @param config - Agent identity, definition, sub-agents and optional
   * persistence and workspace adapters.
   */
  constructor(config: WorkflowAgentConfig) {
    const subAgents = config.subAgents ?? [];
    super({
      name: config.name,
      description: config.description ?? config.definition.description,
      subAgents,
      ...pickWorkflowNodeConfig(config),
    });
    this.definition = config.definition;
    this.#checkpointStore = config.checkpointStore;
    this.#resolveExecutionId = config.resolveExecutionId;
    this.#retryFailedSteps = resolveRetryFailedSteps(config);
    this.#runtimeHooks = config.runtimeHooks;
    this.#workspace = config.workspace;
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
    yield* streamWorkflowRuntime(
      ({ push, signal }) =>
        new WorkflowRuntime({
          definition: this.definition,
          parentContext: context,
          agentName: this.name,
          declaredAgents: this.#declaredAgents,
          gateway: this.#gateway,
          eventSink: push,
          hooks: this.#runtimeHooks,
          checkpointStore: this.#checkpointStore,
          resolveExecutionId: this.#resolveExecutionId,
          workspace: this.#workspace,
          abortSignal: signal,
          structuredOutput: this.outputSchema !== undefined,
          retryFailedSteps: this.#retryFailedSteps,
        }),
      this.#activeExecutions,
    );
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
}
