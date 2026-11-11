/**
 * Renames that wait out a Windows open file. Not exported from any public
 * barrel.
 *
 * @remarks
 * On Windows a rename fails with `EPERM`, `EBUSY` or `EACCES` while another
 * process (a reader, or a saver replacing the same file) holds the destination
 * or the source open. The block lasts as long as that handle, which is short.
 * So the rename is retried with a time budget and jittered exponential
 * backoff, not a fixed count: many waiters polling a lock can outlast a few
 * fixed tries, and the jitter keeps them from retrying in step. Any other
 * error is thrown at once, and POSIX never reaches the retry in the normal
 * path.
 */

import { renameSync } from "node:fs";
import { rename as renameAsync } from "node:fs/promises";
import { hasErrorCode } from "./guards.js";
import { monotonicNow } from "./monotonic-clock.js";

/**
 * How long a blocked rename keeps retrying. A handle that outlasts this is not
 * a transient read: the rename then fails with its own error. Five seconds is
 * far above one read of a checkpoint or owner file, and still a bounded stall
 * for a caller that holds a lock.
 */
export const BLOCKED_RENAME_BUDGET_MS = 5_000;

/** The first pause, before jitter. Each later pause doubles. */
const BACKOFF_BASE_MS = 5;
/** No pause grows past this, so a long budget is still polled often. */
const BACKOFF_CAP_MS = 250;

/** Knobs for tests; the defaults are the production policy. */
export interface BlockedRenameOptions {
  /** Total time to keep retrying. */
  budgetMs?: number;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
  /** A random number in [0, 1). */
  random?: () => number;
  /** Waits `ms` milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits `ms` milliseconds, blocking the thread. */
  sleepSync?: (ms: number) => void;
}

/**
 * Whether a rename failed because another process holds a file open.
 *
 * @param error - The rename's error.
 * @returns True for `EPERM`, `EBUSY` and `EACCES`.
 */
export function isBlockedRename(error: unknown): boolean {
  return (
    hasErrorCode(error, "EPERM") ||
    hasErrorCode(error, "EBUSY") ||
    hasErrorCode(error, "EACCES")
  );
}

/**
 * The pause before retry number `retry` (1-based): full jitter over an
 * exponential ceiling, never under 1 ms and never past the time left.
 *
 * @param retry - How many attempts have failed so far.
 * @param remainingMs - Budget left.
 * @param random - A random number in [0, 1).
 * @returns Milliseconds to wait.
 */
export function blockedRenamePause(
  retry: number,
  remainingMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (retry - 1));
  const pause = Math.max(1, Math.ceil(random() * ceiling));
  return Math.max(1, Math.min(pause, Math.ceil(remainingMs)));
}

/**
 * Renames, waiting out a Windows open file within a time budget.
 *
 * @param from - Path to rename.
 * @param to - New path.
 * @param renamePath - The rename to run; the file system's by default.
 * @param options - Budget, clock and sleep, for tests.
 * @throws The rename's error when it is not a blocked rename, or when the
 * rename is still blocked once the budget is spent.
 */
export async function renameRetryingBlocked(
  from: string,
  to: string,
  renamePath: (from: string, to: string) => Promise<void> = renameAsync,
  options: BlockedRenameOptions = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? BLOCKED_RENAME_BUDGET_MS;
  const now = options.now ?? monotonicNow;
  const random = options.random ?? Math.random;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const startedAt = now();
  for (let retry = 1; ; retry += 1) {
    try {
      await renamePath(from, to);
      return;
    } catch (error) {
      const remaining = budgetMs - (now() - startedAt);
      if (!isBlockedRename(error) || remaining <= 0) {
        throw error;
      }
      await sleep(blockedRenamePause(retry, remaining, random));
    }
  }
}

/**
 * Synchronous {@link renameRetryingBlocked}, for the stores that commit
 * synchronously. It blocks the thread while it waits: under contention on
 * Windows that is up to the budget, only when a rename is blocked.
 *
 * @param from - Path to rename.
 * @param to - New path.
 * @param renamePath - The rename to run; the file system's by default.
 * @param options - Budget, clock and sleep, for tests.
 * @throws The rename's error when it is not a blocked rename, or when the
 * rename is still blocked once the budget is spent.
 */
export function renameRetryingBlockedSync(
  from: string,
  to: string,
  renamePath: (from: string, to: string) => void = renameSync,
  options: BlockedRenameOptions = {},
): void {
  const budgetMs = options.budgetMs ?? BLOCKED_RENAME_BUDGET_MS;
  const now = options.now ?? monotonicNow;
  const random = options.random ?? Math.random;
  const sleepSync =
    options.sleepSync ??
    ((ms: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    });
  const startedAt = now();
  for (let retry = 1; ; retry += 1) {
    try {
      renamePath(from, to);
      return;
    } catch (error) {
      const remaining = budgetMs - (now() - startedAt);
      if (!isBlockedRename(error) || remaining <= 0) {
        throw error;
      }
      sleepSync(blockedRenamePause(retry, remaining, random));
    }
  }
}
