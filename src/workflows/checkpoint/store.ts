/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { InvocationContext } from "@google/adk";
import { WorkflowError } from "../contracts.js";
import type { WorkflowCheckpointV1 } from "./schema.js";
import { isWorkflowCheckpointV1 } from "./schema.js";

export const WORKFLOW_CHECKPOINT_STATE_PREFIX = "__adk_llm_bridge_workflow_v1";

export interface WorkflowCheckpointLocator {
  workflowId: string;
  executionId: string;
}

export interface LoadWorkflowCheckpointInput extends WorkflowCheckpointLocator {
  context: InvocationContext;
}

export interface SaveWorkflowCheckpointInput {
  context: InvocationContext;
  checkpoint: WorkflowCheckpointV1;
}

export interface WorkflowCheckpointWrite {
  checkpointKey: string;
  /** Attach this object to an ADK event through `actions.stateDelta`. */
  stateDelta: Record<string, unknown>;
}

export interface WorkflowCheckpointStore {
  load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined>;
  save(input: SaveWorkflowCheckpointInput): Promise<WorkflowCheckpointWrite>;
}

export function workflowCheckpointKey(
  workflowId: string,
  executionId: string,
): string {
  if (!workflowId.trim() || !executionId.trim()) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      "Workflow id and execution id are required for checkpointing",
    );
  }
  return `${WORKFLOW_CHECKPOINT_STATE_PREFIX}:${workflowId}:${executionId}`;
}

/**
 * Persists checkpoints through ADK's event stateDelta contract.
 *
 * `save` intentionally does not mutate `session.state`; the ADK Runner owns
 * state application and durable session persistence after the returned delta
 * is attached to an emitted event.
 */
export class ADKSessionCheckpointStore implements WorkflowCheckpointStore {
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    const key = workflowCheckpointKey(input.workflowId, input.executionId);
    const value = input.context.session.state[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!isWorkflowCheckpointV1(value)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Invalid workflow checkpoint in ADK session state: ${key}`,
        { checkpointKey: key },
      );
    }
    return value;
  }

  async save(
    input: SaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    if (!isWorkflowCheckpointV1(input.checkpoint)) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Cannot persist an invalid workflow checkpoint",
      );
    }
    const checkpointKey = workflowCheckpointKey(
      input.checkpoint.workflowId,
      input.checkpoint.executionId,
    );
    return {
      checkpointKey,
      stateDelta: { [checkpointKey]: input.checkpoint },
    };
  }
}
