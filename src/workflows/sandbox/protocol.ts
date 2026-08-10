/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

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

export const WORKFLOW_SCRIPT_PROTOCOL = "adk-llm-bridge/workflow-rpc";
export const WORKFLOW_SCRIPT_PROTOCOL_VERSION = 1;

interface WorkflowScriptOperationBase {
  protocol: typeof WORKFLOW_SCRIPT_PROTOCOL;
  version: typeof WORKFLOW_SCRIPT_PROTOCOL_VERSION;
}

export interface WorkflowScriptRunOperation
  extends WorkflowScriptOperationBase {
  op: "run";
  step: WorkflowStep;
}

export interface WorkflowScriptParallelOperation
  extends WorkflowScriptOperationBase {
  op: "parallel";
  steps: readonly WorkflowStep[];
  options?: WorkflowParallelOptions;
}

export interface WorkflowScriptEmitOperation
  extends WorkflowScriptOperationBase {
  op: "emit";
  event: WorkflowUserEvent;
}

export interface WorkflowScriptSpawnAgentOperation
  extends WorkflowScriptOperationBase {
  op: "spawnAgent";
  request: WorkflowAgentFactoryRequest;
}

export interface WorkflowScriptListAgentsOperation
  extends WorkflowScriptOperationBase {
  op: "listAgents";
}

export interface WorkflowScriptReleaseAgentOperation
  extends WorkflowScriptOperationBase {
  op: "releaseAgent";
  name: string;
}

export interface WorkflowScriptFinalOperation
  extends WorkflowScriptOperationBase {
  op: "final";
  output?: unknown;
}

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
  run(step: WorkflowStep): Promise<WorkflowStepResult>;
  parallel(
    steps: readonly WorkflowStep[],
    options?: WorkflowParallelOptions,
  ): Promise<WorkflowStepOutcome[]>;
  emit(event: WorkflowUserEvent): void | Promise<void>;
  spawnAgent?(
    request: WorkflowAgentFactoryRequest,
  ): WorkflowAgentDescriptor | Promise<WorkflowAgentDescriptor>;
  listAgents?():
    | readonly WorkflowAgentDescriptor[]
    | Promise<readonly WorkflowAgentDescriptor[]>;
  releaseAgent?(name: string): boolean | Promise<boolean>;
}
