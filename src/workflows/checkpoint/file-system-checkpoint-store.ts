/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
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
import { WorkflowError } from "../contracts.js";
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
  type WorkflowCheckpointRevision,
  type WorkflowCheckpointStore,
  type WorkflowCheckpointWrite,
  workflowCheckpointKey,
  workflowCheckpointRevision,
  workflowCheckpointSizeLimitError,
} from "./store.js";

const FILE_FORMAT = "adk-llm-bridge/workflow-checkpoint-file";
const FILE_FORMAT_VERSION = 1;
const LOCK_OWNER_FILE = "owner.json";
const SAFE_LOCK_TOKEN = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_CHECKPOINT_SHARD = /^[a-f0-9]{2}$/u;
const SAFE_CHECKPOINT_LOCK = /^[a-f0-9]{64}\.json\.lock$/u;
const SAFE_CHECKPOINT_CANDIDATE =
  /^\.[a-f0-9]{64}\.json\.lock\.candidate\.[1-9][0-9]*\.[A-Za-z0-9_-]{1,128}$/u;
const SAFE_CHECKPOINT_TOMBSTONE =
  /^[a-f0-9]{64}\.json\.lock\.retired\.([A-Za-z0-9_-]{1,128})$/u;

export interface FileSystemWorkflowCheckpointStoreOptions {
  /** Absolute host-controlled directory for checkpoint data and locks. */
  root: string;
  /** Maximum time spent waiting for a live lock. Defaults to 10 seconds. */
  lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts. Defaults to 25 milliseconds. */
  lockRetryMs?: number;
  /** Optional lifetime signal for pending lock acquisition. */
  signal?: AbortSignal;
  /** Maximum UTF-8 JSON size of one durable checkpoint. Defaults to 4 MiB. */
  maxCheckpointBytes?: number;
}

export interface OfflineCheckpointTombstoneCollectionOptions {
  /** Absolute host-controlled checkpoint root. */
  root: string;
  /** Nominal acknowledgement that no store or writer is active. */
  confirmNoActiveWriters: true;
}

export interface OfflineCheckpointTombstoneCollectionResult {
  removedTombstones: number;
}

interface CheckpointFileV1 {
  format: typeof FILE_FORMAT;
  formatVersion: typeof FILE_FORMAT_VERSION;
  checkpointKey: string;
  revision: WorkflowCheckpointRevision;
  checkpoint: WorkflowCheckpointV1;
}

interface LockMetadata {
  pid: number;
  createdAt: number;
  token: string;
}

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
 * the host-controlled tree has no lock or candidate. This is not safe to run
 * concurrently with stores or writers, and intentionally has no age-based
 * mode.
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
 * The lock protects compare-and-swap plus rename as one critical section.
 * Readers need no lock because checkpoint replacement is atomic on one local
 * filesystem. The configured root must not span filesystems via symlinks.
 */
export class FileSystemWorkflowCheckpointStore
  implements WorkflowCheckpointStore
{
  readonly #root: string;
  readonly #lockTimeoutMs: number;
  readonly #lockRetryMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #maxCheckpointBytes: number;

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
    } finally {
      await lock.release();
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
    const startedAt = Date.now();
    await cleanupAbandonedCandidates(lockPath, checkpointKey);
    while (true) {
      throwIfAborted(this.#signal, checkpointKey);
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
          throw ioError("checkpoint_lock_acquire_failed", checkpointKey, error);
        }
      }

      if (await recoverAbandonedLock(lockPath, checkpointKey)) {
        continue;
      }
      if (Date.now() - startedAt >= this.#lockTimeoutMs) {
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
    throw new TypeError(
      "Offline checkpoint tombstone collection requires confirmNoActiveWriters: true",
    );
  }
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    throw new TypeError(
      "Offline checkpoint tombstone collection root must be absolute",
    );
  }
  const root = resolve(options.root);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
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
      throw new Error(
        `Offline checkpoint tombstone collection rejects symlinks: ${path}`,
      );
    }
    if (
      SAFE_CHECKPOINT_LOCK.test(entry) ||
      SAFE_CHECKPOINT_CANDIDATE.test(entry) ||
      entry.includes(".json.lock.candidate.")
    ) {
      throw new Error(
        `Offline checkpoint tombstone collection found an active lock or candidate: ${path}`,
      );
    }
    if (!info.isDirectory() && !info.isFile()) {
      throw new Error(
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
      const token = match[1] as string;
      await assertValidCheckpointTombstone(path, token);
      tombstones.push({ path, device: info.dev, inode: info.ino });
      continue;
    }
    if (entry.includes(".json.lock.retired.")) {
      throw new Error(
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
  expectedToken: string,
): Promise<void> {
  const entries = await readdir(tombstonePath);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw new Error(
      `Offline checkpoint tombstone has unsafe contents: ${tombstonePath}`,
    );
  }
  const ownerPath = join(tombstonePath, LOCK_OWNER_FILE);
  const ownerInfo = await lstat(ownerPath);
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile()) {
    throw new Error(
      `Offline checkpoint tombstone has an unsafe owner: ${tombstonePath}`,
    );
  }
  const owner = parseLockMetadata(await readFile(ownerPath, "utf8"));
  if (owner?.token !== expectedToken) {
    throw new Error(
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
    throw new Error(
      `Offline checkpoint tombstone changed during collection: ${tombstone.path}`,
    );
  }
  const match = SAFE_CHECKPOINT_TOMBSTONE.exec(basename(tombstone.path));
  if (!match) {
    throw new Error(
      `Offline checkpoint tombstone became unsafe: ${tombstone.path}`,
    );
  }
  await assertValidCheckpointTombstone(tombstone.path, match[1] as string);
  await rm(tombstone.path, { recursive: true });
  await syncDirectory(dirname(tombstone.path));
}

async function readCheckpointFile(
  checkpointPath: string,
  checkpointKey: string,
  maxCheckpointBytes: number,
): Promise<CheckpointFileV1 | undefined> {
  let fileBytes = 0;
  try {
    const info = await lstat(checkpointPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw checkpointFileError(
        "checkpoint_file_unsafe",
        checkpointKey,
        `Workflow checkpoint path is not a regular file: ${checkpointKey}`,
      );
    }
    fileBytes = info.size;
    const envelopeOverheadBytes =
      checkpointEnvelopeOverheadBytes(checkpointKey);
    const maxFileBytes = maxCheckpointBytes + envelopeOverheadBytes;
    if (fileBytes > maxFileBytes) {
      throw workflowCheckpointSizeLimitError(
        checkpointKey,
        maxCheckpointBytes,
        fileBytes - envelopeOverheadBytes,
        "load",
      );
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw ioError("checkpoint_stat_failed", checkpointKey, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(checkpointPath, "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
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
  const storedRevision = await workflowCheckpointRevision(parsed.checkpoint);
  if (parsed.revision !== storedRevision) {
    throw checkpointFileError(
      "checkpoint_revision_invalid",
      checkpointKey,
      `Workflow checkpoint file revision is invalid: ${checkpointKey}`,
      {
        storedRevision: parsed.revision,
        computedRevision: storedRevision,
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

function checkpointEnvelopeOverheadBytes(checkpointKey: string): number {
  const placeholder: CheckpointFileV1 = {
    format: FILE_FORMAT,
    formatVersion: FILE_FORMAT_VERSION,
    checkpointKey,
    revision: `sha256:${"0".repeat(64)}`,
    checkpoint: null as unknown as WorkflowCheckpointV1,
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
    await syncDirectory(directory);
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
        pid: process.pid,
        createdAt: Date.now(),
        token,
      };
      await ownerHandle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      await ownerHandle.sync();
    } finally {
      await ownerHandle.close();
    }
    await syncDirectory(candidatePath);
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
    throw checkpointFileError(
      "checkpoint_lock_corrupt",
      checkpointKey,
      `Workflow checkpoint lock is not a safe directory: ${checkpointKey}`,
    );
  }

  let rawOwner: string;
  try {
    rawOwner = await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      try {
        const currentInfo = await lstat(lockPath);
        if (currentInfo.dev !== info.dev || currentInfo.ino !== info.ino) {
          return await readLockOwner(lockPath, checkpointKey);
        }
      } catch (statError) {
        if (hasErrorCode(statError, "ENOENT")) {
          return undefined;
        }
        throw ioError("checkpoint_lock_read_failed", checkpointKey, statError);
      }
      throw checkpointFileError(
        "checkpoint_lock_corrupt",
        checkpointKey,
        `Workflow checkpoint lock has no valid owner: ${checkpointKey}`,
      );
    }
    throw ioError("checkpoint_lock_read_failed", checkpointKey, error);
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
  const retiredPath = `${lockPath}.retired.${token}`;
  try {
    await rename(lockPath, retiredPath);
    await syncDirectory(dirname(lockPath));
  } catch (error) {
    throw ioError("checkpoint_lock_release_failed", checkpointKey, error);
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
  const retiredPath = `${lockPath}.retired.${metadata.token}`;
  try {
    await rename(lockPath, retiredPath);
    await syncDirectory(dirname(lockPath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return true;
    }
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
      return false;
    }
    throw ioError("checkpoint_lock_recovery_failed", checkpointKey, error);
  }
}

function parseLockMetadata(value: string): LockMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid as number) <= 0 ||
      !Number.isSafeInteger(parsed.createdAt) ||
      (parsed.createdAt as number) <= 0 ||
      typeof parsed.token !== "string" ||
      !SAFE_LOCK_TOKEN.test(parsed.token)
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid as number,
      createdAt: parsed.createdAt as number,
      token: parsed.token,
    };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
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

function throwIfAborted(
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
  throwIfAborted(signal, checkpointKey);
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
  reason: string,
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
  reason: string,
  checkpointKey: string,
  error: unknown,
): WorkflowError {
  return checkpointFileError(
    reason,
    checkpointKey,
    `Workflow checkpoint file operation failed: ${checkpointKey}`,
    { causeCode: errorCode(error) },
  );
}

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
