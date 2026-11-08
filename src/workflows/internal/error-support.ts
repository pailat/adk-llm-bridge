/**
 * Internal helpers shared by workflow stores and drivers. Not exported from
 * any public barrel.
 */

/**
 * Conservative liveness probe: only `ESRCH` proves the process is gone. Any
 * other failure (including `EPERM` and unknown errors) is treated as alive so
 * a lock is never stolen from a process that might still own it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      !(typeof error === "object" && error !== null && "code" in error) ||
      (error as { code?: unknown }).code !== "ESRCH"
    );
  }
}

/**
 * Attaches the original failure as a non-enumerable `cause`, leaving
 * `message`, `details` and `toJSON()` untouched.
 */
export function attachCause<T extends Error>(error: T, cause: unknown): T {
  try {
    Object.defineProperty(error, "cause", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: cause,
    });
  } catch {
    // Preserve the wrapped error even when it is non-extensible.
  }
  return error;
}

/**
 * Attaches cleanup failures to a primary error as a non-enumerable
 * `cleanupErrors` array. No-op for non-Error primaries or empty lists.
 */
export function attachCleanupErrors(
  primary: unknown,
  cleanupErrors: readonly unknown[],
): void {
  if (cleanupErrors.length === 0 || !(primary instanceof Error)) return;
  try {
    Object.defineProperty(primary, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: Object.freeze([...cleanupErrors]),
    });
  } catch {
    // Preserve the primary error even when it is non-extensible.
  }
}
