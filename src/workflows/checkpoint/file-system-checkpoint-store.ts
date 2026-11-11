import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { warn } from "../../utils/log.js";
import { WorkflowError } from "../contracts.js";
import {
  DIRECTORY_LOCK_OWNER_FILE,
  type DirectoryLockOwner,
  directoryLockTokenKey,
  isRetireCollision,
  parseDirectoryLockOwner,
  retiredDirectoryLockPath,
} from "../internal/directory-lock.js";
import { fsyncDirectory } from "../internal/directory-sync.js";
import {
  attachCause,
  attachCleanupErrors,
  isProcessAlive,
} from "../internal/error-support.js";
import { hasErrorCode, isRecord } from "../internal/guards.js";
import { monotonicNow } from "../internal/monotonic-clock.js";
import type { WorkflowCheckpointV1 } from "./schema.js";
import {
  isWorkflowCheckpointV1,
  toDurableWorkflowCheckpoint,
} from "./schema.js";
import {
  assertWorkflowCheckpointSize,
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  type LoadWorkflowCheckpointInput,
  type SaveWorkflowCheckpointInput,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointFailureReason,
  type WorkflowCheckpointRevision,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite,
  workflowCheckpointKey,
  workflowCheckpointRevision,
  workflowCheckpointRevisionMatches,
  workflowCheckpointSizeLimitError,
} from "./store.js";

/**
 * Warning code logged when a save committed its checkpoint but could not
 * release the checkpoint lock afterwards.
 */
const CHECKPOINT_LOCK_RELEASE_FAILED =
  "WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED";
const FILE_FORMAT = "adk-llm-bridge/workflow-checkpoint-file";
const FILE_FORMAT_VERSION = 1;
const LOCK_OWNER_FILE = DIRECTORY_LOCK_OWNER_FILE;
const SAFE_CHECKPOINT_SHARD = /^[a-f0-9]{2}$/u;
const SAFE_CHECKPOINT_LOCK = /^[a-f0-9]{64}\.json\.lock$/u;
const SAFE_CHECKPOINT_CANDIDATE =
  /^\.[a-f0-9]{64}\.json\.lock\.candidate\.[1-9][0-9]*\.[A-Za-z0-9_-]{1,128}$/u;
const SAFE_CHECKPOINT_TOMBSTONE =
  /^[a-f0-9]{64}\.json\.lock\.retired\.([a-f0-9]{64})$/u;

/** Options for {@link FileSystemWorkflowCheckpointStore}. */
export interface FileSystemWorkflowCheckpointStoreOptions {
  /** Absolute host-controlled directory for checkpoint data and locks. */
  root: string;
  /**
   * Maximum time spent waiting for a live lock, in milliseconds.
   *
   * @defaultValue `10_000`
   */
  lockTimeoutMs?: number;
  /**
   * Delay between lock acquisition attempts, in milliseconds.
   *
   * @defaultValue `25`
   */
  lockRetryMs?: number;
  /** Optional lifetime signal for pending lock acquisition. */
  signal?: AbortSignal;
  /**
   * Maximum UTF-8 JSON size of one durable checkpoint.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES}
   */
  maxCheckpointBytes?: number;
}

/** Options for {@link collectFileSystemCheckpointTombstonesOffline}. */
export interface OfflineCheckpointTombstoneCollectionOptions {
  /** Absolute host-controlled checkpoint root. */
  root: string;
  /** Nominal acknowledgement that no store or writer is active. */
  confirmNoActiveWriters: true;
}

/** Result of {@link collectFileSystemCheckpointTombstonesOffline}. */
export interface OfflineCheckpointTombstoneCollectionResult {
  /** Number of retired lock tombstones removed. */
  removedTombstones: number;
}

interface CheckpointFileV1 {
  format: typeof FILE_FORMAT;
  formatVersion: typeof FILE_FORMAT_VERSION;
  checkpointKey: string;
  revision: WorkflowCheckpointRevision;
  checkpoint: WorkflowCheckpointV1;
}

type LockMetadata = DirectoryLockOwner;

interface HeldCheckpointLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface OfflineCheckpointTombstone {
  path: string;
  device: number;
  inode: number;
}

/**
 * OFFLINE ONLY: removes retired checkpoint-lock tombstones after proving that
 * the host-controlled tree has no lock or candidate.
 *
 * @remarks
 * This is not safe to run concurrently with stores or writers, and
 * intentionally has no age-based mode.
 *
 * @param options - Checkpoint root and the `confirmNoActiveWriters` acknowledgement.
 * @returns The number of tombstones removed.
 * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when the root or acknowledgement is invalid.
 * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` and `details.reason` `checkpoint_file_unsafe`
 * when the root is not a safe directory, or the tree contains a symlink, an active lock or candidate, an unsafe entry
 * or a malformed tombstone; nothing is removed in those cases. File-system errors of the scan are thrown as they are.
 */
export async function collectFileSystemCheckpointTombstonesOffline(
  options: OfflineCheckpointTombstoneCollectionOptions,
): Promise<OfflineCheckpointTombstoneCollectionResult> {
  const root = await checkpointOfflineRoot(options);
  const tombstones: OfflineCheckpointTombstone[] = [];
  await scanCheckpointOfflineTree(root, root, tombstones);
  for (const tombstone of tombstones) {
    await removeCheckpointTombstone(tombstone);
  }
  return Object.freeze({ removedTombstones: tombstones.length });
}

/**
 * Durable single-host checkpoint adapter with cross-process file locking.
 *
 * @remarks
 * The lock protects compare-and-swap plus rename as one critical section.
 * Readers need no lock because checkpoint replacement is atomic on one local
 * filesystem. The configured root must not span filesystems via symlinks.
 *
 * File contents are flushed to disk before each rename, and the directory
 * after it. Windows cannot flush a directory, so there a rename is journaled
 * by NTFS but a save that already resolved can still be lost to a power
 * failure right after it. Elsewhere a failed directory flush fails the save.
 */
export class FileSystemWorkflowCheckpointStore
  implements WorkflowCheckpointStore
{
  readonly #root: string;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #maxCheckpointBytes: number;

  /**
   * @param options - Root directory, lock timing, abort signal and size limit.
   * @throws {@link WorkflowError} with code `WORKFLOW_DEFINITION_INVALID` when `root` is not absolute
   * or a numeric option is not a positive integer.
   */
  constructor(options: FileSystemWorkflowCheckpointStoreOptions) {
    if (!isAbsolute(options.root)) {
      throw new WorkflowError(
        "WORKFLOW_DEFINITION_INVALID",
        "File-system checkpoint root must be absolute",
        { root: options.root },
      );
    }
    this.#root = resolve(options.root);
    this.#lockTimeoutMs = positiveInteger(
      "lockTimeoutMs",
      options.lockTimeoutMs ?? 10_000,
    );
    this.#lockRetryMs = positiveInteger(
      "lockRetryMs",
      options.lockRetryMs ?? 25,
    );
    this.#signal = options.signal;
    this.#maxCheckpointBytes = positiveInteger(
      "maxCheckpointBytes",
      options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    );
  }

  /** Largest checkpoint, in UTF-8 JSON bytes, that this store saves or loads. */
  get maxCheckpointBytes(): number {
    return this.#maxCheckpointBytes;
  }

  /**
   * Reads a checkpoint file without taking the lock.
   *
   * @remarks
   * The file is opened once without following symlinks, and checked and read
   * through that handle.
   *
   * @param input - Workflow id and execution id.
   * @returns The checkpoint, or `undefined` when no file exists.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` when the file is unreadable, malformed,
   * not a regular file, or larger than `maxCheckpointBytes`.
   */
  async load(
    input: LoadWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointV1 | undefined> {
    const checkpointKey = workflowCheckpointKey(
      input.workflowId,
      input.executionId,
    );
    const checkpointPath = this.#checkpointPath(checkpointKey);
    const stored = await readCheckpointFile(
      checkpointPath,
      checkpointKey,
      this.#maxCheckpointBytes,
    );
    return stored?.checkpoint;
  }

  /**
   * Writes a checkpoint atomically under a cross-process lock.
   *
   * @remarks
   * Once the checkpoint file is replaced the save has succeeded, unless the
   * lock turns out to belong to another owner: then the save rejects with
   * `checkpoint_lock_ownership_lost`, because a concurrent writer may have
   * replaced the same checkpoint (`checkpoint_lock_corrupt` when the lock has
   * no valid owner any more). If only the release I/O fails (the rename
   * or the directory sync), the save still resolves and logs the warning
   * `WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED` through ADK's logger; a lock
   * left behind makes the next save of the same execution fail with
   * `checkpoint_lock_timeout` until the process exits.
   *
   * @param input - Checkpoint plus optional revision preconditions.
   * @returns The key and the `stateDelta` for the saved checkpoint.
   * @throws {@link WorkflowCheckpointConflictError} when `expectedRevision` does not match the stored revision.
   * @throws {@link WorkflowError} with code `WORKFLOW_EXECUTION_ERROR` for an invalid or oversized checkpoint,
   * a mismatching supplied `revision`, a lock timeout or abort, or a file-system failure.
   */
  async save(
    input: SaveWorkflowCheckpointInput,
  ): Promise<WorkflowCheckpointWrite> {
    if (!isWorkflowCheckpointV1(input.checkpoint)) {
      throw checkpointFileError(
        "checkpoint_schema_invalid",
        workflowCheckpointKey("invalid", "invalid"),
        "Cannot persist an invalid workflow checkpoint",
      );
    }

    const durableCheckpoint = toDurableWorkflowCheckpoint(input.checkpoint);
    const checkpointKey = workflowCheckpointKey(
      durableCheckpoint.workflowId,
      durableCheckpoint.executionId,
    );
    assertWorkflowCheckpointSize(
      durableCheckpoint,
      checkpointKey,
      this.#maxCheckpointBytes,
      "save",
    );
    const checkpointPath = this.#checkpointPath(checkpointKey);
    const revision = await workflowCheckpointRevision(durableCheckpoint);
    if (input.revision !== undefined && input.revision !== revision) {
      throw checkpointFileError(
        "checkpoint_revision_invalid",
        checkpointKey,
        `Workflow checkpoint revision does not match checkpoint: ${checkpointKey}`,
        {
          suppliedRevision: input.revision,
          computedRevision: revision,
        },
      );
    }

    try {
      await mkdir(dirname(checkpointPath), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw ioError("checkpoint_directory_create_failed", checkpointKey, error);
    }
    const lock = await this.#acquireLock(checkpointPath, checkpointKey);
    try {
      const current = await readCheckpointFile(
        checkpointPath,
        checkpointKey,
        this.#maxCheckpointBytes,
      );
      const actualRevision = current?.revision ?? null;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== actualRevision
      ) {
        throw new WorkflowCheckpointConflictError(
          checkpointKey,
          input.expectedRevision,
          actualRevision,
        );
      }

      const stored: CheckpointFileV1 = {
        format: FILE_FORMAT,
        formatVersion: FILE_FORMAT_VERSION,
        checkpointKey,
        revision,
        checkpoint: durableCheckpoint,
      };
      await atomicWriteCheckpoint(
        checkpointPath,
        stored,
        checkpointKey,
        lock.assertOwned,
      );
    } catch (error) {
      try {
        await lock.release();
      } catch (releaseError) {
        // Keep the primary failure (e.g. a CAS conflict) visible to callers.
        attachCleanupErrors(error, [releaseError]);
      }
      throw error;
    }
    // Reached only when the write succeeded: the catch above rethrows.
    try {
      await lock.release();
    } catch (releaseError) {
      // A lost lock means another process took it over and may have written
      // this checkpoint too, so the revision check above guarantees nothing:
      // fail the save. Only an I/O failure of the release itself (rename or
      // directory sync) leaves a durable, uncontested save; a lock left
      // behind then makes the next save on this key fail with
      // `checkpoint_lock_timeout`.
      if (
        !(releaseError instanceof WorkflowError) ||
        releaseError.details?.reason !== "checkpoint_lock_release_failed"
      ) {
        throw releaseError;
      }
      warn(
        CHECKPOINT_LOCK_RELEASE_FAILED,
        `Workflow checkpoint was saved but its lock could not be released: ${checkpointKey} (${String(
          releaseError.details?.causeCode,
        )})`,
      );
    }

    return {
      checkpointKey,
      stateDelta: { [checkpointKey]: durableCheckpoint },
    };
  }

  #checkpointPath(checkpointKey: string): string {
    const digest = createHash("sha256").update(checkpointKey).digest("hex");
    return join(this.#root, digest.slice(0, 2), `${digest}.json`);
  }

  async #acquireLock(
    checkpointPath: string,
    checkpointKey: string,
  ): Promise<HeldCheckpointLock> {
    const lockPath = `${checkpointPath}.lock`;
    const startedAt = monotonicNow();
    await cleanupAbandonedCandidates(lockPath, checkpointKey);
    while (true) {
      throwIfLockWaitAborted(this.#signal, checkpointKey);
      // `rename` replaces an empty directory, so an owner-less empty lock would
      // be taken over silently. An occupied path goes to the contention branch,
      // where it is reported `checkpoint_lock_corrupt`. Only an external writer
      // creates an empty lock, and one created between this check and the
      // rename is still replaced.
      if (!(await lockPathOccupied(lockPath, checkpointKey))) {
        const token = randomUUID();
        const candidatePath = await createLockCandidate(
          lockPath,
          token,
          checkpointKey,
        );
        try {
          await rename(candidatePath, lockPath);
          return {
            assertOwned: async () =>
              await assertLockOwnership(lockPath, token, checkpointKey),
            release: async () =>
              await releaseLock(lockPath, token, checkpointKey),
          };
        } catch (error) {
          try {
            await rm(candidatePath, { recursive: true, force: true });
          } catch (cleanupError) {
            throw ioError(
              "checkpoint_lock_candidate_cleanup_failed",
              checkpointKey,
              cleanupError,
            );
          }
          if (!(await isLockContention(error, lockPath))) {
            throw ioError(
              "checkpoint_lock_acquire_failed",
              checkpointKey,
              error,
            );
          }
        }
      }

      if (await recoverAbandonedLock(lockPath, checkpointKey)) {
        continue;
      }
      if (monotonicNow() - startedAt >= this.#lockTimeoutMs) {
        throw checkpointFileError(
          "checkpoint_lock_timeout",
          checkpointKey,
          `Timed out waiting for workflow checkpoint lock: ${checkpointKey}`,
          { timeoutMs: this.#lockTimeoutMs },
        );
      }
      await abortableDelay(this.#lockRetryMs, this.#signal, checkpointKey);
    }
  }
}

async function checkpointOfflineRoot(
  options: OfflineCheckpointTombstoneCollectionOptions | undefined,
): Promise<string> {
  if (options?.confirmNoActiveWriters !== true) {
    throw offlineOptionsError(
      "Offline checkpoint tombstone collection requires confirmNoActiveWriters: true",
    );
  }
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    throw offlineOptionsError(
      "Offline checkpoint tombstone collection root must be absolute",
    );
  }
  const root = resolve(options.root);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw offlineTreeError(
      "Offline checkpoint tombstone collection root is not a safe directory",
    );
  }
  return root;
}

async function scanCheckpointOfflineTree(
  root: string,
  directory: string,
  tombstones: OfflineCheckpointTombstone[],
): Promise<void> {
  for (const entry of await readdir(directory)) {
    const path = join(directory, entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw offlineTreeError(
        `Offline checkpoint tombstone collection rejects symlinks: ${path}`,
      );
    }
    if (
      SAFE_CHECKPOINT_LOCK.test(entry) ||
      SAFE_CHECKPOINT_CANDIDATE.test(entry) ||
      entry.includes(".json.lock.candidate.")
    ) {
      throw offlineTreeError(
        `Offline checkpoint tombstone collection found an active lock or candidate: ${path}`,
      );
    }
    if (!info.isDirectory() && !info.isFile()) {
      throw offlineTreeError(
        `Offline checkpoint tombstone collection found an unsafe entry: ${path}`,
      );
    }
    const match = SAFE_CHECKPOINT_TOMBSTONE.exec(entry);
    if (
      match &&
      info.isDirectory() &&
      dirname(directory) === root &&
      SAFE_CHECKPOINT_SHARD.test(basename(directory))
    ) {
      const tokenKey = match[1] as string;
      await assertValidCheckpointTombstone(path, tokenKey);
      tombstones.push({ path, device: info.dev, inode: info.ino });
      continue;
    }
    if (entry.includes(".json.lock.retired.")) {
      throw offlineTreeError(
        `Offline checkpoint tombstone is malformed or misplaced: ${path}`,
      );
    }
    if (info.isDirectory()) {
      await scanCheckpointOfflineTree(root, path, tombstones);
    }
  }
}

async function assertValidCheckpointTombstone(
  tombstonePath: string,
  expectedTokenKey: string,
): Promise<void> {
  const entries = await readdir(tombstonePath);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw offlineTreeError(
      `Offline checkpoint tombstone has unsafe contents: ${tombstonePath}`,
    );
  }
  const ownerPath = join(tombstonePath, LOCK_OWNER_FILE);
  const ownerInfo = await lstat(ownerPath);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
    throw offlineTreeError(
      `Offline checkpoint tombstone has an unsafe owner: ${tombstonePath}`,
    );
  }
  const owner = parseLockMetadata(await readFile(ownerPath, "utf8"));
  if (!owner || directoryLockTokenKey(owner.token) !== expectedTokenKey) {
    throw offlineTreeError(
      `Offline checkpoint tombstone token does not match its owner: ${tombstonePath}`,
    );
  }
}

async function removeCheckpointTombstone(
  tombstone: OfflineCheckpointTombstone,
): Promise<void> {
  const current = await lstat(tombstone.path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== tombstone.device ||
    current.ino !== tombstone.inode
  ) {
    throw offlineTreeError(
      `Offline checkpoint tombstone changed during collection: ${tombstone.path}`,
    );
  }
  const match = SAFE_CHECKPOINT_TOMBSTONE.exec(basename(tombstone.path));
  if (!match) {
    throw offlineTreeError(
      `Offline checkpoint tombstone became unsafe: ${tombstone.path}`,
    );
  }
  await assertValidCheckpointTombstone(tombstone.path, match[1] as string);
  await rm(tombstone.path, { recursive: true });
  await fsyncDirectory(dirname(tombstone.path));
}

function offlineOptionsError(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message);
}

function offlineTreeError(message: string): WorkflowError {
  return new WorkflowError("WORKFLOW_EXECUTION_ERROR", message, {
    reason: "checkpoint_file_unsafe" satisfies WorkflowCheckpointFailureReason,
  });
}

async function readCheckpointFile(
  checkpointPath: string,
  checkpointKey: string,
  maxCheckpointBytes: number,
): Promise<CheckpointFileV1 | undefined> {
  const raw = await readCheckpointBytes(
    checkpointPath,
    checkpointKey,
    maxCheckpointBytes,
  );
  if (raw === undefined) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw checkpointFileError(
        "checkpoint_file_corrupt",
        checkpointKey,
        `Workflow checkpoint file is not valid JSON: ${checkpointKey}`,
      );
    }
    throw ioError("checkpoint_read_failed", checkpointKey, error);
  }

  if (!isCheckpointFileV1(parsed, checkpointKey)) {
    throw checkpointFileError(
      "checkpoint_file_corrupt",
      checkpointKey,
      `Workflow checkpoint file has an invalid envelope: ${checkpointKey}`,
    );
  }
  assertWorkflowCheckpointSize(
    parsed.checkpoint,
    checkpointKey,
    maxCheckpointBytes,
    "load",
  );
  // Files written before 0.7.0 carry the legacy revision; the returned
  // revision below is always canonical.
  if (
    !(await workflowCheckpointRevisionMatches(
      parsed.checkpoint,
      parsed.revision,
    ))
  ) {
    throw checkpointFileError(
      "checkpoint_revision_invalid",
      checkpointKey,
      `Workflow checkpoint file revision is invalid: ${checkpointKey}`,
      {
        storedRevision: parsed.revision,
        computedRevision: await workflowCheckpointRevision(parsed.checkpoint),
      },
    );
  }
  const durableCheckpoint = toDurableWorkflowCheckpoint(parsed.checkpoint);
  const canonicalRevision = await workflowCheckpointRevision(durableCheckpoint);
  return {
    ...parsed,
    checkpoint: durableCheckpoint,
    revision: canonicalRevision,
  };
}

/**
 * Checks the checkpoint path with an `lstat` (a symlink is rejected), opens it
 * once, and reads it through that handle only when the path names the opened
 * file (device and inode; on Windows volume and file id). When the opened
 * file is not the one checked, the path is checked again: a file a save
 * renamed over the path in between is read, but a path that is now a symlink
 * or names another file is refused. A symlink swapped in after the check is so
 * never read, also where the open follows it (Windows has no `O_NOFOLLOW`);
 * where `O_NOFOLLOW` exists, the open refuses a symlink too. A FIFO is opened
 * non-blocking and then rejected as not a regular file.
 */
async function readCheckpointBytes(
  checkpointPath: string,
  checkpointKey: string,
  maxCheckpointBytes: number,
): Promise<string | undefined> {
  let checked: BigIntStats;
  try {
    checked = await lstat(checkpointPath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw ioError("checkpoint_stat_failed", checkpointKey, error);
  }
  if (checked.isSymbolicLink()) {
    throw unsafeCheckpointFileError(checkpointKey);
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      checkpointPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    // O_NOFOLLOW reports a symlink as ELOOP (EMLINK on FreeBSD).
    if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")) {
      throw unsafeCheckpointFileError(checkpointKey);
    }
    throw ioError("checkpoint_stat_failed", checkpointKey, error);
  }
  try {
    let info: BigIntStats;
    try {
      info = await handle.stat({ bigint: true });
    } catch (error) {
      throw ioError("checkpoint_stat_failed", checkpointKey, error);
    }
    if (!info.isFile()) {
      throw unsafeCheckpointFileError(checkpointKey);
    }
    if (info.dev !== checked.dev || info.ino !== checked.ino) {
      // A concurrent save renames a new file over the path, so the opened
      // file may be newer than the one checked. Read it only when the path
      // still names it now and is not a symlink.
      let current: BigIntStats | undefined;
      try {
        current = await lstat(checkpointPath, { bigint: true });
      } catch {
        current = undefined;
      }
      if (
        current === undefined ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino
      ) {
        throw checkpointFileError(
          "checkpoint_file_unsafe",
          checkpointKey,
          `Workflow checkpoint path changed while it was read: ${checkpointKey}`,
        );
      }
    }
    const envelopeOverheadBytes =
      checkpointEnvelopeOverheadBytes(checkpointKey);
    const maxFileBytes = maxCheckpointBytes + envelopeOverheadBytes;
    const size = Number(info.size);
    if (size > maxFileBytes) {
      throw workflowCheckpointSizeLimitError(
        checkpointKey,
        maxCheckpointBytes,
        size - envelopeOverheadBytes,
        "load",
      );
    }
    let raw: string;
    try {
      raw = await handle.readFile("utf8");
    } catch (error) {
      throw ioError("checkpoint_read_failed", checkpointKey, error);
    }
    const readBytes = Buffer.byteLength(raw, "utf8");
    if (readBytes > maxFileBytes) {
      // The file grew after the size check.
      throw workflowCheckpointSizeLimitError(
        checkpointKey,
        maxCheckpointBytes,
        readBytes - envelopeOverheadBytes,
        "load",
      );
    }
    return raw;
  } finally {
    await handle.close().catch(() => {});
  }
}

function unsafeCheckpointFileError(checkpointKey: string): WorkflowError {
  return checkpointFileError(
    "checkpoint_file_unsafe",
    checkpointKey,
    `Workflow checkpoint path is not a regular file: ${checkpointKey}`,
  );
}

function checkpointEnvelopeOverheadBytes(checkpointKey: string): number {
  const placeholder: Omit<CheckpointFileV1, "checkpoint"> & {
    checkpoint: null;
  } = {
    format: FILE_FORMAT,
    formatVersion: FILE_FORMAT_VERSION,
    checkpointKey,
    revision: `sha256:${"0".repeat(64)}`,
    checkpoint: null,
  };
  const envelopeBytes = new TextEncoder().encode(
    `${JSON.stringify(placeholder)}\n`,
  ).byteLength;
  return envelopeBytes - 4;
}

function isCheckpointFileV1(
  value: unknown,
  checkpointKey: string,
): value is CheckpointFileV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.format === FILE_FORMAT &&
    value.formatVersion === FILE_FORMAT_VERSION &&
    value.checkpointKey === checkpointKey &&
    typeof value.revision === "string" &&
    isWorkflowCheckpointV1(value.checkpoint) &&
    workflowCheckpointKey(
      value.checkpoint.workflowId,
      value.checkpoint.executionId,
    ) === checkpointKey
  );
}

async function atomicWriteCheckpoint(
  checkpointPath: string,
  stored: CheckpointFileV1,
  checkpointKey: string,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  const directory = dirname(checkpointPath);
  const temporaryPath = join(
    directory,
    `.${basename(checkpointPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryExists = true;
    try {
      await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertOwnership();
    await rename(temporaryPath, checkpointPath);
    temporaryExists = false;
    await fsyncDirectory(directory);
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw ioError("checkpoint_write_failed", checkpointKey, error);
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath).catch(() => {});
    }
  }
}

async function createLockCandidate(
  lockPath: string,
  token: string,
  checkpointKey: string,
): Promise<string> {
  const candidatePath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.candidate.${process.pid}.${token}`,
  );
  try {
    await mkdir(candidatePath, { mode: 0o700 });
    const ownerHandle = await open(
      join(candidatePath, LOCK_OWNER_FILE),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      const metadata: LockMetadata = {
        token,
        pid: process.pid,
        acquiredAt: Date.now(),
      };
      await ownerHandle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    await fsyncDirectory(candidatePath);
    return candidatePath;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
    throw ioError("checkpoint_lock_candidate_failed", checkpointKey, error);
  }
}

async function cleanupAbandonedCandidates(
  lockPath: string,
  checkpointKey: string,
): Promise<void> {
  const directory = dirname(lockPath);
  const prefix = `.${basename(lockPath)}.candidate.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw ioError("checkpoint_lock_cleanup_failed", checkpointKey, error);
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const pidText = entry.slice(prefix.length).split(".", 1)[0];
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) {
      continue;
    }
    await rm(join(directory, entry), { recursive: true, force: true }).catch(
      () => {},
    );
  }
}

async function lockPathOccupied(
  lockPath: string,
  checkpointKey: string,
): Promise<boolean> {
  try {
    await lstat(lockPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
  }
}

async function isLockContention(
  error: unknown,
  lockPath: string,
): Promise<boolean> {
  if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
    return true;
  }
  if (!hasErrorCode(error, "EPERM")) {
    return false;
  }
  try {
    await lstat(lockPath);
    return true;
  } catch (statError) {
    return !hasErrorCode(statError, "ENOENT");
  }
}

async function readLockOwner(
  lockPath: string,
  checkpointKey: string,
): Promise<LockMetadata | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw unsafeLockError(checkpointKey);
  }

  // A missing owner means either that this directory was retired (the path
  // now names another lock or nothing) or that it lost its owner in place.
  // (dev, ino) tells the two apart only while the directory is held open:
  // Linux (ext4) and NTFS give a freed number to the next directory at once,
  // so a lock retired and republished in between would look unchanged. The
  // open neither follows a symlink nor blocks on a FIFO swapped in since the
  // check above (on Windows that check alone rejects a symlink).
  let pin: FileHandle;
  try {
    pin = await open(
      lockPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    // O_NOFOLLOW reports a symlink as ELOOP (EMLINK on FreeBSD).
    if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")) {
      throw unsafeLockError(checkpointKey);
    }
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
  }
  let rawOwner: string | "replaced" | "retired";
  try {
    rawOwner = await readPinnedLockOwner(lockPath, pin, checkpointKey);
  } finally {
    // A read-only handle: closing it cannot lose data.
    await pin.close().catch(() => {});
  }
  if (rawOwner === "retired") {
    return undefined;
  }
  if (rawOwner === "replaced") {
    return await readLockOwner(lockPath, checkpointKey);
  }
  const metadata = parseLockMetadata(rawOwner);
  if (!metadata) {
    throw checkpointFileError(
      "checkpoint_lock_corrupt",
      checkpointKey,
      `Workflow checkpoint lock has invalid owner metadata: ${checkpointKey}`,
    );
  }
  return metadata;
}

function unsafeLockError(checkpointKey: string): WorkflowError {
  return checkpointFileError(
    "checkpoint_lock_corrupt",
    checkpointKey,
    `Workflow checkpoint lock is not a safe directory: ${checkpointKey}`,
  );
}

/**
 * Reads the owner of the lock directory `pin` holds open: `"replaced"` when
 * the path now names another directory, `"retired"` when it names nothing.
 */
async function readPinnedLockOwner(
  lockPath: string,
  pin: FileHandle,
  checkpointKey: string,
): Promise<string | "replaced" | "retired"> {
  let pinned: Awaited<ReturnType<FileHandle["stat"]>>;
  try {
    pinned = await pin.stat();
  } catch (error) {
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
  }
  if (!pinned.isDirectory()) {
    throw unsafeLockError(checkpointKey);
  }
  try {
    return await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
    }
  }
  try {
    const current = await lstat(lockPath);
    if (current.dev !== pinned.dev || current.ino !== pinned.ino) {
      return "replaced";
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "retired";
    }
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
  }
  throw checkpointFileError(
    "checkpoint_lock_corrupt",
    checkpointKey,
    `Workflow checkpoint lock has no valid owner: ${checkpointKey}`,
  );
}

async function assertLockOwnership(
  lockPath: string,
  token: string,
  checkpointKey: string,
): Promise<void> {
  const metadata = await readLockOwner(lockPath, checkpointKey);
  if (metadata?.token !== token || metadata.pid !== process.pid) {
    throw checkpointFileError(
      "checkpoint_lock_ownership_lost",
      checkpointKey,
      `Workflow checkpoint lock ownership was lost: ${checkpointKey}`,
      { expectedToken: token, actualToken: metadata?.token ?? null },
    );
  }
}

async function releaseLock(
  lockPath: string,
  token: string,
  checkpointKey: string,
): Promise<void> {
  await assertLockOwnership(lockPath, token, checkpointKey);
  const retiredPath = retiredDirectoryLockPath(lockPath, token);
  try {
    await renameRetryingBlocked(lockPath, retiredPath);
    await fsyncDirectory(dirname(lockPath));
  } catch (error) {
    throw ioError("checkpoint_lock_release_failed", checkpointKey, error);
  }
  // A live owner's own tombstone fences nothing: a recoverer retires a lock
  // only after re-reading it under a dead owner (see recoverAbandonedLock).
  // Removing it keeps the root from growing on every save; a leftover after a
  // crash is collected offline.
  await rm(retiredPath, { recursive: true, force: true }).catch(() => {});
}

/**
 * Renames, waiting out a Windows open file a few times: a directory cannot be
 * renamed while another process has a file inside it open, such as a waiter
 * reading `owner.json`. Retries only `EPERM`, `EBUSY` and `EACCES`, 5 attempts
 * 20 ms apart; any other error is thrown at once.
 *
 * @param from - Path to rename.
 * @param to - New path.
 * @param renamePath - The rename to run; the file system's by default. The
 * test fixtures pass their own so they retire a lock with the same policy.
 * @throws The rename's error when it is not a blocked rename, or when the
 * rename is still blocked after the last attempt.
 * @internal
 */
export async function renameRetryingBlocked(
  from: string,
  to: string,
  renamePath: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renamePath(from, to);
      return;
    } catch (error) {
      if (
        attempt >= 5 ||
        !(
          hasErrorCode(error, "EPERM") ||
          hasErrorCode(error, "EBUSY") ||
          hasErrorCode(error, "EACCES")
        )
      ) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  }
}

async function recoverAbandonedLock(
  lockPath: string,
  checkpointKey: string,
): Promise<boolean> {
  const metadata = await readLockOwner(lockPath, checkpointKey);
  if (!metadata) {
    return true;
  }
  if (isProcessAlive(metadata.pid)) {
    return false;
  }
  // Read the owner again now that it is known dead. If it released the lock
  // after the first read (and removed its tombstone), a newer owner may hold
  // the path; a dead owner cannot release, so a token that is still there is
  // the abandoned lock, and only another recoverer can race this rename.
  const current = await readLockOwner(lockPath, checkpointKey);
  if (current?.token !== metadata.token) {
    return true;
  }
  const retiredPath = retiredDirectoryLockPath(lockPath, metadata.token);
  try {
    await rename(lockPath, retiredPath);
    await fsyncDirectory(dirname(lockPath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    if (isRetireCollision(error, retiredPath)) {
      return false;
    }
    throw ioError("checkpoint_lock_recovery_failed", checkpointKey, error);
  }
}

function parseLockMetadata(value: string): LockMetadata | undefined {
  try {
    return parseDirectoryLockOwner(value);
  } catch {
    return undefined;
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowError(
      "WORKFLOW_DEFINITION_INVALID",
      `${name} must be a positive safe integer`,
      { name, value },
    );
  }
  return value;
}

/**
 * Throws `WORKFLOW_ABORTED` naming the checkpoint key when the store's signal
 * aborted while it waits for a lock; the signal's reason is not used.
 */
function throwIfLockWaitAborted(
  signal: AbortSignal | undefined,
  checkpointKey: string,
): void {
  if (signal?.aborted) {
    throw new WorkflowError(
      "WORKFLOW_ABORTED",
      `Workflow checkpoint lock acquisition was aborted: ${checkpointKey}`,
      { checkpointKey },
    );
  }
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  checkpointKey: string,
): Promise<void> {
  throwIfLockWaitAborted(signal, checkpointKey);
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise<void>((resolveDelay, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveDelay();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(
        new WorkflowError(
          "WORKFLOW_ABORTED",
          `Workflow checkpoint lock acquisition was aborted: ${checkpointKey}`,
          { checkpointKey },
        ),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function checkpointFileError(
  reason: WorkflowCheckpointFailureReason,
  checkpointKey: string,
  message: string,
  details: Record<string, unknown> = {},
): WorkflowError {
  return new WorkflowError("WORKFLOW_EXECUTION_ERROR", message, {
    reason,
    checkpointKey,
    ...details,
  });
}

function ioError(
  reason: WorkflowCheckpointFailureReason,
  checkpointKey: string,
  error: unknown,
): WorkflowError {
  const wrapped = checkpointFileError(
    reason,
    checkpointKey,
    `Workflow checkpoint file operation failed: ${checkpointKey}`,
    {
      causeCode: errorCode(error),
      ...(errorMessage(error) !== undefined
        ? { causeMessage: errorMessage(error) }
        : {}),
      ...(errorSyscall(error) !== undefined
        ? { syscall: errorSyscall(error) }
        : {}),
    },
  );
  return attachCause(wrapped, error);
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

function errorSyscall(error: unknown): string | undefined {
  return isRecord(error) && typeof error.syscall === "string"
    ? error.syscall
    : undefined;
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}
