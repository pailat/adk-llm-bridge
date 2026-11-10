/**
 * Cross-process directory lock shared by the file-system workspace adapter
 * and the Git repository mutation lock. Not exported from any public barrel.
 *
 * @remarks
 * A lock is a directory that holds `owner.json`. It is published atomically:
 * the owner file is written into a private candidate directory, which is then
 * renamed onto the lock path, so the lock never exists without its owner.
 * A lock is retired by renaming it to `<lock>.retired.<sha256(token)>`. The
 * name is keyed by the token the retiring process observed, so a delayed
 * retirement of a dead owner's lock collides with the first one instead of
 * moving a newer owner's lock away. That tombstone is kept; deleting it while
 * other processes run would reopen the race.
 *
 * A live owner that releases its lock removes its own tombstone: a recoverer
 * re-reads the owner after finding its process dead and retires only a lock
 * that still carries the dead token, and a dead owner can no longer release.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isProcessAlive } from "./error-support.js";

/**
 * Name of the owner file inside a lock directory.
 *
 * @internal
 */
export const DIRECTORY_LOCK_OWNER_FILE = "owner.json";

/**
 * Contents of a lock's owner file.
 *
 * @internal
 */
export interface DirectoryLockOwner {
  /** Random token that fences release and retirement. */
  token: string;
  /** Process that holds the lock. */
  pid: number;
  /** Epoch milliseconds when the lock was taken. */
  acquiredAt: number;
}

/**
 * Tries once to publish a new lock at `lockPath`.
 *
 * @param lockPath - Lock directory; its parent must exist.
 * @returns The new owner, or `undefined` when another owner holds the lock.
 * @throws The file-system error when the candidate cannot be written or
 * renamed for another reason than an existing lock.
 * @internal
 */
export function tryAcquireDirectoryLock(
  lockPath: string,
): DirectoryLockOwner | undefined {
  const owner: DirectoryLockOwner = {
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: Date.now(),
  };
  const candidate = `${lockPath}.candidate-${owner.token}`;
  mkdirSync(candidate, { mode: 0o700 });
  try {
    writeDurableFileSync(
      join(candidate, DIRECTORY_LOCK_OWNER_FILE),
      JSON.stringify(owner),
    );
    try {
      renameSync(candidate, lockPath);
      fsyncDirectorySync(resolve(lockPath, ".."));
      return owner;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
        return undefined;
      }
      throw error;
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

/**
 * Retires the lock when its owner process is provably dead.
 *
 * @remarks
 * A lock whose owner file is missing or malformed is never retired: its
 * ownership cannot be proven dead.
 *
 * @param lockPath - Lock directory.
 * @throws The file-system error when the rename fails for another reason than
 * a concurrent retirement.
 * @internal
 */
export function recoverDeadDirectoryLock(lockPath: string): void {
  let owner: DirectoryLockOwner;
  try {
    owner = parseDirectoryLockOwner(
      readFileSync(join(lockPath, DIRECTORY_LOCK_OWNER_FILE), "utf8"),
    );
  } catch {
    return;
  }
  if (isProcessAlive(owner.pid)) return;
  // The owner may have released the lock (and removed its tombstone) after
  // the first read, letting a newer owner take the path. Retire only a lock
  // that still carries the dead token.
  if (!directoryLockTokenMatches(lockPath, owner.token)) return;
  retireDirectoryLock(lockPath, owner.token);
}

/**
 * Releases the lock when `token` still owns it, and removes the tombstone
 * the release leaves.
 *
 * @param lockPath - Lock directory.
 * @param token - Token returned by {@link tryAcquireDirectoryLock}.
 * @returns True when this call retired the lock; false when the token no
 * longer owns it.
 * @throws The file-system error when the rename fails for another reason.
 * @internal
 */
export function releaseDirectoryLock(lockPath: string, token: string): boolean {
  if (!directoryLockTokenMatches(lockPath, token)) return false;
  if (!retireDirectoryLock(lockPath, token)) return false;
  try {
    rmSync(retiredDirectoryLockPath(lockPath, token), {
      recursive: true,
      force: true,
    });
  } catch {
    // Best effort: a leftover tombstone is collected offline.
  }
  return true;
}

/**
 * Checks whether `token` owns the lock.
 *
 * @param lockPath - Lock directory.
 * @param token - Token to compare.
 * @returns True when the owner file is readable and carries `token`.
 * @internal
 */
export function directoryLockTokenMatches(
  lockPath: string,
  token: string,
): boolean {
  try {
    return (
      parseDirectoryLockOwner(
        readFileSync(join(lockPath, DIRECTORY_LOCK_OWNER_FILE), "utf8"),
      ).token === token
    );
  } catch {
    return false;
  }
}

/**
 * Parses an owner file.
 *
 * @param input - File contents.
 * @returns The owner.
 * @throws `Error` when the contents are not a valid owner.
 * @internal
 */
export function parseDirectoryLockOwner(input: string): DirectoryLockOwner {
  const value: unknown = JSON.parse(input);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !value.token ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !("acquiredAt" in value) ||
    typeof value.acquiredAt !== "number" ||
    !Number.isFinite(value.acquiredAt)
  ) {
    throw new Error("Invalid workspace lock owner");
  }
  return {
    token: value.token,
    pid: value.pid as number,
    acquiredAt: value.acquiredAt,
  };
}

/**
 * Key of a token in a tombstone name.
 *
 * @param token - Owner token.
 * @returns Lowercase SHA-256 hex of the token.
 * @internal
 */
export function directoryLockTokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Writes a new file and flushes it to disk.
 *
 * @param path - File to create; it must not exist.
 * @param content - UTF-8 contents.
 * @throws The file-system error, including `EEXIST` when the file exists.
 * @internal
 */
export function writeDurableFileSync(path: string, content: string): void {
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Flushes a directory entry change to disk where the platform supports it.
 *
 * @param directory - Directory to flush.
 * @throws The file-system error, except the codes of platforms that cannot
 * flush a directory.
 * @internal
 */
export function fsyncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      hasErrorCode(error, "EINVAL") ||
      hasErrorCode(error, "ENOTSUP") ||
      hasErrorCode(error, "EPERM") ||
      hasErrorCode(error, "EISDIR")
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function retiredDirectoryLockPath(lockPath: string, token: string): string {
  return `${lockPath}.retired.${directoryLockTokenKey(token)}`;
}

function retireDirectoryLock(lockPath: string, observedToken: string): boolean {
  const retired = retiredDirectoryLockPath(lockPath, observedToken);
  try {
    renameSync(lockPath, retired);
  } catch (error) {
    if (
      hasErrorCode(error, "ENOENT") ||
      hasErrorCode(error, "EEXIST") ||
      hasErrorCode(error, "ENOTEMPTY")
    ) {
      return false;
    }
    throw error;
  }
  fsyncDirectorySync(resolve(lockPath, ".."));
  return true;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}
