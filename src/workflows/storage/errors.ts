/**
 * Codes of {@link WorkflowStorageError}.
 *
 * @remarks
 * - `WORKFLOW_STORAGE_UNKNOWN_SCHEME`: no provider is registered for the URI
 *   scheme.
 * - `WORKFLOW_STORAGE_INVALID_URI`: the URI cannot be parsed, or the provider
 *   rejects its path or parameters.
 * - `WORKFLOW_STORAGE_DRIVER_MISSING`: the provider needs a runtime module or
 *   an optional peer package that is not available (`details.driver` names
 *   it).
 * - `WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED`: a scheme was registered
 *   twice without `replace: true`.
 * - `WORKFLOW_STORAGE_INVALID_OPTION`: a provider option is out of range.
 * - `WORKFLOW_STORAGE_UNSUPPORTED`: the provider does not implement the
 *   operation; its capability flag is `false`.
 * - `WORKFLOW_STORAGE_UNAVAILABLE`: a transient backend failure (a busy
 *   database, a dropped connection). Retryable.
 * - `WORKFLOW_STORAGE_TIMEOUT`: an operation exceeded its time limit. The
 *   write may or may not have been applied. Retryable.
 * - `WORKFLOW_STORAGE_CORRUPT`: stored data failed an integrity check.
 * - `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED`: the stored data was written by a
 *   newer version of the provider.
 * - `WORKFLOW_STORAGE_UNSAFE_PATH`: a storage path is a symbolic link or not a
 *   regular file.
 * - `WORKFLOW_STORAGE_LEASE_HELD`: another owner holds an unexpired lease.
 * - `WORKFLOW_STORAGE_LEASE_LOST`: the lease or fencing token of the caller is
 *   no longer the current one; the write was not applied.
 * - `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`: a record exceeds the provider limit
 *   after clipping.
 * - `WORKFLOW_STORAGE_INVALID_RECORD`: a record is not JSON-safe or lacks a
 *   required field.
 * - `WORKFLOW_STORAGE_CLOSED`: the provider was used after `close()`.
 *
 * @experimental
 */
export type WorkflowStorageErrorCode =
  | "WORKFLOW_STORAGE_UNKNOWN_SCHEME"
  | "WORKFLOW_STORAGE_INVALID_URI"
  | "WORKFLOW_STORAGE_DRIVER_MISSING"
  | "WORKFLOW_STORAGE_SCHEME_ALREADY_REGISTERED"
  | "WORKFLOW_STORAGE_INVALID_OPTION"
  | "WORKFLOW_STORAGE_UNSUPPORTED"
  | "WORKFLOW_STORAGE_UNAVAILABLE"
  | "WORKFLOW_STORAGE_TIMEOUT"
  | "WORKFLOW_STORAGE_CORRUPT"
  | "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED"
  | "WORKFLOW_STORAGE_UNSAFE_PATH"
  | "WORKFLOW_STORAGE_LEASE_HELD"
  | "WORKFLOW_STORAGE_LEASE_LOST"
  | "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE"
  | "WORKFLOW_STORAGE_INVALID_RECORD"
  | "WORKFLOW_STORAGE_CLOSED";

const RETRYABLE_CODES: ReadonlySet<WorkflowStorageErrorCode> = new Set([
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_STORAGE_TIMEOUT",
]);

/** Extra fields of {@link WorkflowStorageError}. */
export interface WorkflowStorageErrorOptions {
  /** JSON-safe context. It never holds payloads or credentials. */
  details?: Readonly<Record<string, unknown>>;
  /** The underlying error. */
  cause?: unknown;
  /**
   * Overrides whether a retry can succeed.
   *
   * @defaultValue `true` for `WORKFLOW_STORAGE_UNAVAILABLE` and
   * `WORKFLOW_STORAGE_TIMEOUT`, `false` for every other code.
   */
  retryable?: boolean;
  /** Capability the failure concerns, for example `compareAndSet`. */
  capability?: string;
}

/**
 * Error raised by workflow storage providers and by the storage registry,
 * discriminated by {@link WorkflowStorageErrorCode}.
 *
 * @remarks
 * A compare-and-set conflict is not a storage error: providers throw
 * `WorkflowCheckpointConflictError` for it, as the file-system store does.
 *
 * @experimental
 */
export class WorkflowStorageError extends Error {
  /** Machine-readable failure code. */
  readonly code: WorkflowStorageErrorCode;
  /** Whether repeating the same call can succeed. */
  readonly retryable: boolean;
  /** JSON-safe context, without payloads or credentials. */
  readonly details: Readonly<Record<string, unknown>>;
  /** Capability the failure concerns, when it is a capability refusal. */
  readonly capability?: string;

  /**
   * Creates a storage error.
   *
   * @param code - Failure code.
   * @param message - Human-readable description.
   * @param options - Details, cause and retry override.
   */
  constructor(
    code: WorkflowStorageErrorCode,
    message: string,
    options: WorkflowStorageErrorOptions = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "WorkflowStorageError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.details = Object.freeze({ ...options.details });
    if (options.capability !== undefined) this.capability = options.capability;
  }
}

/**
 * Type guard for {@link WorkflowStorageError}.
 *
 * @param value - Value to test.
 * @param code - When given, the error must also carry this code.
 * @returns `true` when `value` is a storage error (with `code`, if given).
 *
 * @experimental
 */
export function isWorkflowStorageError(
  value: unknown,
  code?: WorkflowStorageErrorCode,
): value is WorkflowStorageError {
  return (
    value instanceof WorkflowStorageError &&
    (code === undefined || value.code === code)
  );
}

/**
 * Builds the error a stub throws until its lane implements it.
 *
 * @param symbol - Name of the class or function.
 * @returns An error whose message names the missing implementation.
 * @internal
 */
export function workflowStorageNotImplemented(symbol: string): Error {
  return new Error(`adk-llm-bridge: ${symbol} is not implemented yet`);
}
