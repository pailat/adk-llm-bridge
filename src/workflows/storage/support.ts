import { type Histogram, metrics } from "@opentelemetry/api";
import type { BaseWorkflowCheckpointStore } from "./checkpoint-store.js";
import { WorkflowStorageError } from "./errors.js";

/**
 * A JSON-safe value: what `JSON.parse(JSON.stringify(value))` returns
 * unchanged.
 *
 * @experimental
 */
export type WorkflowStorageJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkflowStorageJsonValue[]
  | { readonly [key: string]: WorkflowStorageJsonValue };

/**
 * A JSON-safe object.
 *
 * @experimental
 */
export type WorkflowStorageJsonObject = {
  readonly [key: string]: WorkflowStorageJsonValue;
};

/**
 * Storage capability a provider serves.
 *
 * @experimental
 */
export type WorkflowStorageCapability = "checkpoints" | "events";

/**
 * Result of a provider health check.
 *
 * @experimental
 */
export interface WorkflowStorageHealth {
  /** Whether the backend answered a read and accepts writes. */
  ok: boolean;
  /** Provider name, for example `sqlite`. */
  provider: string;
  /** Time the check took, in milliseconds. */
  latencyMs: number;
  /** Schema version found in storage, when the provider keeps one. */
  schemaVersion?: number;
  /** Failure code when `ok` is `false`. */
  code?: string;
  /** Failure description when `ok` is `false`. It holds no payloads. */
  message?: string;
}

/**
 * One finished storage operation, as reported to metrics.
 *
 * @remarks
 * It carries sizes and timings only: never ids, keys, payloads or URIs.
 *
 * @experimental
 */
export interface WorkflowStorageOperationMetric {
  /** Capability the operation belongs to. */
  capability: WorkflowStorageCapability;
  /** Provider name, for example `memory`, `file`, `sqlite`, `adk-session`. */
  provider: string;
  /** Operation name, for example `save`, `load`, `append`, `read`. */
  operation: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** How the operation ended. */
  outcome: "ok" | "conflict" | "error";
  /** Serialized size in bytes of the data written or read, when known. */
  bytes?: number;
  /** Number of records written or read, when the operation is a batch. */
  records?: number;
  /** Error code when `outcome` is `error`. */
  errorCode?: string;
}

/**
 * Receives each {@link WorkflowStorageOperationMetric} of a provider.
 *
 * @remarks
 * A throwing observer is ignored: it never fails the storage operation.
 *
 * @experimental
 */
export type WorkflowStorageMetricsObserver = (
  metric: WorkflowStorageOperationMetric,
) => void;

/** Name of the OpenTelemetry histogram of storage operation durations, in milliseconds. */
export const WORKFLOW_STORAGE_DURATION_METRIC =
  "adk_llm_bridge.workflow.storage.operation.duration";
/** Name of the OpenTelemetry histogram of storage operation sizes, in bytes. */
export const WORKFLOW_STORAGE_SIZE_METRIC =
  "adk_llm_bridge.workflow.storage.operation.size";

/**
 * Reports a finished operation to the OpenTelemetry meter `adk-llm-bridge`
 * and to the provider's observer.
 *
 * @remarks
 * Histogram attributes are `capability`, `provider`, `operation`, `outcome`
 * and `error.type`. With no meter provider registered the OpenTelemetry API
 * records nothing.
 *
 * @param metric - The finished operation.
 * @param observer - Optional observer of the provider.
 * @internal
 */
export function recordWorkflowStorageOperation(
  metric: WorkflowStorageOperationMetric,
  observer?: WorkflowStorageMetricsObserver,
): void {
  try {
    const { duration, size } = storageHistograms();
    const attributes: Record<string, string> = {
      capability: metric.capability,
      provider: metric.provider,
      operation: metric.operation,
      outcome: metric.outcome,
    };
    if (metric.errorCode !== undefined) {
      attributes["error.type"] = metric.errorCode;
    }
    duration.record(metric.durationMs, attributes);
    if (metric.bytes !== undefined) size.record(metric.bytes, attributes);
  } catch {
    // Metrics never fail a storage operation.
  }
  if (!observer) return;
  try {
    observer(metric);
  } catch {
    // A throwing observer is ignored.
  }
}

interface StorageHistograms {
  duration: Histogram;
  size: Histogram;
}

let histograms: (StorageHistograms & { provider: unknown }) | undefined;

function storageHistograms(): StorageHistograms {
  // The instruments belong to the meter provider that created them, so they
  // are made again when the host registers a different provider.
  const provider = metrics.getMeterProvider();
  if (!histograms || histograms.provider !== provider) {
    const meter = provider.getMeter("adk-llm-bridge");
    histograms = {
      provider,
      duration: meter.createHistogram(WORKFLOW_STORAGE_DURATION_METRIC, {
        description: "Duration of workflow storage operations",
        unit: "ms",
      }),
      size: meter.createHistogram(WORKFLOW_STORAGE_SIZE_METRIC, {
        description: "Serialized size of data moved by workflow storage",
        unit: "By",
      }),
    };
  }
  return histograms;
}

/**
 * Retry rules for transient storage failures.
 *
 * @experimental
 */
export interface WorkflowStorageRetryPolicy {
  /**
   * Total number of tries, the first one included.
   *
   * @defaultValue 4
   */
  maxAttempts?: number;
  /**
   * Delay before the second try, in milliseconds. Each later delay doubles.
   *
   * @defaultValue 50
   */
  initialDelayMs?: number;
  /**
   * Upper bound of one delay, in milliseconds.
   *
   * @defaultValue 2000
   */
  maxDelayMs?: number;
  /**
   * Fraction of each delay that is randomized, from 0 to 1.
   *
   * @defaultValue 0.2
   */
  jitter?: number;
}

/** Options of {@link retryWorkflowStorageOperation}. */
export interface RetryWorkflowStorageOperationOptions
  extends WorkflowStorageRetryPolicy {
  /** Stops waiting between tries; the pending error is thrown. */
  signal?: AbortSignal;
  /**
   * Time limit of one try, in milliseconds. A try that exceeds it fails with
   * `WORKFLOW_STORAGE_TIMEOUT`.
   */
  attemptTimeoutMs?: number;
}

/**
 * Runs a storage operation, repeating it with exponential backoff while it
 * fails with a retryable {@link WorkflowStorageError}.
 *
 * @remarks
 * Only errors whose `retryable` is `true` are retried. Every other error,
 * and a compare-and-set conflict, is thrown at once. The operation must be
 * idempotent: a timed-out write may have been applied.
 *
 * @param operation - The operation; it receives the one-based attempt number.
 * @param options - Retry policy, abort signal and per-try time limit.
 * @returns The value of the first successful try.
 * @throws {@link WorkflowStorageError} of the last try when every try failed.
 *
 * @experimental
 */
export async function retryWorkflowStorageOperation<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryWorkflowStorageOperationOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const initialDelayMs = options.initialDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const jitter = options.jitter ?? 0.2;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runWithTimeout(
        () => operation(attempt),
        options.attemptTimeoutMs,
      );
    } catch (error) {
      if (
        !isRetryable(error) ||
        attempt >= maxAttempts ||
        options.signal?.aborted
      ) {
        throw error;
      }
      const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      const delay = base * (1 - jitter * Math.random());
      const completed = await sleep(delay, options.signal);
      if (!completed) throw error;
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof WorkflowStorageError && error.retryable;
}

function runWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new WorkflowStorageError(
          "WORKFLOW_STORAGE_TIMEOUT",
          `Storage operation exceeded ${timeoutMs} ms`,
          { details: { timeoutMs } },
        ),
      );
    }, timeoutMs);
    let promise: Promise<T>;
    try {
      promise = run();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Resolves `true` after `ms`, or `false` as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Refuses a checkpoint provider that does not declare the capability a
 * caller needs.
 *
 * @remarks
 * Today the only capability is `compareAndSet`: the provider must declare
 * `"atomic"`. An advisory provider is refused before anything is written, so
 * it is never used silently where a revision race would corrupt state.
 *
 * @param store - The provider to check.
 * @param capability - The capability the caller requires.
 * @throws {@link WorkflowStorageError} with code
 * `WORKFLOW_STORAGE_UNSUPPORTED` and a `capability` field when the provider
 * does not declare it.
 *
 * @experimental
 */
export function requireWorkflowCheckpointCapability(
  store: Pick<BaseWorkflowCheckpointStore, "providerName" | "capabilities">,
  capability: "compareAndSet",
): void {
  if (store.capabilities[capability] === "atomic") return;
  throw new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNSUPPORTED",
    `The ${store.providerName} checkpoint provider does not declare ${capability} "atomic", which this use requires`,
    {
      capability,
      details: {
        provider: store.providerName,
        capability,
        declared: store.capabilities[capability],
      },
    },
  );
}
