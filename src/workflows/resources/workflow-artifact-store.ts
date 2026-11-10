import {
  CANONICAL_DIGEST_PREFIX,
  canonicalDigest,
  legacyDigest,
  sha256Digest,
} from "../internal/canonical-hash.js";
import { isWorkflowIdentifier } from "../internal/identifiers.js";
import { portablePathProblem } from "../internal/portable-path.js";
import {
  optionalJsonObject,
  requiredResourceIdentity,
  snapshotJson,
  throwIfResourceAborted,
  type WorkflowResourceJsonObject,
  type WorkflowResourceJsonValue,
} from "./json.js";

const DEFAULT_LIST_LIMIT = 50;
/**
 * Largest accepted page size for artifact listings.
 *
 * @internal
 */
export const MAX_WORKFLOW_ARTIFACT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = MAX_WORKFLOW_ARTIFACT_LIST_LIMIT;

/**
 * Identifies one artifact: artifact ids are unique within an execution, so
 * the same `artifactId` in two executions names two different artifacts.
 */
export interface WorkflowArtifactKey {
  /** Execution that owns the artifact; a record id. */
  executionId: string;
  /** Artifact identity within the execution; an opaque id. */
  artifactId: string;
}

/** Artifact to store. */
export interface WorkflowArtifactInput {
  /** Artifact identity, unique within its execution. */
  artifactId: string;
  /** Execution that produced and owns the artifact; a record id. */
  executionId: string;
  /** Task that produced the artifact. */
  taskId: string;
  /** Application-defined artifact type. */
  type: string;
  /** JSON-safe content; snapshotted on put. */
  content: WorkflowResourceJsonValue;
  /**
   * JSON-safe metadata.
   *
   * @defaultValue `{}`
   */
  metadata?: WorkflowResourceJsonObject;
}

/** Stored artifact with its content digest and revision. */
export interface WorkflowArtifact {
  /** Artifact identity. */
  artifactId: string;
  /** Execution that produced the artifact. */
  executionId: string;
  /** Task that produced the artifact. */
  taskId: string;
  /** Application-defined artifact type. */
  type: string;
  /** Frozen content snapshot. */
  content: WorkflowResourceJsonValue;
  /** Frozen metadata snapshot. */
  metadata: WorkflowResourceJsonObject;
  /** Canonical digest of `content`. */
  contentDigest: string;
  /** Canonical digest of all fields; identifies exactly this immutable artifact. */
  revision: string;
}

/** Pins an artifact to one exact revision. */
export interface WorkflowArtifactReference {
  /** Artifact identity. */
  artifactId: string;
  /** Revision the artifact must have. */
  revision: string;
}

/** Result of {@link WorkflowArtifactStore.put}. */
export interface WorkflowArtifactPutResult {
  /** The stored artifact. */
  artifact: WorkflowArtifact;
  /** `false` when an identical artifact already existed. */
  created: boolean;
}

/** Input to {@link WorkflowArtifactStore.get}. */
export interface WorkflowArtifactGetInput extends WorkflowArtifactKey {
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/** Filters and paging for {@link WorkflowArtifactStore.list}. */
export interface WorkflowArtifactListInput {
  /** Execution whose artifacts are listed. */
  executionId: string;
  /** Only artifacts of this task. */
  taskId?: string;
  /** Only artifacts of this type. */
  type?: string;
  /** `nextCursor` of a previous page; the page starts after that artifact of the same execution. */
  cursor?: string;
  /**
   * Page size, from 1 to 200.
   *
   * @defaultValue `50`
   */
  limit?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

/** One page of artifacts. */
export interface WorkflowArtifactListResult {
  /** Artifacts on this page, in insertion order. */
  artifacts: readonly WorkflowArtifact[];
  /** Cursor for the next page; `undefined` on the last page. */
  nextCursor?: string;
}

/**
 * Immutable, write-once store for workflow artifacts, keyed by execution.
 *
 * @remarks
 * Every method takes the execution id with the artifact id. An artifact is
 * stored under `(executionId, artifactId)`: the same artifact id in another
 * execution is a different artifact, never a conflict, and a read for one
 * execution never returns another execution's artifact. Implementations
 * reject a missing or invalid execution id with
 * {@link WorkflowArtifactIdentityError} before reading or writing anything.
 */
export interface WorkflowArtifactStore {
  /**
   * Stores an artifact; re-putting an identical artifact is a no-op.
   *
   * @param input - Artifact to store.
   * @param options - Optional abort signal.
   * @returns The stored artifact and whether it was newly created.
   * @throws {@link WorkflowArtifactConflictError} when a different artifact already uses the id in the same execution.
   * @throws {@link WorkflowArtifactIdentityError} when the execution or artifact id is invalid.
   */
  put(
    input: WorkflowArtifactInput,
    options?: { signal?: AbortSignal },
  ): Promise<WorkflowArtifactPutResult>;
  /**
   * Reads one execution's artifact by id.
   *
   * @param input - Execution id, artifact id and optional signal.
   * @returns The artifact, or `undefined` when the execution holds no artifact with that id.
   * @throws {@link WorkflowArtifactIdentityError} when the execution or artifact id is invalid.
   */
  get(input: WorkflowArtifactGetInput): Promise<WorkflowArtifact | undefined>;
  /**
   * Lists one execution's artifacts matching the filters, one page at a time.
   *
   * @param input - Execution id, filters, cursor and limit.
   * @returns A page of artifacts.
   * @throws {@link WorkflowArtifactIdentityError} when the execution id is invalid.
   */
  list(input: WorkflowArtifactListInput): Promise<WorkflowArtifactListResult>;
}

/** Field of a {@link WorkflowArtifactKey} rejected by {@link WorkflowArtifactIdentityError}. */
export type WorkflowArtifactIdentityField = keyof WorkflowArtifactKey;

/**
 * Thrown when an artifact key is missing or invalid: the execution id must be
 * a record id and the artifact id an opaque id.
 *
 * @remarks
 * Extends `TypeError`, so code that caught the earlier `TypeError` keeps
 * working; match {@link WorkflowArtifactIdentityError.code} to tell it apart.
 */
export class WorkflowArtifactIdentityError extends TypeError {
  /** Machine-readable error code. */
  readonly code = "WORKFLOW_ARTIFACT_IDENTITY_INVALID";
  /** Field that was rejected. */
  readonly field: WorkflowArtifactIdentityField;

  /**
   * Creates the error for a rejected identity field.
   *
   * @param field - Field that was rejected.
   */
  constructor(field: WorkflowArtifactIdentityField) {
    super(
      field === "executionId"
        ? "executionId must be a 1-256 character workflow record id"
        : "artifactId must be a safe 1-256 character resource identity",
    );
    this.name = "WorkflowArtifactIdentityError";
    this.field = field;
  }
}

/**
 * Validates an artifact key.
 *
 * @param key - Candidate key.
 * @returns A key with exactly the two validated ids.
 * @throws {@link WorkflowArtifactIdentityError} when an id is missing or invalid.
 */
function artifactKey(key: WorkflowArtifactKey): WorkflowArtifactKey {
  if (!isWorkflowIdentifier(key?.executionId, "record")) {
    throw new WorkflowArtifactIdentityError("executionId");
  }
  if (!isWorkflowIdentifier(key.artifactId, "opaque")) {
    throw new WorkflowArtifactIdentityError("artifactId");
  }
  return { executionId: key.executionId, artifactId: key.artifactId };
}

/** Longest file name most file systems accept (APFS, ext4, NTFS), in bytes. */
const MAX_PATH_SEGMENT_LENGTH = 255;

/**
 * Returns the relative path where a durable store keeps one artifact:
 * `<executionId>/<artifactId>`, one directory per execution.
 *
 * @remarks
 * Each id becomes exactly one segment: every character other than a lowercase
 * letter, a digit, `.`, `_` or `-` is written as `%` and two uppercase hex
 * digits. So `/` never splits an id, no segment is `.` or `..` or starts with
 * a drive prefix, and two keys never share a path, even on a case-insensitive
 * file system.
 *
 * A segment never exceeds 255 characters, the file name limit of most file
 * systems. When the escaped id is longer, the segment is `~` followed by the
 * lowercase SHA-256 hex digest of the id instead. No escaped segment contains
 * `~`, so the two forms never collide. The result is a canonical portable
 * path whose last segment is the complete file name: join it under the
 * store's own root and do not append an extension, because a segment can
 * already be 255 characters long. Keep a content type or other metadata
 * inside the file or beside it, or use the segment as a directory and put
 * fixed, short file names inside. Windows device names such as `nul` are
 * outside its scope, as in the portable path grammar.
 *
 * @param key - Execution and artifact ids.
 * @returns The relative path of the artifact.
 * @throws {@link WorkflowArtifactIdentityError} when an id is missing or invalid.
 */
export async function workflowArtifactStoragePath(
  key: WorkflowArtifactKey,
): Promise<string> {
  const { executionId, artifactId } = artifactKey(key);
  const path = `${await pathSegment(executionId)}/${await pathSegment(artifactId)}`;
  const problem = portablePathProblem(path, { canonical: true });
  if (problem !== undefined) {
    throw new TypeError(`Workflow artifact path is not portable: ${problem}`);
  }
  return path;
}

async function pathSegment(id: string): Promise<string> {
  const escaped = id.replace(
    /[^a-z0-9._-]/gu,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  if (escaped.length <= MAX_PATH_SEGMENT_LENGTH) return escaped;
  return `~${(await sha256Digest(id)).slice(CANONICAL_DIGEST_PREFIX.length)}`;
}

/** Thrown when an artifact id is reused with different content in the same execution, because artifacts are immutable. */
export class WorkflowArtifactConflictError extends Error {
  /** Id that already exists. */
  readonly artifactId: string;
  /** Revision of the stored artifact. */
  readonly existingRevision: string;
  /** Revision of the rejected artifact. */
  readonly attemptedRevision: string;

  /**
   * Creates the error for an artifact id that already exists in the execution with a different revision.
   *
   * @param artifactId - Id that already exists.
   * @param existingRevision - Revision of the stored artifact.
   * @param attemptedRevision - Revision of the rejected artifact.
   */
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

/** Immutable process-local artifact store, keyed by execution, for tests and development. */
export class InMemoryWorkflowArtifactStore implements WorkflowArtifactStore {
  /** Artifacts by execution id, then by artifact id, in insertion order. */
  readonly #executions = new Map<string, Map<string, WorkflowArtifact>>();

  /**
   * Stores an artifact; re-putting an identical artifact returns the existing one.
   *
   * @param input - Artifact to store.
   * @param options - Optional abort signal.
   * @returns The stored artifact and whether it was newly created.
   * @throws {@link WorkflowArtifactConflictError} when a different artifact already uses the id in the same execution.
   * @throws {@link WorkflowArtifactIdentityError} when the execution or artifact id is invalid.
   * @throws `TypeError` when another identity or the JSON content is unsafe.
   */
  async put(
    input: WorkflowArtifactInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<WorkflowArtifactPutResult> {
    throwIfResourceAborted(options.signal);
    const artifact = await normalizeArtifact(input);
    let artifacts = this.#executions.get(artifact.executionId);
    const existing = artifacts?.get(artifact.artifactId);
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
    if (artifacts === undefined) {
      artifacts = new Map();
      this.#executions.set(artifact.executionId, artifacts);
    }
    artifacts.set(artifact.artifactId, artifact);
    return Object.freeze({ artifact, created: true });
  }

  /**
   * Reads one execution's artifact by id.
   *
   * @param input - Execution id, artifact id and optional signal.
   * @returns The artifact, or `undefined` when the execution holds no artifact with that id.
   * @throws {@link WorkflowArtifactIdentityError} when the execution or artifact id is invalid.
   */
  async get(
    input: WorkflowArtifactGetInput,
  ): Promise<WorkflowArtifact | undefined> {
    throwIfResourceAborted(input?.signal);
    const { executionId, artifactId } = artifactKey(input);
    return this.#executions.get(executionId)?.get(artifactId);
  }

  /**
   * Lists one execution's artifacts in insertion order with cursor paging.
   *
   * @param input - Execution id, filters, cursor and limit.
   * @returns A page of artifacts.
   * @throws {@link WorkflowArtifactIdentityError} when the execution id is invalid.
   * @throws `TypeError` when a filter is unsafe, `limit` is outside 1-200, or `cursor` is not in the filtered set.
   */
  async list(
    input: WorkflowArtifactListInput,
  ): Promise<WorkflowArtifactListResult> {
    throwIfResourceAborted(input?.signal);
    if (!isWorkflowIdentifier(input?.executionId, "record")) {
      throw new WorkflowArtifactIdentityError("executionId");
    }
    const executionId = input.executionId;
    const taskId = optionalIdentity(input.taskId, "taskId");
    const type = optionalIdentity(input.type, "type");
    const cursor = optionalIdentity(input.cursor, "cursor");
    const limit = listLimit(input.limit);
    const filtered = [
      ...(this.#executions.get(executionId)?.values() ?? []),
    ].filter(
      (artifact) =>
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
  const key = artifactKey(input);
  const normalized = {
    artifactId: key.artifactId,
    executionId: key.executionId,
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
 * Tells whether `revision` is the revision of `artifact`'s fields.
 *
 * @remarks
 * Accepts the canonical digest and the insertion-order digest written by
 * 0.7.0 pre-release builds (no earlier release wrote artifacts), so durable stores can accept artifacts they already hold.
 *
 * @param artifact - Artifact whose fields are digested.
 * @param revision - Revision read from storage.
 * @returns `true` when `revision` matches either form.
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
