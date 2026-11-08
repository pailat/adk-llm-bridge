/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { canonicalDigest, legacyDigest } from "../internal/canonical-hash.js";
import {
  optionalJsonObject,
  requiredResourceIdentity,
  snapshotJson,
  throwIfResourceAborted,
  type WorkflowResourceJsonObject,
  type WorkflowResourceJsonValue,
} from "./json.js";

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export interface WorkflowArtifactInput {
  artifactId: string;
  executionId: string;
  taskId: string;
  type: string;
  content: WorkflowResourceJsonValue;
  metadata?: WorkflowResourceJsonObject;
}

export interface WorkflowArtifact {
  artifactId: string;
  executionId: string;
  taskId: string;
  type: string;
  content: WorkflowResourceJsonValue;
  metadata: WorkflowResourceJsonObject;
  contentDigest: string;
  revision: string;
}

export interface WorkflowArtifactReference {
  artifactId: string;
  revision: string;
}

export interface WorkflowArtifactPutResult {
  artifact: WorkflowArtifact;
  created: boolean;
}

export interface WorkflowArtifactGetInput {
  artifactId: string;
  signal?: AbortSignal;
}

export interface WorkflowArtifactListInput {
  executionId?: string;
  taskId?: string;
  type?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface WorkflowArtifactListResult {
  artifacts: readonly WorkflowArtifact[];
  nextCursor?: string;
}

export interface WorkflowArtifactStore {
  put(
    input: WorkflowArtifactInput,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowArtifactPutResult>;
  get(input: WorkflowArtifactGetInput): Promise<WorkflowArtifact | undefined>;
  list(input?: WorkflowArtifactListInput): Promise<WorkflowArtifactListResult>;
}

export class WorkflowArtifactConflictError extends Error {
  readonly artifactId: string;
  readonly existingRevision: string;
  readonly attemptedRevision: string;

  constructor(
    artifactId: string,
    existingRevision: string,
    attemptedRevision: string,
  ) {
    super(`Workflow artifact is immutable and already exists: ${artifactId}`);
    this.name = "WorkflowArtifactConflictError";
    this.artifactId = artifactId;
    this.existingRevision = existingRevision;
    this.attemptedRevision = attemptedRevision;
  }
}

/** Immutable process-local artifact store for tests and development. */
export class InMemoryWorkflowArtifactStore implements WorkflowArtifactStore {
  readonly #artifacts = new Map<string, WorkflowArtifact>();

  async put(
    input: WorkflowArtifactInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowArtifactPutResult> {
    throwIfResourceAborted(options.signal);
    const artifact = await normalizeArtifact(input);
    const existing = this.#artifacts.get(artifact.artifactId);
    if (existing) {
      if (
        !(await workflowArtifactRevisionMatches(artifact, existing.revision))
      ) {
        throw new WorkflowArtifactConflictError(
          artifact.artifactId,
          existing.revision,
          artifact.revision,
        );
      }
      return Object.freeze({ artifact: existing, created: false });
    }
    this.#artifacts.set(artifact.artifactId, artifact);
    return Object.freeze({ artifact, created: true });
  }

  async get(
    input: WorkflowArtifactGetInput,
  ): Promise<WorkflowArtifact | undefined> {
    throwIfResourceAborted(input.signal);
    return this.#artifacts.get(
      requiredResourceIdentity(input.artifactId, "artifactId"),
    );
  }

  async list(
    input: WorkflowArtifactListInput = {},
  ): Promise<WorkflowArtifactListResult> {
    throwIfResourceAborted(input.signal);
    const executionId = optionalIdentity(input.executionId, "executionId");
    const taskId = optionalIdentity(input.taskId, "taskId");
    const type = optionalIdentity(input.type, "type");
    const cursor = optionalIdentity(input.cursor, "cursor");
    const limit = listLimit(input.limit);
    const filtered = [...this.#artifacts.values()].filter(
      (artifact) =>
        (executionId === undefined || artifact.executionId === executionId) &&
        (taskId === undefined || artifact.taskId === taskId) &&
        (type === undefined || artifact.type === type),
    );
    let start = 0;
    if (cursor !== undefined) {
      const index = filtered.findIndex(
        (artifact) => artifact.artifactId === cursor,
      );
      if (index < 0) {
        throw new TypeError("Artifact list cursor is not in the filtered set");
      }
      start = index + 1;
    }
    const artifacts = Object.freeze(filtered.slice(start, start + limit));
    const last = artifacts.at(-1);
    const nextCursor =
      start + artifacts.length < filtered.length ? last?.artifactId : undefined;
    return Object.freeze({ artifacts, nextCursor });
  }
}

async function normalizeArtifact(
  input: WorkflowArtifactInput,
): Promise<WorkflowArtifact> {
  const normalized = {
    artifactId: requiredResourceIdentity(input.artifactId, "artifactId"),
    executionId: requiredResourceIdentity(input.executionId, "executionId"),
    taskId: requiredResourceIdentity(input.taskId, "taskId"),
    type: requiredResourceIdentity(input.type, "type"),
    content: snapshotJson(input.content, "content"),
    metadata: optionalJsonObject(input.metadata, "metadata"),
  };
  const contentDigest = await canonicalDigest(normalized.content);
  const revision = await canonicalDigest({ ...normalized, contentDigest });
  return Object.freeze({ ...normalized, contentDigest, revision });
}

/**
 * True when `revision` is the revision of `artifact`'s fields: the canonical
 * digest, or the pre-0.7.0 insertion-order digest of artifacts stored before
 * 0.7.0. Durable stores can use it to accept artifacts they already hold.
 */
export async function workflowArtifactRevisionMatches(
  artifact: WorkflowArtifact,
  revision: string,
): Promise<boolean> {
  const { contentDigest: _content, revision: _revision, ...fields } = artifact;
  const contentDigest = await canonicalDigest(fields.content);
  if (revision === (await canonicalDigest({ ...fields, contentDigest }))) {
    return true;
  }
  // Legacy form: JSON.stringify in this exact property order.
  const legacy = {
    artifactId: fields.artifactId,
    executionId: fields.executionId,
    taskId: fields.taskId,
    type: fields.type,
    content: fields.content,
    metadata: fields.metadata,
    contentDigest: await legacyDigest(fields.content, "insertion"),
  };
  return revision === (await legacyDigest(legacy, "insertion"));
}

function optionalIdentity(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined
    ? undefined
    : requiredResourceIdentity(value, field);
}

function listLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
    throw new TypeError(
      `Artifact list limit must be between 1 and ${MAX_LIST_LIMIT}`,
    );
  }
  return limit;
}
