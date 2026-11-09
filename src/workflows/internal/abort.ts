/**
 * Throws when the signal has aborted.
 *
 * @param signal - Optional abort signal.
 * @param message - Message of the `Error` thrown when the signal has no reason.
 * @throws The signal's reason, or an `Error` with `message` when it has none.
 * @internal
 */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  message = "Workflow operation aborted",
): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error(message);
}
