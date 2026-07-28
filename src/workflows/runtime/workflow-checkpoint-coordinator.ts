/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import type { InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import {
  checkpointExpectation,
  createWorkflowCheckpoint,
  resolveWorkflowStep,
  validateWorkflowCheckpoint,
  type WorkflowStepResolution,
  withWorkflowCompleted,
  withWorkflowFailed,
  withWorkflowStepCompleted,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
} from "../checkpoint/checkpoint.js";
import { hashWorkflowInput } from "../checkpoint/hash.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointV1,
} from "../checkpoint/schema.js";
import type {
  WorkflowCheckpointRevision,
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
import { workflowCheckpointRevision } from "../checkpoint/store.js";
import type {
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepResult,
} from "../contracts.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowDefinition } from "../definition.js";

export interface WorkflowCheckpointCoordinatorConfig {
  definition: WorkflowDefinition;
  executionId: string;
  input: Content;
  context: InvocationContext;
  store: WorkflowCheckpointStore;
  onWrite: (
    write: WorkflowCheckpointWrite,
    stepId?: string,
  ) => void | Promise<void>;
}

export interface PreparedWorkflowStep {
  inputHash: string;
  resolution: WorkflowStepResolution;
}

/**
 * Owns the in-memory checkpoint for one workflow invocation.
 *
 * Mutations are serialized so parallel steps always persist a snapshot that
 * contains every preceding transition. The coordinator never mutates ADK
 * session state; persistence is surfaced through the store's state delta.
 */
export class WorkflowCheckpointCoordinator {
  readonly #config: WorkflowCheckpointCoordinatorConfig;
  #checkpoint?: WorkflowCheckpointV1;
  #revision: WorkflowCheckpointRevision | null | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(config: WorkflowCheckpointCoordinatorConfig) {
    this.#config = config;
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = await createWorkflowCheckpoint({
        definition: this.#config.definition,
        executionId: this.#config.executionId,
        input: this.#config.input,
      });
      const saved = await this.#config.store.load({
        context: this.#config.context,
        workflowId: this.#config.definition.id,
        executionId: this.#config.executionId,
      });

      if (saved) {
        if (!isWorkflowCheckpointV1(saved)) {
          throw new WorkflowError(
            "WORKFLOW_EXECUTION_ERROR",
            "Checkpoint store returned an invalid workflow checkpoint",
          );
        }
        validateWorkflowCheckpoint(saved, checkpointExpectation(candidate));
        const revision = await workflowCheckpointRevision(saved);
        this.#checkpoint = toDurableWorkflowCheckpoint(saved);
        this.#revision = revision;
        return;
      }

      await this.#persist(candidate, undefined, null);
    });
  }

  async prepareStep(step: WorkflowStep): Promise<PreparedWorkflowStep> {
    const inputHash = await hashWorkflowInput(step.input);
    return this.#exclusive(async () => {
      const checkpoint = this.checkpoint();
      const resolution = resolveWorkflowStep(checkpoint, step, inputHash);
      if (resolution.action === "execute") {
        const candidate = withWorkflowStepRunning(
          checkpoint,
          step,
          inputHash,
          resolution.attempt,
        );
        await this.#persist(candidate, step.id);
      }
      return { inputHash, resolution };
    });
  }

  async startAttempt(
    step: WorkflowStep,
    inputHash: string,
    attempt: number,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepRunning(
        this.checkpoint(),
        step,
        inputHash,
        attempt,
      );
      await this.#persist(candidate, step.id);
    });
  }

  async completeStep(result: WorkflowStepResult): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepCompleted(this.checkpoint(), result);
      await this.#persist(candidate, result.id);
    });
  }

  async failStep(failure: WorkflowStepFailure): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepFailed(this.checkpoint(), failure);
      await this.#persist(candidate, failure.id);
    });
  }

  async completeWorkflow(output: string | Content | undefined): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowCompleted(this.checkpoint(), output);
      await this.#persist(candidate);
    });
  }

  async failWorkflow(
    error: WorkflowSerializedError,
    status: "failed" | "cancelled",
  ): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowFailed(this.checkpoint(), error, status);
      await this.#persist(candidate);
    });
  }

  private checkpoint(): WorkflowCheckpointV1 {
    if (!this.#checkpoint) {
      throw new WorkflowError(
        "WORKFLOW_EXECUTION_ERROR",
        "Workflow checkpoint coordinator is not initialized",
      );
    }
    return this.#checkpoint;
  }

  async #persist(
    candidate: WorkflowCheckpointV1,
    stepId?: string,
    expectedRevision: WorkflowCheckpointRevision | null | undefined = this
      .#revision,
  ): Promise<void> {
    const durableCandidate = toDurableWorkflowCheckpoint(candidate);
    const revision = await workflowCheckpointRevision(durableCandidate);
    const write = await this.#config.store.save({
      context: this.#config.context,
      checkpoint: durableCandidate,
      expectedRevision,
      revision,
    });

    // A successful store write is the commit boundary. The notification hook
    // may fail, but it cannot roll back the durable checkpoint or its revision.
    this.#checkpoint = durableCandidate;
    this.#revision = revision;
    await this.#config.onWrite(write, stepId);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
