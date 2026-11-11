import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { InvocationContext } from "@google/adk";
import {
  FileSystemWorkflowCheckpointStore,
  type FileSystemWorkflowCheckpointStoreOptions,
} from "../checkpoint/file-system-checkpoint-store.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
  type WorkflowCheckpointV1,
} from "../checkpoint/schema.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  type WorkflowCheckpointLocator,
  workflowCheckpointByteLength,
  workflowCheckpointKey,
  workflowCheckpointRevision,
  workflowCheckpointRevisionMatches,
} from "../checkpoint/store.js";
import { WorkflowError } from "../contracts.js";
import {
  BaseWorkflowCheckpointStore,
  type BaseWorkflowCheckpointStoreOptions,
  type ListWorkflowCheckpointsInput,
  type ListWorkflowCheckpointsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointSummary,
  type WorkflowCheckpointWriteRequest,
} from "./checkpoint-store.js";
import { WorkflowStorageError } from "./errors.js";

// The file-system store never reads the invocation context; the provider has
// none because `get` and `put` are context-free.
const NO_CONTEXT = undefined as unknown as InvocationContext;
const SHARD_NAME = /^[a-f0-9]{2}$/u;
const CHECKPOINT_FILE_NAME = /^([a-f0-9]{64})\.json$/u;
const FILE_FORMAT = "adk-llm-bridge/workflow-checkpoint-file";
const MAX_CURSOR_LENGTH = 8192;
// Room for the file envelope around a checkpoint at the size limit.
const ENVELOPE_ALLOWANCE_BYTES = 4096;
// On Windows a rename onto a file another process has open fails with one of
// these codes until that process closes it, which takes milliseconds.
// TEMPORARY: remove when FS-RENAME-RETRY-1 merges. The core store publishes a
// checkpoint with a plain rename (file-system-checkpoint-store.ts), which
// Windows refuses while another handle holds the file open; until the core
// store retries that rename, this provider retries the whole save on win32.
const WINDOWS_BLOCKED_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const WINDOWS_RETRY_BUDGET_MS = 5000;
const WINDOWS_RETRY_MAX_DELAY_MS = 100;

/**
 * Options of {@link FileSystemWorkflowCheckpointProvider}: those of
 * `FileSystemWorkflowCheckpointStore` plus the shared provider options.
 *
 * @experimental
 */
export interface FileSystemWorkflowCheckpointProviderOptions
  extends FileSystemWorkflowCheckpointStoreOptions,
    Omit<BaseWorkflowCheckpointStoreOptions, "maxCheckpointBytes"> {}

/**
 * The file-system checkpoint store behind the provider contract. URI:
 * `file:///absolute/root`.
 *
 * @remarks
 * Reads and writes go through one `FileSystemWorkflowCheckpointStore`, so the
 * files, the directory lock and every error are exactly those of that store;
 * a root written by either class is readable by the other. The provider adds
 * the context-free `get` and `put`, `list` (a read-only scan of the root),
 * the health check and metrics.
 *
 * The `updatedAt` of a read is the modification time of the checkpoint file,
 * read just after the checkpoint; when another process saves in between it can
 * belong to the newer write, while the revision always matches the checkpoint.
 *
 * Capabilities: `compareAndSet: "atomic"`, `durable: true`,
 * `multiProcess: true` (one host, one local file system), `listing: true`,
 * `leases: false` and `pruning: false`. Leases and deletes need the
 * directory lock of the store, which this release does not expose.
 *
 * @experimental
 */
export class FileSystemWorkflowCheckpointProvider extends BaseWorkflowCheckpointStore {
  /** Provider name: `file`. */
  readonly providerName = "file";
  /** Atomic compare-and-set and listing; no leases, no pruning. */
  readonly capabilities: WorkflowCheckpointStoreCapabilities;

  readonly #store: FileSystemWorkflowCheckpointStore;
  readonly #root: string;
  readonly #maxBytes: number;

  /**
   * Creates the provider over a checkpoint root.
   *
   * @param options - Root directory, lock timing and the shared provider
   * options.
   * @throws `WorkflowError` with code `WORKFLOW_DEFINITION_INVALID` when
   * `root` is not absolute or a numeric option is not a positive integer.
   */
  constructor(options: FileSystemWorkflowCheckpointProviderOptions) {
    super(options);
    const { operationTimeoutMs, retry, onOperation, ...storeOptions } = options;
    void operationTimeoutMs;
    void retry;
    void onOperation;
    this.#store = new FileSystemWorkflowCheckpointStore(storeOptions);
    this.#root = resolve(options.root);
    this.#maxBytes =
      options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES;
    this.capabilities = Object.freeze({
      compareAndSet: "atomic",
      leases: false,
      durable: true,
      multiProcess: true,
      listing: true,
      pruning: false,
      maxCheckpointBytes: this.#maxBytes,
    });
  }

  protected async readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    await this.#refuseLinkedRoot();
    const checkpoint = await this.#store.load({
      workflowId: locator.workflowId,
      executionId: locator.executionId,
      context: NO_CONTEXT,
    });
    if (checkpoint === undefined) return undefined;
    return {
      checkpoint,
      revision: await workflowCheckpointRevision(checkpoint),
      updatedAt: await this.#modifiedAt(locator),
    };
  }

  protected async writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    await this.#refuseLinkedRoot();
    const deadline = Date.now() + WINDOWS_RETRY_BUDGET_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#store.save({
          context: NO_CONTEXT,
          checkpoint: request.checkpoint,
          revision: request.revision,
          ...(request.expectedRevision === undefined
            ? {}
            : { expectedRevision: request.expectedRevision }),
        });
        break;
      } catch (error) {
        // A failed write left the file as it was and released the lock, so
        // running the save again re-checks the expected revision.
        if (!isBlockedWindowsRename(error) || Date.now() >= deadline) {
          throw error;
        }
        await delay(Math.min(5 * 2 ** attempt, WINDOWS_RETRY_MAX_DELAY_MS));
      }
    }
    return await this.#modifiedAt(request);
  }

  protected override async listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    await this.#refuseLinkedRoot();
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    // Only the first `limit + 1` rows after the cursor are kept while the
    // root is scanned, so memory does not grow with the number of files.
    let kept: WorkflowCheckpointSummary[] = [];
    for (const shard of await this.#readDirectory(this.#root)) {
      if (!SHARD_NAME.test(shard.name) || !shard.isDirectory()) continue;
      const shardPath = join(this.#root, shard.name);
      for (const file of await this.#readDirectory(shardPath)) {
        const match = CHECKPOINT_FILE_NAME.exec(file.name);
        if (!match?.[1] || !file.isFile()) continue;
        const summary = await this.#summarize(
          join(shardPath, file.name),
          match[1],
        );
        if (!summary) continue;
        if (
          (input.workflowId !== undefined &&
            summary.workflowId !== input.workflowId) ||
          (input.status !== undefined && summary.status !== input.status) ||
          (input.updatedBefore !== undefined &&
            summary.updatedAt >= input.updatedBefore) ||
          (after !== undefined && compareRows(summary, after) <= 0)
        ) {
          continue;
        }
        kept.push(summary);
        if (kept.length > 2 * (input.limit + 1)) {
          kept = kept.sort(compareRows).slice(0, input.limit + 1);
        }
      }
    }
    kept.sort(compareRows);
    const items = kept.slice(0, input.limit);
    const last = items[items.length - 1];
    return kept.length > items.length && last
      ? { items, nextCursor: encodeCursor(last) }
      : { items };
  }

  protected override async checkHealth(): Promise<undefined> {
    let target = this.#root;
    for (;;) {
      try {
        const info = await stat(target);
        if (!info.isDirectory()) {
          throw new WorkflowStorageError(
            "WORKFLOW_STORAGE_UNAVAILABLE",
            "The checkpoint root is not a directory",
            { retryable: false },
          );
        }
        // The first save creates a missing root, so the nearest existing
        // directory must be writable; an existing root must also be readable.
        await access(
          target,
          target === this.#root
            ? constants.R_OK | constants.W_OK | constants.X_OK
            : constants.W_OK | constants.X_OK,
        );
        return undefined;
      } catch (error) {
        if (error instanceof WorkflowStorageError) throw error;
        const parent = dirname(target);
        if (isMissing(error) && parent !== target) {
          target = parent;
          continue;
        }
        throw new WorkflowStorageError(
          "WORKFLOW_STORAGE_UNAVAILABLE",
          "The checkpoint root is not usable",
          { retryable: false, cause: error },
        );
      }
    }
  }

  /**
   * The root itself must not be a symbolic link: the store under it never
   * follows links, but a linked root would put every checkpoint wherever the
   * link points.
   */
  async #refuseLinkedRoot(): Promise<void> {
    const info = await lstat(this.#root).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNSAFE_PATH",
        "The checkpoint root is a symbolic link",
        { details: { provider: this.providerName } },
      );
    }
  }

  async #modifiedAt(locator: WorkflowCheckpointLocator): Promise<number> {
    try {
      const info = await lstat(this.#checkpointPath(locator));
      return Math.floor(info.mtimeMs);
    } catch {
      return this.currentTime();
    }
  }

  #checkpointPath(locator: WorkflowCheckpointLocator): string {
    const digest = digestOf(
      workflowCheckpointKey(locator.workflowId, locator.executionId),
    );
    return join(this.#root, digest.slice(0, 2), `${digest}.json`);
  }

  async #readDirectory(path: string) {
    try {
      return await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNAVAILABLE",
        "The checkpoint root could not be listed",
        { cause: error },
      );
    }
  }

  // Reads one file without following a symlink. A file that is not a valid
  // checkpoint envelope of this layout is not a row; `load` still reports it.
  async #summarize(
    path: string,
    digest: string,
  ): Promise<WorkflowCheckpointSummary | undefined> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
    } catch {
      return undefined;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > this.#maxBytes + ENVELOPE_ALLOWANCE_BYTES
      ) {
        return undefined;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch {
        return undefined;
      }
      if (!isEnvelope(parsed)) return undefined;
      const key = workflowCheckpointKey(
        parsed.checkpoint.workflowId,
        parsed.checkpoint.executionId,
      );
      if (parsed.checkpointKey !== key || digestOf(key) !== digest) {
        return undefined;
      }
      if (
        !(await workflowCheckpointRevisionMatches(
          parsed.checkpoint,
          parsed.revision,
        ))
      ) {
        return undefined;
      }
      const durable = toDurableWorkflowCheckpoint(parsed.checkpoint);
      return {
        workflowId: durable.workflowId,
        executionId: durable.executionId,
        revision: await workflowCheckpointRevision(durable),
        status: durable.status,
        updatedAt: Math.floor(info.mtimeMs),
        bytes: workflowCheckpointByteLength(durable),
      };
    } catch {
      return undefined;
    } finally {
      await handle.close().catch(() => {});
    }
  }
}

function isBlockedWindowsRename(error: unknown): boolean {
  if (process.platform !== "win32" || !(error instanceof WorkflowError)) {
    return false;
  }
  const { reason, causeCode } = error.details ?? {};
  return (
    reason === "checkpoint_write_failed" &&
    typeof causeCode === "string" &&
    WINDOWS_BLOCKED_RENAME_CODES.has(causeCode)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function digestOf(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function isEnvelope(value: unknown): value is {
  checkpointKey: string;
  revision: string;
  checkpoint: WorkflowCheckpointV1;
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.format === FILE_FORMAT &&
    record.formatVersion === 1 &&
    typeof record.checkpointKey === "string" &&
    typeof record.revision === "string" &&
    isWorkflowCheckpointV1(record.checkpoint)
  );
}

function compareRows(
  a: { workflowId: string; executionId: string },
  b: { workflowId: string; executionId: string },
): number {
  if (a.workflowId !== b.workflowId) {
    return a.workflowId < b.workflowId ? -1 : 1;
  }
  if (a.executionId !== b.executionId) {
    return a.executionId < b.executionId ? -1 : 1;
  }
  return 0;
}

function encodeCursor(row: {
  workflowId: string;
  executionId: string;
}): string {
  return Buffer.from(
    JSON.stringify([row.workflowId, row.executionId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  workflowId: string;
  executionId: string;
} {
  const invalid = () =>
    new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_OPTION",
      "cursor is not a cursor this provider returned",
      { details: { option: "cursor" } },
    );
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { workflowId: parsed[0], executionId: parsed[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw invalid();
}
