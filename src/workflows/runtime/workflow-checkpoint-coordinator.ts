import type { InvocationContext } from "@google/adk";
import type { Content } from "@google/genai";
import { LogCode, warn } from "../../utils/log.js";
import {
  checkpointExpectation,
  classifyWorkflowStep,
  createWorkflowCheckpoint,
  validateWorkflowCheckpoint,
  type WorkflowStepResolution,
  withWorkflowCompleted,
  withWorkflowFailed,
  withWorkflowStepCompleted,
  withWorkflowStepFailed,
  withWorkflowStepRunning,
  withWorkflowStepWaiting,
} from "../checkpoint/checkpoint.js";
import { workflowStepInputCanonicalForm } from "../checkpoint/hash.js";
import {
  diffCanonicalInput,
  fingerprintCanonicalInput,
  type WorkflowStepMismatchHint,
} from "../checkpoint/input-diff.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointStepV1,
  type WorkflowCheckpointV1,
  type WorkflowStepResumeReason,
} from "../checkpoint/schema.js";
import type { WorkflowCheckpointStepRecordV1 } from "../checkpoint/step-record.js";
import type {
  WorkflowCheckpointRevision,
  WorkflowCheckpointStore,
  WorkflowCheckpointWrite,
} from "../checkpoint/store.js";
import {
  workflowCheckpointByteLength,
  workflowCheckpointRevision,
} from "../checkpoint/store.js";
import type {
  WorkflowSerializedError,
  WorkflowStep,
  WorkflowStepFailure,
  WorkflowStepInterrupt,
  WorkflowStepResult,
} from "../contracts.js";
import { WorkflowError } from "../contracts.js";
import type { WorkflowDefinition } from "../definition.js";
import type { WorkflowCheckpointSizeContributor } from "../events.js";
import {
  isRememberedLegacyDigest,
  legacyDigest,
  resolveStoredDigest,
  sha256Digest,
} from "../internal/canonical-hash.js";
import type { ResolvedWorkflowReplayOptions } from "../node-config.js";
import {
  enrichCheckpointSizeError,
  isCheckpointSizeSaveError,
  largestCheckpointContributors,
  reachesCheckpointSizeWarning,
} from "./checkpoint-size.js";

/**
 * A saved checkpoint that reached the size warning threshold.
 *
 * @internal
 */
export interface WorkflowCheckpointSizeWarning {
  /** Key of the checkpoint. */
  checkpointKey: string;
  /** Step whose transition triggered the save, if any. */
  stepId?: string;
  /** UTF-8 JSON size of the saved checkpoint. */
  bytes: number;
  /** The store's limit. */
  maxBytes: number;
  /** Largest parts of the checkpoint, largest first. */
  largestContributors: WorkflowCheckpointSizeContributor[];
}

/**
 * Dependencies and options for {@link WorkflowCheckpointCoordinator}.
 *
 * @internal
 */
export interface WorkflowCheckpointCoordinatorConfig {
  /** Definition whose id and version identify the checkpoint. */
  definition: WorkflowDefinition;
  /** Durable execution id the checkpoint is keyed by. */
  executionId: string;
  /** Workflow input, hashed into the checkpoint. */
  input: Content;
  /** ADK invocation the checkpoint store reads and writes through. */
  context: InvocationContext;
  /** Store that loads and saves the checkpoint with revision-based compare-and-set. */
  store: WorkflowCheckpointStore;
  /** Re-execute steps whose last attempt failed when the run is re-entered. */
  retryFailedSteps?: boolean;
  /** This turn answers a waiting step; recorded failures are replayed, never re-run. */
  answerTurn?: boolean;
  /** Model and input-change handling on replayed steps; defaults apply when omitted. */
  replay?: ResolvedWorkflowReplayOptions;
  /** Called after each successful store write, with the id of the step that triggered it when there is one; a failure here cannot roll back the committed checkpoint. */
  onWrite: (
    write: WorkflowCheckpointWrite,
    stepId?: string,
  ) => void | Promise<void>;
  /**
   * Called once per coordinator, after `onWrite`, for the first saved
   * checkpoint that reaches 80% of the store's `maxCheckpointBytes`. Never
   * called for a store that does not expose the limit.
   */
  onSizeWarning?: (
    warning: WorkflowCheckpointSizeWarning,
  ) => void | Promise<void>;
}

/**
 * Step input hash and the resolution chosen from the checkpoint (for example
 * execute, replay or resume).
 *
 * @internal
 */
export interface PreparedWorkflowStep {
  /** Hash of the step input, or the legacy-form hash already stored for the step. */
  inputHash: string;
  /** What to do with the step: execute it, replay a stored result, or resume it. */
  resolution: WorkflowStepResolution;
}

/**
 * Owns the in-memory checkpoint for one workflow invocation.
 *
 * Mutations are serialized so parallel steps always persist a snapshot that
 * contains every preceding transition. The coordinator never mutates ADK
 * session state; persistence is surfaced through the store's state delta.
 *
 * @internal
 */
export class WorkflowCheckpointCoordinator {
  readonly #config: WorkflowCheckpointCoordinatorConfig;
  #checkpoint?: WorkflowCheckpointV1;
  #revision: WorkflowCheckpointRevision | null | undefined;
  #tail: Promise<void> = Promise.resolve();
  #sizeWarned = false;
  /** Model and fingerprint to write each time a step is saved `running` or `waiting` this turn. */
  readonly #stepRecords = new Map<string, WorkflowCheckpointStepRecordV1>();

  constructor(config: WorkflowCheckpointCoordinatorConfig) {
    this.#config = config;
  }

  /**
   * Loads the saved checkpoint, or creates and persists a new one.
   *
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the
   * store returns an invalid checkpoint; a saved checkpoint that does not match
   * the definition, execution id or input is rejected by validation.
   */
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

  /**
   * Whether the stored run is still unresolved and waiting for input: its
   * checkpoint is `running` (not completed, failed or cancelled), has a
   * `waiting` step and belongs to the current workflow version.
   */
  static async isWaiting(
    store: WorkflowCheckpointStore,
    context: InvocationContext,
    definition: Pick<WorkflowDefinition, "id" | "version">,
    executionId: string,
  ): Promise<boolean> {
    const saved = await store.load({
      context,
      workflowId: definition.id,
      executionId,
    });
    return (
      isWorkflowCheckpointV1(saved) &&
      saved.executionId === executionId &&
      saved.workflowVersion === definition.version &&
      saved.status === "running" &&
      Object.values(saved.steps).some((step) => step.status === "waiting")
    );
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

  /**
   * Hashes the step input and decides how the step proceeds; persists the step
   * as running when it will execute.
   *
   * @remarks
   * A step whose identity differs from the saved one throws
   * `WORKFLOW_STEP_MISMATCH`. For an input difference, the input hint is
   * delivered first (see `replay.onStepMismatch`), outside the checkpoint
   * lock, and never put in the error.
   *
   * @param step - Step about to run.
   * @param admit - Called with the resolution before anything is persisted; a
   * throw rejects the step and leaves the checkpoint unchanged.
   * @param currentModel - Model the step's agent requests now; without it no
   * model is compared or recorded.
   * @returns The input hash and the chosen resolution.
   */
  async prepareStep(
    step: WorkflowStep,
    admit?: (resolution: WorkflowStepResolution) => void,
    currentModel?: { requested?: string },
  ): Promise<PreparedWorkflowStep> {
    const canonical = workflowStepInputCanonicalForm(step.input);
    const currentHash = await sha256Digest(canonical);
    const replay = this.#config.replay;
    const outcome = await this.#exclusive(async () => {
      const checkpoint = this.checkpoint();
      // A step checkpointed before 0.7.0 keeps its legacy input hash.
      const inputHash = await resolveStoredDigest(
        checkpoint.steps[step.id]?.inputHash,
        currentHash,
        () => legacyDigest(step.input, "locale"),
      );
      const resolution = classifyWorkflowStep(checkpoint, step, inputHash, {
        retryFailed: this.#config.retryFailedSteps,
        answerTurn: this.#config.answerTurn,
        modelChange: replay?.modelChange,
        currentModel,
      });
      if (resolution.action === "mismatch") return resolution;
      admit?.(resolution);
      const record =
        resolution.action === "resume"
          ? savedRecord(checkpoint.steps[step.id])
          : await this.#newRecord(
              canonical,
              inputHash === currentHash,
              currentModel,
            );
      this.#stepRecords.set(step.id, record);
      if (resolution.action === "execute") {
        const candidate = withWorkflowStepRunning(
          checkpoint,
          step,
          inputHash,
          resolution.attempt,
          undefined,
          resolution.resumeReason,
          record,
        );
        await this.#persist(candidate, step.id);
      }
      return { inputHash, resolution };
    });
    if ("action" in outcome) {
      if (outcome.parts.includes("input")) {
        await this.#deliverInputHint(step.id, outcome.saved, canonical);
      }
      throw outcome.error;
    }
    return outcome;
  }

  async #newRecord(
    canonical: string,
    canonicalHash: boolean,
    currentModel: { requested?: string } | undefined,
  ): Promise<WorkflowCheckpointStepRecordV1> {
    const fingerprint =
      this.#fingerprintOn() && canonicalHash
        ? await fingerprintCanonicalInput(canonical)
        : undefined;
    return {
      ...(currentModel === undefined
        ? {}
        : {
            model:
              currentModel.requested === undefined
                ? {}
                : { requested: currentModel.requested },
          }),
      ...(fingerprint ?? {}),
    };
  }

  #fingerprintOn(): boolean {
    return this.#config.replay?.inputDigest !== false;
  }

  /**
   * Gives the host the input hint of a mismatch: to `onStepMismatch`, else to
   * a warn log. Never throws, and never changes the mismatch.
   */
  async #deliverInputHint(
    stepId: string,
    saved: WorkflowCheckpointStepV1,
    canonical: string,
  ): Promise<void> {
    let hint: WorkflowStepMismatchHint;
    try {
      hint = {
        stepId,
        diff: await diffCanonicalInput(
          {
            ...(saved.inputLength === undefined
              ? {}
              : { inputLength: saved.inputLength }),
            ...(saved.inputDigest === undefined
              ? {}
              : { inputDigest: saved.inputDigest }),
          },
          canonical,
          { enabled: this.#fingerprintOn() },
        ),
      };
    } catch {
      return;
    }
    const callback = this.#config.replay?.onStepMismatch;
    if (callback === undefined) {
      warn(LogCode.WORKFLOW_STEP_MISMATCH_HINT, describeHint(hint));
      return;
    }
    try {
      await callback(hint);
    } catch (caught) {
      warn(
        LogCode.WORKFLOW_STEP_MISMATCH_HINT,
        `replay.onStepMismatch failed for step "${stepId}": ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    }
  }

  /**
   * Persists the step as running for a new attempt.
   *
   * @param step - Step being retried.
   * @param inputHash - Hash returned by `prepareStep`.
   * @param attempt - Attempt number, starting at 1.
   * @param resumeReason - Why the attempt was entered; `retry` for an in-run retry.
   */
  async startAttempt(
    step: WorkflowStep,
    inputHash: string,
    attempt: number,
    resumeReason?: WorkflowStepResumeReason,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepRunning(
        this.checkpoint(),
        step,
        inputHash,
        attempt,
        undefined,
        resumeReason,
        this.#stepRecords.get(step.id),
      );
      await this.#persist(candidate, step.id);
    });
  }

  /** Persists the step result as completed. */
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
        undefined,
        this.#stepRecords.get(step.id),
      );
      await this.#persist(candidate, step.id);
    });
  }

  /**
   * Stores a recorded wait again when the checkpoint no longer shows the run as
   * `running` with its input, as after a run that failed past the wait. Writes
   * nothing when the checkpoint already shows it, so re-emitting a wait that
   * is still pending does not rewrite the store.
   */
  async restoreWaitingStep(
    step: WorkflowStep,
    inputHash: string,
    attempt: number,
    interrupt: WorkflowStepInterrupt,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const current = this.checkpoint();
      if (current.status === "running" && current.input !== undefined) return;
      const candidate = withWorkflowStepWaiting(
        current,
        step,
        inputHash,
        attempt,
        interrupt,
        this.#config.input,
        undefined,
        this.#stepRecords.get(step.id),
      );
      await this.#persist(candidate, step.id);
    });
  }

  /** Persists the step as failed. */
  async failStep(failure: WorkflowStepFailure): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowStepFailed(this.checkpoint(), failure);
      await this.#persist(candidate, failure.id);
    });
  }

  /**
   * Persists the workflow as completed.
   *
   * @param output - Final output, if any.
   */
  async completeWorkflow(output: string | Content | undefined): Promise<void> {
    await this.#exclusive(async () => {
      const candidate = withWorkflowCompleted(this.checkpoint(), output);
      await this.#persist(candidate);
    });
  }

  /**
   * Persists the workflow as failed or cancelled.
   *
   * @param error - Serialized error to record.
   * @param status - Terminal status to record.
   */
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
    let write: WorkflowCheckpointWrite;
    try {
      write = await this.#config.store.save({
        context: this.#config.context,
        checkpoint: durableCandidate,
        expectedRevision,
        revision,
      });
    } catch (caught) {
      if (isCheckpointSizeSaveError(caught)) {
        throw enrichCheckpointSizeError(caught, durableCandidate, stepId);
      }
      throw caught;
    }

    // A successful store write is the commit boundary. The notification hook
    // may fail, but it cannot roll back the durable checkpoint or its revision.
    this.#checkpoint = durableCandidate;
    this.#revision = revision;
    await this.#config.onWrite(write, stepId);
    await this.#warnOnSize(write.checkpointKey, durableCandidate, stepId);
  }

  async #warnOnSize(
    checkpointKey: string,
    checkpoint: WorkflowCheckpointV1,
    stepId: string | undefined,
  ): Promise<void> {
    const maxBytes = this.#config.store.maxCheckpointBytes;
    if (
      this.#sizeWarned ||
      !this.#config.onSizeWarning ||
      typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0
    ) {
      return;
    }
    const bytes = workflowCheckpointByteLength(checkpoint);
    if (!reachesCheckpointSizeWarning(bytes, maxBytes)) return;
    this.#sizeWarned = true;
    await this.#config.onSizeWarning({
      checkpointKey,
      ...(stepId === undefined ? {} : { stepId }),
      bytes,
      maxBytes,
      largestContributors: largestCheckpointContributors(checkpoint),
    });
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

/** The model and fingerprint fields a saved step already holds. */
function savedRecord(
  saved: WorkflowCheckpointStepV1 | undefined,
): WorkflowCheckpointStepRecordV1 {
  if (!saved) return {};
  return {
    ...(saved.model === undefined ? {} : { model: saved.model }),
    ...(saved.inputLength === undefined
      ? {}
      : { inputLength: saved.inputLength }),
    ...(saved.inputDigest === undefined
      ? {}
      : { inputDigest: saved.inputDigest }),
  };
}

/** One log line for an input hint: lengths, window and path; no input text. */
function describeHint(hint: WorkflowStepMismatchHint): string {
  const { diff } = hint;
  if (!diff.available) {
    return `step "${hint.stepId}": input changed, no window (${diff.reason})`;
  }
  const path = diff.path === undefined ? "" : `, path "${diff.path}"`;
  return `step "${hint.stepId}": input changed (saved length ${diff.savedLength}, current length ${diff.length}, first difference at [${diff.firstDifference.start}, ${diff.firstDifference.end})${path}); read it locally with workflowStepInputCanonicalForm()`;
}
