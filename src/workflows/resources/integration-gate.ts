import { isWorkflowIdentifier } from "../internal/identifiers.js";
import {
  optionalJsonObject,
  requiredResourceIdentity,
  snapshotJson,
  throwIfResourceAborted,
  type WorkflowResourceJsonObject,
  type WorkflowResourceJsonValue,
} from "./json.js";
import {
  type WorkflowArtifact,
  WorkflowArtifactIdentityError,
  type WorkflowArtifactReference,
  type WorkflowArtifactStore,
} from "./workflow-artifact-store.js";

/** Outcome of an integration gate: the artifact set is `accepted` or `rejected`. */
export type IntegrationGateVerdict = "accepted" | "rejected";

/** Request to validate an ordered set of artifacts. */
export interface IntegrationGateRequest {
  /** Gate identity (a safe 1-256 character resource identity). */
  gateId: string;
  /** Execution whose artifacts are validated; a record id. */
  executionId: string;
  /** Task the gate runs for. */
  taskId: string;
  /** Ordered, non-empty, duplicate-free artifact references pinned to exact revisions. */
  artifacts: readonly WorkflowArtifactReference[];
  /**
   * Extra JSON context passed to the driver.
   *
   * @defaultValue `{}`
   */
  context?: WorkflowResourceJsonObject;
}

/** Frozen input handed to an {@link IntegrationGateDriver}. */
export interface IntegrationGateDriverInput {
  /** Gate identity. */
  gateId: string;
  /** Owning execution. */
  executionId: string;
  /** Task the gate runs for. */
  taskId: string;
  /** Artifacts resolved from the references, in request order. */
  artifacts: readonly WorkflowArtifact[];
  /** Snapshot of the request context. */
  context: WorkflowResourceJsonObject;
}

/** What an {@link IntegrationGateDriver} returns. */
export interface IntegrationGateDriverResult {
  /** Accept or reject decision. */
  verdict: IntegrationGateVerdict;
  /** JSON-safe details supporting the verdict; snapshotted before it is returned. */
  result: WorkflowResourceJsonValue;
}

/**
 * Read-only validation port. Drivers must not mutate or integrate resources;
 * any later external mutation requires a separate, explicit host capability.
 */
export interface IntegrationGateDriver {
  /**
   * Validates the artifacts and returns a verdict.
   *
   * @param input - Frozen gate input.
   * @param options - Carries the caller's abort signal.
   * @returns The verdict and supporting result.
   */
  validate(
    input: IntegrationGateDriverInput,
    options: { signal?: AbortSignal },
  ): Promise<IntegrationGateDriverResult>;
}

/** Frozen outcome of {@link IntegrationGate.validate}. */
export interface IntegrationGateResult extends IntegrationGateDriverResult {
  /** Gate identity. */
  gateId: string;
  /** Owning execution. */
  executionId: string;
  /** Task the gate ran for. */
  taskId: string;
  /** The validated references, normalized. */
  artifacts: readonly WorkflowArtifactReference[];
}

/**
 * Validates artifacts against an {@link IntegrationGateDriver} without mutating anything.
 *
 * @remarks
 * Artifacts are re-read from the request's execution at the pinned revision,
 * so a driver never sees stale or foreign content.
 */
export class IntegrationGate {
  readonly #artifacts: WorkflowArtifactStore;
  readonly #driver: IntegrationGateDriver;

  /**
   * Creates an integration gate.
   *
   * @param artifacts - Store the referenced artifacts are read from.
   * @param driver - Read-only validation driver.
   */
  constructor(artifacts: WorkflowArtifactStore, driver: IntegrationGateDriver) {
    this.#artifacts = artifacts;
    this.#driver = driver;
  }

  /**
   * Resolves the referenced artifacts and runs the driver over them.
   *
   * @param request - Gate request.
   * @param options - Optional abort signal.
   * @returns The frozen gate result.
   * @throws {@link WorkflowArtifactIdentityError} when the execution id is invalid.
   * @throws `TypeError` when another identity is unsafe, the artifact set is empty or duplicated, or the driver returns an invalid verdict.
   * @throws `Error` when an artifact is missing or belongs to another execution
   * (the same "not found" error for both), or has another revision.
   * @throws The signal's reason when `options.signal` aborts.
   */
  async validate(
    request: IntegrationGateRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<IntegrationGateResult> {
    throwIfResourceAborted(options.signal);
    const normalized = normalizeGateRequest(request);
    const artifacts: WorkflowArtifact[] = [];
    for (const reference of normalized.artifacts) {
      throwIfResourceAborted(options.signal);
      const artifact = await this.#artifacts.get({
        executionId: normalized.executionId,
        artifactId: reference.artifactId,
        signal: options.signal,
      });
      // A store that returns another execution's artifact (one that ignores
      // the execution id) fails exactly like a missing one, before the
      // revision is compared, so the gate reveals neither.
      if (!artifact || artifact.executionId !== normalized.executionId) {
        throw new Error(
          `Integration artifact was not found in this execution: ${reference.artifactId}`,
        );
      }
      if (artifact.revision !== reference.revision) {
        throw new Error(
          `Integration artifact revision does not match: ${reference.artifactId}`,
        );
      }
      artifacts.push(artifact);
    }
    const driverInput: IntegrationGateDriverInput = Object.freeze({
      gateId: normalized.gateId,
      executionId: normalized.executionId,
      taskId: normalized.taskId,
      artifacts: Object.freeze(artifacts),
      context: normalized.context,
    });
    const driverResult = await awaitWithAbort(
      this.#driver.validate(driverInput, { signal: options.signal }),
      options.signal,
    );
    throwIfResourceAborted(options.signal);
    if (
      !driverResult ||
      (driverResult.verdict !== "accepted" &&
        driverResult.verdict !== "rejected")
    ) {
      throw new TypeError(
        "Integration gate driver returned an invalid verdict",
      );
    }
    const result = snapshotJson(driverResult.result, "integration result");
    return Object.freeze({
      gateId: normalized.gateId,
      executionId: normalized.executionId,
      taskId: normalized.taskId,
      artifacts: normalized.artifacts,
      verdict: driverResult.verdict,
      result,
    });
  }
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfResourceAborted(signal);
  if (!signal) return operation;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(signal.reason ?? new Error("Integration gate aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

function normalizeGateRequest(request: IntegrationGateRequest): {
  gateId: string;
  executionId: string;
  taskId: string;
  artifacts: readonly WorkflowArtifactReference[];
  context: WorkflowResourceJsonObject;
} {
  if (!isWorkflowIdentifier(request.executionId, "record")) {
    throw new WorkflowArtifactIdentityError("executionId");
  }
  if (!Array.isArray(request.artifacts) || request.artifacts.length === 0) {
    throw new TypeError("Integration gate requires an ordered artifact set");
  }
  const seen = new Set<string>();
  const artifacts = request.artifacts.map((reference) => {
    const artifactId = requiredResourceIdentity(
      reference.artifactId,
      "artifactId",
    );
    if (seen.has(artifactId)) {
      throw new TypeError(`Integration artifact is duplicated: ${artifactId}`);
    }
    seen.add(artifactId);
    return Object.freeze({
      artifactId,
      revision: requiredResourceIdentity(reference.revision, "revision"),
    });
  });
  return Object.freeze({
    gateId: requiredResourceIdentity(request.gateId, "gateId"),
    executionId: request.executionId,
    taskId: requiredResourceIdentity(request.taskId, "taskId"),
    artifacts: Object.freeze(artifacts),
    context: optionalJsonObject(request.context, "integration context"),
  });
}
