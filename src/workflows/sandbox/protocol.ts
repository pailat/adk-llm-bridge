import type {
  WorkflowAgentDescriptor,
  WorkflowAgentFactoryRequest,
} from "../agents/workflow-agent-factory.js";
import type {
  WorkflowParallelOptions,
  WorkflowStep,
  WorkflowStepOutcome,
  WorkflowStepResult,
} from "../contracts.js";
import type { WorkflowUserEvent } from "../events.js";

/**
 * Protocol identifier carried by every operation a script yields.
 *
 * @internal
 */
export const WORKFLOW_SCRIPT_PROTOCOL = "adk-llm-bridge/workflow-rpc";
/**
 * Version of the script operation protocol; operations with another version are rejected.
 *
 * @internal
 */
export const WORKFLOW_SCRIPT_PROTOCOL_VERSION = 1;

/** Fields shared by every operation a script yields to the host. */
interface WorkflowScriptOperationBase {
  protocol: typeof WORKFLOW_SCRIPT_PROTOCOL;
  version: typeof WORKFLOW_SCRIPT_PROTOCOL_VERSION;
}

/**
 * Asks the host to run one workflow step.
 *
 * @internal
 */
export interface WorkflowScriptRunOperation
  extends WorkflowScriptOperationBase {
  op: "run";
  step: WorkflowStep;
}

/**
 * Asks the host to run several steps concurrently.
 *
 * @internal
 */
export interface WorkflowScriptParallelOperation
  extends WorkflowScriptOperationBase {
  op: "parallel";
  steps: readonly WorkflowStep[];
  options?: WorkflowParallelOptions;
}

/**
 * Asks the host to emit a user event.
 *
 * @internal
 */
export interface WorkflowScriptEmitOperation
  extends WorkflowScriptOperationBase {
  op: "emit";
  event: WorkflowUserEvent;
}

/**
 * Asks the host to create a dynamic agent.
 *
 * @internal
 */
export interface WorkflowScriptSpawnAgentOperation
  extends WorkflowScriptOperationBase {
  op: "spawnAgent";
  request: WorkflowAgentFactoryRequest;
}

/**
 * Asks the host to list the dynamic agents available to the script.
 *
 * @internal
 */
export interface WorkflowScriptListAgentsOperation
  extends WorkflowScriptOperationBase {
  op: "listAgents";
}

/**
 * Asks the host to release a dynamic agent by name.
 *
 * @internal
 */
export interface WorkflowScriptReleaseAgentOperation
  extends WorkflowScriptOperationBase {
  op: "releaseAgent";
  name: string;
}

/**
 * Ends the script and supplies the workflow output.
 *
 * @internal
 */
export interface WorkflowScriptFinalOperation
  extends WorkflowScriptOperationBase {
  op: "final";
  output?: unknown;
}

/**
 * Union of every operation a workflow script can yield to the host.
 *
 * @internal
 */
export type WorkflowScriptOperation =
  | WorkflowScriptRunOperation
  | WorkflowScriptParallelOperation
  | WorkflowScriptEmitOperation
  | WorkflowScriptSpawnAgentOperation
  | WorkflowScriptListAgentsOperation
  | WorkflowScriptReleaseAgentOperation
  | WorkflowScriptFinalOperation;

/** Host capabilities invoked between synchronous QuickJS generator turns. */
export interface WorkflowScriptHost {
  /** Runs one step and resolves with its result. */
  run(step: WorkflowStep): Promise<WorkflowStepResult>;
  /** Runs steps concurrently and resolves with one outcome per step. */
  parallel(
    steps: readonly WorkflowStep[],
    options?: WorkflowParallelOptions,
  ): Promise<WorkflowStepOutcome[]>;
  /** Emits a user event to the workflow event stream. */
  emit(event: WorkflowUserEvent): void | Promise<void>;
  /** Creates a dynamic agent; absent when the host does not support dynamic agents. */
  spawnAgent?(
    request: WorkflowAgentFactoryRequest,
  ): WorkflowAgentDescriptor | Promise<WorkflowAgentDescriptor>;
  /** Lists dynamic agents; absent when the host does not support dynamic agents. */
  listAgents?():
    | readonly WorkflowAgentDescriptor[]
    | Promise<readonly WorkflowAgentDescriptor[]>;
  /** Releases a dynamic agent; resolves true when it existed. */
  releaseAgent?(name: string): boolean | Promise<boolean>;
}
