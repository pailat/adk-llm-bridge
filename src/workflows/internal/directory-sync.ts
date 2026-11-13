/**
 * Flushing a directory entry change (a create, rename or delete) to disk, the
 * one implementation every file-system store uses. Not exported from any
 * public barrel.
 *
 * @remarks
 * Both forms open the directory read-only, flush it and close it. Windows
 * cannot flush a directory: it opens one read-only only, and refuses the flush
 * on such a handle (`EPERM`). NTFS journals the entry change itself, so after
 * a crash a rename is there whole or not at all, but one that already returned
 * may be lost to a power failure right after it. Only on Windows (`win32`),
 * `EPERM`, `EISDIR` or `EINVAL` from the open or the flush is taken as that
 * limitation and the call returns. On every other platform any error is
 * thrown: a store that cannot make a rename durable there fails instead of
 * claiming it did. File contents are flushed on every platform; that is the
 * callers' file handle, not this module.
 */

import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import { hasErrorCode } from "./guards.js";

/** Codes with which Windows refuses to open or flush a directory. */
const WINDOWS_DIRECTORY_FLUSH_UNSUPPORTED = ["EPERM", "EISDIR", "EINVAL"];

function cannotFlushDirectory(error: unknown): boolean {
  return (
    process.platform === "win32" &&
    WINDOWS_DIRECTORY_FLUSH_UNSUPPORTED.some((code) =>
      hasErrorCode(error, code),
    )
  );
}

/**
 * Flushes a directory entry change to disk.
 *
 * @param directory - Directory whose entries changed.
 * @throws The file-system error, unchanged. On Windows only, `EPERM`,
 * `EISDIR` and `EINVAL` are not thrown: the platform cannot flush a directory.
 * @internal
 */
export function fsyncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!cannotFlushDirectory(error)) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Asynchronous form of {@link fsyncDirectorySync}, with the same contract.
 *
 * @param directory - Directory whose entries changed.
 * @throws The file-system error, unchanged. On Windows only, `EPERM`,
 * `EISDIR` and `EINVAL` are not thrown: the platform cannot flush a directory.
 * @internal
 */
export async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!cannotFlushDirectory(error)) throw error;
  } finally {
    await handle?.close();
  }
}
