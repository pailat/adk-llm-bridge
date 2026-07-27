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
import type { WorkflowCheckpointV1 } from "../checkpoint/schema.js";
import type {
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
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
  #tail: Promise<void> = Promise.resolve();

  constructor(config: WorkflowCheckpointCoordinatorConfig) {
    this.#config = config;
  }

  async initialize(): Promise<void> {
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
      validateWorkflowCheckpoint(saved, checkpointExpectation(candidate));
      this.#checkpoint = saved;
      return;
    }

    this.#checkpoint = candidate;
    await this.#persist();
  }

  async prepareStep(step: WorkflowStep): Promise<PreparedWorkflowStep> {
    const inputHash = await hashWorkflowInput(step.input);
    return this.#exclusive(async () => {
      const checkpoint = this.checkpoint();
      const resolution = resolveWorkflowStep(checkpoint, step, inputHash);
      if (resolution.action === "execute") {
        this.#checkpoint = withWorkflowStepRunning(
          checkpoint,
          step,
          inputHash,
          resolution.attempt,
        );
        await this.#persist(step.id);
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
      this.#checkpoint = withWorkflowStepRunning(
        this.checkpoint(),
        step,
        inputHash,
        attempt,
      );
      await this.#persist(step.id);
    });
  }

  async completeStep(result: WorkflowStepResult): Promise<void> {
    await this.#exclusive(async () => {
      this.#checkpoint = withWorkflowStepCompleted(this.checkpoint(), result);
      await this.#persist(result.id);
    });
  }

  async failStep(failure: WorkflowStepFailure): Promise<void> {
    await this.#exclusive(async () => {
      this.#checkpoint = withWorkflowStepFailed(this.checkpoint(), failure);
      await this.#persist(failure.id);
    });
  }

  async completeWorkflow(output: string | Content | undefined): Promise<void> {
    await this.#exclusive(async () => {
      this.#checkpoint = withWorkflowCompleted(this.checkpoint(), output);
      await this.#persist();
    });
  }

  async failWorkflow(
    error: WorkflowSerializedError,
    status: "failed" | "cancelled",
  ): Promise<void> {
    await this.#exclusive(async () => {
      this.#checkpoint = withWorkflowFailed(this.checkpoint(), error, status);
      await this.#persist();
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

  async #persist(stepId?: string): Promise<void> {
    const write = await this.#config.store.save({
      context: this.#config.context,
      checkpoint: this.checkpoint(),
    });
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
