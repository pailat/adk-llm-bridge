/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { InvocationContext } from "@google/adk";
import { WorkflowError } from "../contracts.js";
import { hashWorkflowValue } from "./hash.js";
import type { WorkflowCheckpointV1 } from "./schema.js";
import { isWorkflowCheckpointV1 } from "./schema.js";

export const WORKFLOW_CHECKPOINT_STATE_PREFIX = "__adk_llm_bridge_workflow_v1";

const adkSessionCheckpointObservations = new WeakMap<
  InvocationContext["session"],
  Map<string, CheckpointObservation>
>();

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
  /**
   * Revision that must currently exist. `null` means the checkpoint must be
   * absent; `undefined` preserves unconditional writes for legacy adapters.
   */
  expectedRevision?: WorkflowCheckpointRevision | null;
  /** Deterministic revision of `checkpoint`, supplied by the coordinator. */
  revision?: WorkflowCheckpointRevision;
}

export type WorkflowCheckpointRevision = string;

export interface WorkflowCheckpointConflictDetails {
  reason: "checkpoint_revision_conflict";
  checkpointKey: string;
  expectedRevision: WorkflowCheckpointRevision | null;
  actualRevision: WorkflowCheckpointRevision | null;
}

/** Deterministic stale-write failure shared by checkpoint store adapters. */
export class WorkflowCheckpointConflictError extends WorkflowError {
  readonly conflict: WorkflowCheckpointConflictDetails;

  constructor(
    checkpointKey: string,
    expectedRevision: WorkflowCheckpointRevision | null,
    actualRevision: WorkflowCheckpointRevision | null,
  ) {
    const conflict: WorkflowCheckpointConflictDetails = {
      reason: "checkpoint_revision_conflict",
      checkpointKey,
      expectedRevision,
      actualRevision,
    };
    super(
      "WORKFLOW_EXECUTION_ERROR",
      `Workflow checkpoint revision conflict: ${checkpointKey}`,
      { ...conflict },
    );
    this.name = "WorkflowCheckpointConflictError";
    this.conflict = conflict;
  }
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
  /**
   * Durable adapters should compare `expectedRevision` and write the new
   * checkpoint atomically in one storage transaction. Optional CAS fields keep
   * existing unconditional adapters source-compatible.
   */
  save(input: SaveWorkflowCheckpointInput): Promise<WorkflowCheckpointWrite>;
}

export async function workflowCheckpointRevision(
  checkpoint: WorkflowCheckpointV1,
): Promise<WorkflowCheckpointRevision> {
  return await hashWorkflowValue(checkpoint);
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
 * is attached to an emitted event. A process-local shadow coordinates store
 * instances sharing the same ADK session object, but it is not an atomic
 * cross-process compare-and-swap guarantee.
 */
export class ADKSessionCheckpointStore implements WorkflowCheckpointStore {
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    const key = workflowCheckpointKey(input.workflowId, input.executionId);
    const observation = await this.#observe(input.context, key);
    return observation.currentCheckpoint;
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
    const observation = await this.#observe(input.context, checkpointKey);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== observation.currentRevision
    ) {
      throw new WorkflowCheckpointConflictError(
        checkpointKey,
        input.expectedRevision,
        observation.currentRevision,
      );
    }

    const revision = await workflowCheckpointRevision(input.checkpoint);
    if (input.revision !== undefined && input.revision !== revision) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        `Workflow checkpoint revision does not match checkpoint: ${checkpointKey}`,
        {
          checkpointKey,
          suppliedRevision: input.revision,
          computedRevision: revision,
        },
      );
    }
    observation.currentRevision = revision;
    observation.currentCheckpoint = input.checkpoint;

    return {
      checkpointKey,
      stateDelta: { [checkpointKey]: input.checkpoint },
    };
  }

  async #observe(
    context: InvocationContext,
    checkpointKey: string,
  ): Promise<CheckpointObservation> {
    const stateCheckpoint = checkpointFromState(context, checkpointKey);
    const stateRevision = stateCheckpoint
      ? await workflowCheckpointRevision(stateCheckpoint)
      : null;
    let byKey = adkSessionCheckpointObservations.get(context.session);
    if (!byKey) {
      byKey = new Map();
      adkSessionCheckpointObservations.set(context.session, byKey);
    }

    const existing = byKey.get(checkpointKey);
    if (!existing) {
      const observation = {
        stateRevision,
        currentRevision: stateRevision,
        currentCheckpoint: stateCheckpoint,
      };
      byKey.set(checkpointKey, observation);
      return observation;
    }

    if (stateRevision === existing.currentRevision) {
      existing.stateRevision = stateRevision;
      existing.currentCheckpoint = stateCheckpoint;
    } else if (stateRevision !== existing.stateRevision) {
      // The visible ADK state moved to a value other than our pending delta.
      existing.stateRevision = stateRevision;
      existing.currentRevision = stateRevision;
      existing.currentCheckpoint = stateCheckpoint;
    }
    return existing;
  }
}

interface CheckpointObservation {
  /** Last revision observed directly in ADK session state. */
  stateRevision: WorkflowCheckpointRevision | null;
  /** Latest revision returned as a pending stateDelta in this process. */
  currentRevision: WorkflowCheckpointRevision | null;
  currentCheckpoint: WorkflowCheckpointV1 | undefined;
}

function checkpointFromState(
  context: InvocationContext,
  checkpointKey: string,
): WorkflowCheckpointV1 | undefined {
  const value = context.session.state[checkpointKey];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isWorkflowCheckpointV1(value)) {
    throw new WorkflowError(
      "WORKFLOW_EXECUTION_ERROR",
      `Invalid workflow checkpoint in ADK session state: ${checkpointKey}`,
      { checkpointKey },
    );
  }
  return value;
}
