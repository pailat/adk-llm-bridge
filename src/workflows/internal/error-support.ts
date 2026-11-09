/**
 * Internal helpers shared by workflow stores and drivers. Not exported from
 * any public barrel.
 */

/**
 * Conservative liveness probe: only `ESRCH` proves the process is gone. Any
 * other failure (including `EPERM` and unknown errors) is treated as alive so
 * a lock is never stolen from a process that might still own it.
 *
 * @internal
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
 *
 * @internal
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
 *
 * @internal
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

/**
 * Per-domain limits for {@link normalizeHostError}.
 *
 * @internal
 */
export interface HostErrorNormalization {
  /** Code used when the error has no acceptable `code`. */
  fallbackCode: string;
  /** Message used when the error has no acceptable `message`. */
  fallbackMessage: string;
  /**
   * Longer codes are cut (never inside a surrogate pair), or rejected when
   * `codePattern` is set.
   */
  maxCodeLength: number;
  /** Longer messages are cut to this length, never inside a surrogate pair. */
  maxMessageLength: number;
  /** When set, a `code` that does not match falls back to `fallbackCode`. */
  codePattern?: RegExp;
  /** When true, a thrown string becomes the message. */
  stringAsMessage?: boolean;
  /**
   * Converts the error's `details`; return `undefined` to omit them. A throw
   * also omits them.
   */
  details?: (value: unknown) => Readonly<Record<string, unknown>> | undefined;
}

/**
 * JSON-safe projection of a host error.
 *
 * @internal
 */
export interface NormalizedHostError {
  /** Accepted error code, or the fallback. */
  code: string;
  /** Accepted, length-limited message, or the fallback. */
  message: string;
  /** Converted details; omitted when absent or invalid. */
  details?: Readonly<Record<string, unknown>>;
}

/**
 * Projects a thrown value onto a durable code, message and optional details.
 *
 * @remarks
 * Never throws for the error itself: each field is read in its own guard, so
 * a throwing getter or a Proxy trap only drops that field.
 *
 * @param error - Value thrown by host code.
 * @param options - Limits and fallbacks of the calling domain.
 * @returns A new, unfrozen object; callers freeze or copy it.
 * @internal
 */
export function normalizeHostError(
  error: unknown,
  options: HostErrorNormalization,
): NormalizedHostError {
  let code = options.fallbackCode;
  let message = options.fallbackMessage;
  let details: Readonly<Record<string, unknown>> | undefined;
  if (typeof error === "string") {
    if (options.stringAsMessage && error.trim()) {
      message = cutText(error, options.maxMessageLength);
    }
    return { code, message };
  }
  if (error === null || typeof error !== "object") return { code, message };
  const rawCode = guardedRead(error, "code");
  if (typeof rawCode === "string" && rawCode.trim()) {
    if (options.codePattern) {
      if (
        rawCode.length <= options.maxCodeLength &&
        options.codePattern.test(rawCode)
      ) {
        code = rawCode;
      }
    } else {
      code = cutText(rawCode, options.maxCodeLength);
    }
  }
  const rawMessage = guardedRead(error, "message");
  if (typeof rawMessage === "string" && rawMessage.trim()) {
    message = cutText(rawMessage, options.maxMessageLength);
  }
  if (options.details) {
    const rawDetails = guardedRead(error, "details");
    if (rawDetails !== undefined) {
      try {
        details = options.details(rawDetails);
      } catch {
        // Invalid details are omitted from durable state.
      }
    }
  }
  return details === undefined ? { code, message } : { code, message, details };
}

/**
 * Cuts `text` to at most `maxLength` UTF-16 code units without splitting a
 * surrogate pair, so the result stays well-formed.
 */
function cutText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = maxLength;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

function guardedRead(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // Host error accessors are not trusted.
    return undefined;
  }
}
