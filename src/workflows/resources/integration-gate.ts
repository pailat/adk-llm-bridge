/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import {
  optionalJsonObject,
  requiredResourceIdentity,
  snapshotJson,
  throwIfResourceAborted,
  type WorkflowResourceJsonObject,
  type WorkflowResourceJsonValue,
} from "./json.js";
import type {
  WorkflowArtifact,
  WorkflowArtifactReference,
  WorkflowArtifactStore,
} from "./workflow-artifact-store.js";

export type IntegrationGateVerdict = "accepted" | "rejected";

export interface IntegrationGateRequest {
  gateId: string;
  executionId: string;
  taskId: string;
  artifacts: readonly WorkflowArtifactReference[];
  context?: WorkflowResourceJsonObject;
}

export interface IntegrationGateDriverInput {
  gateId: string;
  executionId: string;
  taskId: string;
  artifacts: readonly WorkflowArtifact[];
  context: WorkflowResourceJsonObject;
}

export interface IntegrationGateDriverResult {
  verdict: IntegrationGateVerdict;
  result: WorkflowResourceJsonValue;
}

/**
 * Read-only validation port. Drivers must not mutate or integrate resources;
 * any later external mutation requires a separate, explicit host capability.
 */
export interface IntegrationGateDriver {
  validate(
    input: IntegrationGateDriverInput,
    options: { signal?: AbortSignal },
  ): Promise<IntegrationGateDriverResult>;
}

export interface IntegrationGateResult extends IntegrationGateDriverResult {
  gateId: string;
  executionId: string;
  taskId: string;
  artifacts: readonly WorkflowArtifactReference[];
}

export class IntegrationGate {
  readonly #artifacts: WorkflowArtifactStore;
  readonly #driver: IntegrationGateDriver;

  constructor(artifacts: WorkflowArtifactStore, driver: IntegrationGateDriver) {
    this.#artifacts = artifacts;
    this.#driver = driver;
  }

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
        artifactId: reference.artifactId,
        signal: options.signal,
      });
      if (!artifact) {
        throw new Error(
          `Integration artifact was not found: ${reference.artifactId}`,
        );
      }
      if (artifact.revision !== reference.revision) {
        throw new Error(
          `Integration artifact revision does not match: ${reference.artifactId}`,
        );
      }
      if (artifact.executionId !== normalized.executionId) {
        throw new Error(
          `Integration artifact belongs to another execution: ${reference.artifactId}`,
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
    executionId: requiredResourceIdentity(request.executionId, "executionId"),
    taskId: requiredResourceIdentity(request.taskId, "taskId"),
    artifacts: Object.freeze(artifacts),
    context: optionalJsonObject(request.context, "integration context"),
  });
}
