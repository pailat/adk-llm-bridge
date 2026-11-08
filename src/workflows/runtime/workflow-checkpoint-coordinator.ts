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
  withWorkflowStepWaiting,
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
  WorkflowStepInterrupt,
  WorkflowStepResult,
} from "../contracts.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowDefinition } from "../definition.js";
import {
  isRememberedLegacyDigest,
  legacyDigest,
  resolveStoredDigest,
} from "../internal/canonical-hash.js";

export interface WorkflowCheckpointCoordinatorConfig {
  definition: WorkflowDefinition;
  executionId: string;
  input: Content;
  context: InvocationContext;
  store: WorkflowCheckpointStore;
  /** Re-execute steps whose last attempt failed when the run is re-entered. */
  retryFailedSteps?: boolean;
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
        // A checkpoint written before 0.7.0 keeps its legacy input hash.
        const inputHash = await resolveStoredDigest(
          saved.inputHash,
          candidate.inputHash,
          () => legacyDigest(this.#config.input, "locale"),
        );
        validateWorkflowCheckpoint(saved, {
          ...checkpointExpectation(candidate),
          inputHash,
        });
        const revision = await workflowCheckpointRevision(saved);
        this.#checkpoint = toDurableWorkflowCheckpoint(saved);
        this.#revision = revision;
        return;
      }

      await this.#persist(candidate, undefined, null);
    });
  }

  /** Original input stored with a waiting checkpoint, when there is one. */
  static async savedInput(
    store: WorkflowCheckpointStore,
    context: InvocationContext,
    workflowId: string,
    executionId: string,
    answeredIds: ReadonlySet<string>,
  ): Promise<Content | undefined> {
    const saved = await store.load({ context, workflowId, executionId });
    if (!saved || !isWorkflowCheckpointV1(saved)) return undefined;
    const answered = Object.values(saved.steps).some(
      (step) =>
        step.status === "waiting" &&
        step.interrupt?.functionCallIds.some((id) => answeredIds.has(id)),
    );
    return answered ? saved.input : undefined;
  }

  /**
   * Returns `step` with the agent revision already stored for it when that
   * revision is the pre-0.7.0 form of `step.agentRevision`, so a resumed step
   * keeps its checkpoint identity and idempotency key.
   */
  withStoredAgentRevision(step: WorkflowStep): WorkflowStep {
    const saved = this.checkpoint().steps[step.id]?.agentRevision;
    if (
      saved === undefined ||
      step.agentRevision === undefined ||
      saved === step.agentRevision ||
      !isRememberedLegacyDigest(saved, step.agentRevision)
    ) {
      return step;
    }
    return { ...step, agentRevision: saved };
  }

  async prepareStep(step: WorkflowStep): Promise<PreparedWorkflowStep> {
    const currentHash = await hashWorkflowInput(step.input);
    return this.#exclusive(async () => {
      const checkpoint = this.checkpoint();
      // A step checkpointed before 0.7.0 keeps its legacy input hash.
      const inputHash = await resolveStoredDigest(
        checkpoint.steps[step.id]?.inputHash,
        currentHash,
        () => legacyDigest(step.input, "locale"),
      );
      const resolution = resolveWorkflowStep(checkpoint, step, inputHash, {
        retryFailed: this.#config.retryFailedSteps,
      });
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

  /** Persists the step as waiting for input, keeping the workflow input. */
  async waitStep(
    step: WorkflowStep,
    inputHash: string,
    attempt: number,
    interrupt: WorkflowStepInterrupt,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepWaiting(
        this.checkpoint(),
        step,
        inputHash,
        attempt,
        interrupt,
        this.#config.input,
      );
      await this.#persist(candidate, step.id);
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
