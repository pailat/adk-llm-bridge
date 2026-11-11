import { isWorkflowStorageError, WorkflowStorageError } from "./errors.js";
import {
  recordWorkflowStorageOperation,
  type WorkflowStorageHealth,
  type WorkflowStorageJsonObject,
  type WorkflowStorageMetricsObserver,
  type WorkflowStorageOperationMetric,
} from "./support.js";

/**
 * Version of the event exporter contract that
 * {@link BaseWorkflowEventExporter} implements.
 *
 * @experimental
 */
export const WORKFLOW_EVENT_EXPORTER_CONTRACT_VERSION = 1;

/** Default largest serialized size of one exported record: 256 KiB. */
export const DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES = 256 * 1024;
/** Largest number of records one `append` call accepts. */
export const MAX_WORKFLOW_EVENT_APPEND_BATCH = 1_000;
/** Default page size of {@link BaseWorkflowEventExporter.read}. */
export const DEFAULT_WORKFLOW_EVENT_RECORD_READ_LIMIT = 100;
/** Largest page size of {@link BaseWorkflowEventExporter.read}. */
export const MAX_WORKFLOW_EVENT_RECORD_READ_LIMIT = 1_000;
/** Largest length of a record id, an execution id or a `type`, in characters. */
export const MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH = 256;

/**
 * What an exported record describes.
 *
 * - `workflow`: a workflow lifecycle event (`workflow_started`,
 *   `workflow_waiting`, `workflow_completed`, `output`, `error`,
 *   `checkpoint_saved`, `custom`).
 * - `step`: a step event (`step_started`, `step_completed`, `step_failed`,
 *   `step_interrupted`, `step_replayed`, `step_waiting`).
 * - `agent_run`: an event of an agent run inside or outside a step: the
 *   external agent events (`started`, `output`, `tool_call`, `tool_result`,
 *   `state_delta`, `error`, `completed`) and `adk_event` for any other ADK
 *   event.
 * - `span`: one finished OpenTelemetry span (`type` is `span`).
 * - `warning`: a notice from the export pipeline itself, for example
 *   `WORKFLOW_EVENT_EXPORT_DROPPED`.
 *
 * @experimental
 */
export type WorkflowEventRecordKind =
  | "workflow"
  | "step"
  | "agent_run"
  | "span"
  | "warning";

/**
 * Where the full payload of a clipped record was stored.
 *
 * @experimental
 */
export interface WorkflowEventPayloadReference {
  /** Kind of storage, for example `adk-artifact`. */
  store: string;
  /** Opaque locator inside that storage, for example an artifact file name. */
  key: string;
  /** Version in that storage, when it keeps versions. */
  version?: number;
}

/**
 * How a record was shortened to fit the size limit.
 *
 * @experimental
 */
export interface WorkflowEventRecordClipping {
  /** Serialized size of the payload before clipping, in bytes. */
  originalBytes: number;
  /** SHA-256 (hex) of the serialized payload before clipping. */
  sha256: string;
  /**
   * JSON pointers of the strings that were shortened. Empty when the whole
   * payload was replaced.
   */
  paths: readonly string[];
  /** `true` when the payload was replaced by `{}` because shortening strings was not enough. */
  payloadDropped: boolean;
  /** Where the full payload was stored, when an overflow handler stored it. */
  reference?: WorkflowEventPayloadReference;
}

/**
 * One record handed to an exporter. Every field is JSON-safe.
 *
 * @experimental
 */
export interface WorkflowEventRecordInput {
  /**
   * Idempotency key, unique within the execution: the ADK event id for event
   * records, `span:` plus the span id for spans. Appending an id the
   * execution already holds stores nothing.
   */
  id: string;
  /**
   * Execution the record belongs to. A record made outside a workflow
   * execution uses `invocation:` plus the ADK invocation id, or `trace:`
   * plus the trace id.
   */
  executionId: string;
  /** What the record describes. */
  kind: WorkflowEventRecordKind;
  /** Event type within the kind, for example `step_completed`. */
  type: string;
  /** Epoch milliseconds of the event; for a span, its end time. */
  timestamp: number;
  /** Workflow definition id, when known. */
  workflowId?: string;
  /** Step id, for step records and for agent runs inside a step. */
  stepId?: string;
  /** One-based attempt number of the step, when known. */
  attempt?: number;
  /** Name of the agent that produced the event. */
  agentName?: string;
  /** ADK invocation id. */
  invocationId?: string;
  /** OpenTelemetry trace id, for spans. */
  traceId?: string;
  /** OpenTelemetry span id, for spans. */
  spanId?: string;
  /** Parent span id, for spans that have one. */
  parentSpanId?: string;
  /** The event itself, clipped to the size limit. */
  payload: WorkflowStorageJsonObject;
  /** Present when the payload was shortened. */
  clipped?: WorkflowEventRecordClipping;
}

/**
 * A stored record: the input plus the sequence the exporter assigned.
 *
 * @experimental
 */
export interface WorkflowEventRecord extends WorkflowEventRecordInput {
  /**
   * Position in the execution's log: the first record is 1 and each new
   * record is one more than the last, with no gaps and no repeats.
   */
  sequence: number;
}

/**
 * What an event exporter guarantees.
 *
 * @experimental
 */
export interface WorkflowEventExporterCapabilities {
  /** Whether an appended record survives the end of the process. */
  durable: boolean;
  /** Whether writers in several processes can append to one execution. */
  multiProcess: boolean;
  /** Whether {@link BaseWorkflowEventExporter.listExecutions} is implemented. */
  listing: boolean;
  /** Whether {@link BaseWorkflowEventExporter.prune} is implemented. */
  pruning: boolean;
  /** Largest serialized size of one record the exporter stores, in bytes. */
  maxRecordBytes: number;
}

/**
 * Options shared by every {@link BaseWorkflowEventExporter}.
 *
 * @experimental
 */
export interface BaseWorkflowEventExporterOptions {
  /**
   * Largest serialized size of one record, in bytes. A larger record is
   * rejected with `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`; the export pipeline
   * clips records before they reach the exporter.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES}
   */
  maxRecordBytes?: number;
  /** Receives one metric per finished operation, without payloads. */
  onOperation?: WorkflowStorageMetricsObserver;
}

/**
 * Input of {@link BaseWorkflowEventExporter.append}.
 *
 * @experimental
 */
export interface AppendWorkflowEventRecordsInput {
  /** Execution every record of the batch belongs to. */
  executionId: string;
  /** Records in the order they happened; at most {@link MAX_WORKFLOW_EVENT_APPEND_BATCH}. */
  records: readonly WorkflowEventRecordInput[];
}

/**
 * Result of {@link BaseWorkflowEventExporter.append}.
 *
 * @experimental
 */
export interface AppendWorkflowEventRecordsResult {
  /** One entry per input record, in input order. */
  records: ReadonlyArray<{
    /** Id of the record. */
    id: string;
    /** Sequence the record has in storage. */
    sequence: number;
    /** `true` when the id was already stored and nothing was written. */
    duplicate: boolean;
  }>;
  /** Highest sequence of the execution after the call. */
  lastSequence: number;
}

/**
 * Input of {@link BaseWorkflowEventExporter.read}.
 *
 * @experimental
 */
export interface ReadWorkflowEventRecordsInput {
  /** Execution whose records are read. */
  executionId: string;
  /**
   * Cursor: return records with a higher sequence.
   *
   * @defaultValue 0
   */
  afterSequence?: number;
  /**
   * Page size, from 1 to {@link MAX_WORKFLOW_EVENT_RECORD_READ_LIMIT}.
   *
   * @defaultValue {@link DEFAULT_WORKFLOW_EVENT_RECORD_READ_LIMIT}
   */
  limit?: number;
  /** Return only records of these kinds. */
  kinds?: readonly WorkflowEventRecordKind[];
  /** Return only records of these types. */
  types?: readonly string[];
}

/**
 * One page of {@link BaseWorkflowEventExporter.read}.
 *
 * @experimental
 */
export interface ReadWorkflowEventRecordsResult {
  /** Records in ascending sequence. */
  records: readonly WorkflowEventRecord[];
  /** Value to pass as `afterSequence` for the next page. */
  nextAfterSequence: number;
  /** Whether matching records exist beyond this page. */
  hasMore: boolean;
}

/**
 * One row of {@link BaseWorkflowEventExporter.listExecutions}.
 *
 * @experimental
 */
export interface WorkflowEventExecutionSummary {
  /** Execution id. */
  executionId: string;
  /** Number of records stored, which is also the highest sequence. */
  lastSequence: number;
  /** Timestamp of the first record, in epoch milliseconds. */
  firstTimestamp: number;
  /** Timestamp of the newest record, in epoch milliseconds. */
  lastTimestamp: number;
}

/**
 * Input of {@link BaseWorkflowEventExporter.listExecutions}.
 *
 * @experimental
 */
export interface ListWorkflowEventExecutionsInput {
  /** Opaque cursor from the `nextCursor` of the previous page. */
  cursor?: string;
  /**
   * Page size, from 1 to 500.
   *
   * @defaultValue 50
   */
  limit?: number;
}

/**
 * One page of {@link BaseWorkflowEventExporter.listExecutions}.
 *
 * @experimental
 */
export interface ListWorkflowEventExecutionsResult {
  /** Summaries ordered by execution id. */
  items: readonly WorkflowEventExecutionSummary[];
  /** Cursor of the next page; absent on the last page. */
  nextCursor?: string;
}

/**
 * Input of {@link BaseWorkflowEventExporter.prune}: one execution, or every
 * execution whose newest record is older than a time.
 *
 * @experimental
 */
export type PruneWorkflowEventRecordsInput =
  | {
      /** Delete every record of this execution. */
      executionId: string;
    }
  | {
      /** Delete executions whose newest record is before this time (epoch milliseconds). */
      lastRecordBefore: number;
      /**
       * Largest number of executions one call deletes.
       *
       * @defaultValue 500
       */
      limit?: number;
    };

/**
 * Result of {@link BaseWorkflowEventExporter.prune}.
 *
 * @experimental
 */
export interface PruneWorkflowEventRecordsResult {
  /** Number of executions whose records were deleted. */
  executions: number;
  /** Number of records deleted. */
  records: number;
  /** Whether more matching executions remain; call again to continue. */
  hasMore: boolean;
}

/**
 * Abstract contract of a workflow event exporter: the provider a host
 * injects into `WorkflowEventExportPlugin` or `WorkflowEventExportPipeline`
 * to receive workflow, step, agent-run and span records.
 *
 * @remarks
 * Guarantees every exporter gives, each one a test of the conformance suite:
 *
 * - Append-only: a stored record never changes; only `prune` removes
 *   records, and only whole executions.
 * - Sequence: the exporter assigns each new record the next sequence of its
 *   execution inside the append, starting at 1, with no gaps and no repeats,
 *   also when several writers append (with `multiProcess: true`, from
 *   several processes).
 * - Idempotency: appending an id the execution already holds writes
 *   nothing and reports the stored sequence with `duplicate: true`, so a
 *   batch can be retried after a timeout.
 * - Atomic batch: either every new record of an `append` is stored, in
 *   input order, or none is.
 * - Bounded records: a record larger than `maxRecordBytes` is rejected with
 *   `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE` and nothing of the batch is stored.
 * - Ordered reads: `read` returns ascending sequence from a cursor.
 *
 * The public methods validate and report metrics once for every exporter; an
 * exporter implements the protected storage primitives.
 *
 * @experimental
 */
export abstract class BaseWorkflowEventExporter {
  /** Contract version this exporter was written against. */
  readonly contractVersion: number = WORKFLOW_EVENT_EXPORTER_CONTRACT_VERSION;
  /** Short provider name used in metrics and health results, for example `jsonl`. */
  abstract readonly providerName: string;
  /** What this exporter guarantees. */
  abstract readonly capabilities: WorkflowEventExporterCapabilities;

  /** Options given to the constructor. */
  protected readonly baseOptions: BaseWorkflowEventExporterOptions;

  #closed = false;
  #closing: Promise<void> | undefined;

  /**
   * Stores the shared options.
   *
   * @param options - Record size limit and metrics observer.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_INVALID_OPTION` for a limit that is not a positive
   * safe integer.
   */
  constructor(options: BaseWorkflowEventExporterOptions = {}) {
    if (options.maxRecordBytes !== undefined) {
      positiveInteger("maxRecordBytes", options.maxRecordBytes);
    }
    this.baseOptions = options;
  }

  /**
   * Appends a batch of records to one execution.
   *
   * @param input - Execution id and records.
   * @returns The sequence of every record and whether it was a duplicate.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_INVALID_RECORD` (a record that is not JSON-safe, lacks
   * a field, or names another execution), `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`,
   * or a retryable `WORKFLOW_STORAGE_UNAVAILABLE`. Nothing is stored then.
   */
  async append(
    input: AppendWorkflowEventRecordsInput,
  ): Promise<AppendWorkflowEventRecordsResult> {
    let bytes = 0;
    let count = 0;
    return this.#measure(
      "append",
      async () => {
        this.#assertOpen();
        const { executionId, records } = input ?? {};
        if (!Array.isArray(records)) {
          throw invalidRecord("records must be an array");
        }
        count = records.length;
        identifier("executionId", executionId, "record");
        if (records.length > MAX_WORKFLOW_EVENT_APPEND_BATCH) {
          throw invalidRecord(
            `a batch holds at most ${MAX_WORKFLOW_EVENT_APPEND_BATCH} records`,
          );
        }
        const limit =
          this.baseOptions.maxRecordBytes ??
          this.capabilities.maxRecordBytes ??
          DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES;
        const ids = new Set<string>();
        for (const record of records) {
          bytes += validateWorkflowEventRecord(record, executionId, limit);
          if (ids.has(record.id)) {
            throw invalidRecord("a batch must not repeat a record id");
          }
          ids.add(record.id);
        }
        return await this.appendRecords(executionId, records);
      },
      () => ({ records: count, bytes }),
    );
  }

  /**
   * Reads one page of an execution's records after a cursor.
   *
   * @param input - Execution id, cursor, page size and filters.
   * @returns Records in ascending sequence and the next cursor.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_INVALID_OPTION` for a bad cursor or limit, or
   * `WORKFLOW_STORAGE_CORRUPT` when a stored record fails its check.
   */
  async read(
    input: ReadWorkflowEventRecordsInput,
  ): Promise<ReadWorkflowEventRecordsResult> {
    let records = 0;
    return this.#measure(
      "read",
      async () => {
        this.#assertOpen();
        const { executionId, afterSequence = 0, limit, kinds, types } = input;
        identifier("executionId", executionId, "option");
        if (
          typeof afterSequence !== "number" ||
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0
        ) {
          throw invalidOption(
            "afterSequence",
            "must be a non-negative safe integer",
          );
        }
        const pageLimit = limit ?? DEFAULT_WORKFLOW_EVENT_RECORD_READ_LIMIT;
        if (
          typeof pageLimit !== "number" ||
          !Number.isSafeInteger(pageLimit) ||
          pageLimit < 1 ||
          pageLimit > MAX_WORKFLOW_EVENT_RECORD_READ_LIMIT
        ) {
          throw invalidOption(
            "limit",
            `must be an integer from 1 to ${MAX_WORKFLOW_EVENT_RECORD_READ_LIMIT}`,
          );
        }
        if (
          kinds !== undefined &&
          (!Array.isArray(kinds) || kinds.some((kind) => !KINDS.has(kind)))
        ) {
          throw invalidOption("kinds", "must list known record kinds");
        }
        if (
          types !== undefined &&
          (!Array.isArray(types) || types.some((t) => typeof t !== "string"))
        ) {
          throw invalidOption("types", "must list strings");
        }
        const result = await this.readRecords({
          ...input,
          afterSequence,
          limit: pageLimit,
        });
        records = result.records.length;
        return result;
      },
      () => ({ records }),
    );
  }

  /**
   * Lists the executions that have records, one page at a time.
   *
   * @param input - Cursor and page size.
   * @returns A page and the cursor of the next one.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.listing` is `false`.
   */
  async listExecutions(
    input: ListWorkflowEventExecutionsInput = {},
  ): Promise<ListWorkflowEventExecutionsResult> {
    let records = 0;
    return this.#measure(
      "listExecutions",
      async () => {
        this.#assertOpen();
        this.#require("listing", "listExecutions");
        const { cursor, limit = DEFAULT_LIST_LIMIT } = input;
        if (cursor !== undefined && typeof cursor !== "string") {
          throw invalidOption("cursor", "must be a string");
        }
        if (
          typeof limit !== "number" ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MAX_LIST_LIMIT
        ) {
          throw invalidOption(
            "limit",
            `must be an integer from 1 to ${MAX_LIST_LIMIT}`,
          );
        }
        const result = await this.listExportedExecutions({ ...input, limit });
        records = result.items.length;
        return result;
      },
      () => ({ records }),
    );
  }

  /**
   * Deletes the records of whole executions: the retention hook a host calls
   * on a schedule.
   *
   * @param input - One execution, or an age limit.
   * @returns How much was deleted and whether more remains.
   * @throws {@link WorkflowStorageError} with code
   * `WORKFLOW_STORAGE_UNSUPPORTED` when `capabilities.pruning` is `false`.
   */
  async prune(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    let records = 0;
    return this.#measure(
      "prune",
      async () => {
        this.#assertOpen();
        this.#require("pruning", "prune");
        if ("executionId" in input && input.executionId !== undefined) {
          identifier("executionId", input.executionId, "option");
        } else if ("lastRecordBefore" in input) {
          if (
            typeof input.lastRecordBefore !== "number" ||
            !Number.isFinite(input.lastRecordBefore)
          ) {
            throw invalidOption(
              "lastRecordBefore",
              "must be a finite number of epoch milliseconds",
            );
          }
          if (input.limit !== undefined) positiveInteger("limit", input.limit);
        } else {
          throw invalidOption(
            "executionId",
            "or lastRecordBefore must be given",
          );
        }
        const result = await this.pruneRecords(input);
        records = result.records;
        return result;
      },
      () => ({ records }),
    );
  }

  /**
   * Checks that the backend answers a read and accepts writes.
   *
   * @returns The health result; it resolves (with `ok: false`) when the
   * backend fails, and never throws.
   */
  async healthCheck(): Promise<WorkflowStorageHealth> {
    const started = performance.now();
    const finish = (
      health: Omit<WorkflowStorageHealth, "provider" | "latencyMs">,
    ): WorkflowStorageHealth => {
      const latencyMs = performance.now() - started;
      this.#report({
        operation: "healthCheck",
        durationMs: latencyMs,
        outcome: health.ok ? "ok" : "error",
        ...(health.code === undefined ? {} : { errorCode: health.code }),
      });
      return { provider: this.providerName, latencyMs, ...health };
    };
    try {
      this.#assertOpen();
      const schemaVersion = await this.checkHealth();
      return finish({
        ok: true,
        ...(schemaVersion === undefined ? {} : { schemaVersion }),
      });
    } catch (error) {
      if (isWorkflowStorageError(error)) {
        return finish({ ok: false, code: error.code, message: error.message });
      }
      return finish({
        ok: false,
        code: "WORKFLOW_STORAGE_UNAVAILABLE",
        message: "The health probe failed",
      });
    }
  }

  /** Makes every appended record durable, when the exporter buffers writes. */
  async flush(): Promise<void> {
    return this.#measure(
      "flush",
      async () => {
        this.#assertOpen();
        await this.flushExporter();
      },
      () => ({}),
    );
  }

  /**
   * Flushes and releases the resources of the exporter. Later calls reject
   * with `WORKFLOW_STORAGE_CLOSED`. Closing twice does nothing.
   */
  async close(): Promise<void> {
    if (this.#closing) {
      // A second close waits for the first one and never rethrows its failure.
      await this.#closing.catch(() => undefined);
      return;
    }
    this.#closed = true;
    this.#closing = this.#measure(
      "close",
      async () => {
        let failed = false;
        let failure: unknown;
        try {
          await this.flushExporter();
        } catch (error) {
          failed = true;
          failure = error;
        }
        try {
          await this.closeExporter();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        if (failed) throw failure;
      },
      () => ({}),
    );
    await this.#closing;
  }

  /**
   * Stores the new records of a batch and assigns their sequences, as one
   * storage transaction.
   *
   * @param executionId - Execution of the batch.
   * @param records - Validated records, each within the size limit, with
   * their serialized payload sizes checked.
   * @returns The sequence of every record and whether it was a duplicate.
   */
  protected abstract appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult>;

  /**
   * Storage primitive of {@link BaseWorkflowEventExporter.read}.
   *
   * @param input - Validated input with concrete `afterSequence` and
   * `limit`.
   * @returns Records in ascending sequence and the next cursor.
   */
  protected abstract readRecords(
    input: ReadWorkflowEventRecordsInput & {
      afterSequence: number;
      limit: number;
    },
  ): Promise<ReadWorkflowEventRecordsResult>;

  /**
   * Storage primitive of {@link BaseWorkflowEventExporter.listExecutions}.
   *
   * @param input - Validated input with a concrete `limit`.
   * @returns A page and the cursor of the next one.
   */
  protected listExportedExecutions(
    input: ListWorkflowEventExecutionsInput & { limit: number },
  ): Promise<ListWorkflowEventExecutionsResult> {
    void input;
    return Promise.reject(
      unsupportedOperation(this.providerName, "listExecutions"),
    );
  }

  /**
   * Storage primitive of {@link BaseWorkflowEventExporter.prune}.
   *
   * @param input - Validated input.
   * @returns How much was deleted and whether more remains.
   */
  protected pruneRecords(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    void input;
    return Promise.reject(unsupportedOperation(this.providerName, "prune"));
  }

  /**
   * Storage primitive of {@link BaseWorkflowEventExporter.healthCheck}: a
   * cheap read and write probe that throws on failure.
   *
   * @returns The schema version found in storage, when the exporter keeps
   * one.
   */
  protected checkHealth(): Promise<number | undefined> {
    return Promise.resolve(undefined);
  }

  /** Storage primitive of {@link BaseWorkflowEventExporter.flush}. */
  protected flushExporter(): Promise<void> {
    return Promise.resolve();
  }

  /** Storage primitive of {@link BaseWorkflowEventExporter.close}. */
  protected closeExporter(): Promise<void> {
    return Promise.resolve();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_CLOSED",
        `The ${this.providerName} event exporter is closed`,
        { details: { provider: this.providerName } },
      );
    }
  }

  #require(flag: "listing" | "pruning", operation: string): void {
    if (this.capabilities[flag]) return;
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNSUPPORTED",
      `The ${this.providerName} event exporter does not support ${operation}`,
      {
        capability: flag,
        details: { provider: this.providerName, operation, capability: flag },
      },
    );
  }

  #report(
    metric: Omit<WorkflowStorageOperationMetric, "capability" | "provider">,
  ): void {
    recordWorkflowStorageOperation(
      { capability: "events", provider: this.providerName, ...metric },
      this.baseOptions.onOperation,
    );
  }

  /** Runs an operation and reports exactly one metric for it. */
  async #measure<T>(
    operation: string,
    run: () => Promise<T>,
    sizes: () => { records?: number; bytes?: number },
  ): Promise<T> {
    const started = performance.now();
    try {
      const value = await run();
      this.#report({
        operation,
        durationMs: performance.now() - started,
        outcome: "ok",
        ...sizes(),
      });
      return value;
    } catch (error) {
      const wrapped = isWorkflowStorageError(error)
        ? error
        : new WorkflowStorageError(
            "WORKFLOW_STORAGE_UNAVAILABLE",
            `The ${this.providerName} event exporter failed during ${operation}`,
            { cause: error },
          );
      this.#report({
        operation,
        durationMs: performance.now() - started,
        outcome: "error",
        errorCode: wrapped.code,
        ...sizes(),
      });
      throw wrapped;
    }
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const MAX_JSON_DEPTH = 64;

const KINDS: ReadonlySet<unknown> = new Set<WorkflowEventRecordKind>([
  "workflow",
  "step",
  "agent_run",
  "span",
  "warning",
]);

const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "executionId",
  "kind",
  "type",
  "timestamp",
  "workflowId",
  "stepId",
  "attempt",
  "agentName",
  "invocationId",
  "traceId",
  "spanId",
  "parentSpanId",
  "payload",
  "clipped",
  "sequence",
]);

const OPTIONAL_STRING_FIELDS = [
  "workflowId",
  "stepId",
  "agentName",
  "invocationId",
  "traceId",
  "spanId",
  "parentSpanId",
] as const;

function unsupportedOperation(
  provider: string,
  operation: string,
): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_UNSUPPORTED",
    `The ${provider} event exporter does not implement ${operation}`,
    { details: { provider, operation } },
  );
}

function invalidOption(
  name: string,
  requirement: string,
): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_INVALID_OPTION",
    `${name} ${requirement}`,
    { details: { option: name } },
  );
}

function invalidRecord(message: string): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_INVALID_RECORD",
    `Invalid event record: ${message}`,
  );
}

function positiveInteger(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidOption(name, "must be a positive safe integer");
  }
}

function identifier(
  name: string,
  value: unknown,
  failure: "record" | "option",
): asserts value is string {
  if (
    typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH
  ) {
    return;
  }
  const requirement = `must be a non-empty string of at most ${MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH} characters`;
  throw failure === "record"
    ? invalidRecord(`${name} ${requirement}`)
    : invalidOption(name, requirement);
}

/**
 * Throws `WORKFLOW_STORAGE_INVALID_RECORD` unless `value` is JSON-safe: what
 * `JSON.parse(JSON.stringify(value))` returns unchanged.
 *
 * @param value - Value to check.
 * @param label - Name used in the error message.
 * @internal
 */
export function assertWorkflowEventJsonSafe(
  value: unknown,
  label: string,
): void {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (item === null) return;
    switch (typeof item) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(item)) {
          throw invalidRecord(`${label} holds a number that is not finite`);
        }
        return;
      case "object":
        break;
      default:
        throw invalidRecord(`${label} holds a value that is not JSON-safe`);
    }
    const object = item as object;
    if (depth > MAX_JSON_DEPTH) {
      throw invalidRecord(`${label} is nested too deeply`);
    }
    if (ancestors.has(object)) {
      throw invalidRecord(`${label} holds a circular reference`);
    }
    ancestors.add(object);
    if (Array.isArray(object)) {
      for (const element of object) visit(element, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalidRecord(`${label} holds an object that is not plain`);
      }
      for (const key of Object.keys(object)) {
        visit((object as Record<string, unknown>)[key], depth + 1);
      }
    }
    ancestors.delete(object);
  };
  visit(value, 0);
}

/**
 * Checks one record against the contract and returns its serialized size.
 *
 * @param record - The record to check.
 * @param executionId - Execution id of the batch.
 * @param maxRecordBytes - Largest serialized size, in bytes.
 * @returns UTF-8 size of the serialized record.
 * @throws {@link WorkflowStorageError} with code
 * `WORKFLOW_STORAGE_INVALID_RECORD` or `WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE`.
 * @internal
 */
export function validateWorkflowEventRecord(
  record: WorkflowEventRecordInput,
  executionId: string,
  maxRecordBytes: number,
): number {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw invalidRecord("a record must be an object");
  }
  const fields = record as unknown as Record<string, unknown>;
  identifier("id", fields.id, "record");
  identifier("executionId", fields.executionId, "record");
  if (fields.executionId !== executionId) {
    throw invalidRecord("a record names another execution than its batch");
  }
  if (!KINDS.has(fields.kind)) {
    throw invalidRecord("kind is not a known record kind");
  }
  identifier("type", fields.type, "record");
  if (
    typeof fields.timestamp !== "number" ||
    !Number.isFinite(fields.timestamp)
  ) {
    throw invalidRecord("timestamp must be a finite number");
  }
  for (const name of Object.keys(fields)) {
    if (!ENVELOPE_FIELDS.has(name)) {
      throw invalidRecord(`${name} is not a record field`);
    }
  }
  for (const name of OPTIONAL_STRING_FIELDS) {
    if (fields[name] !== undefined) {
      if (typeof fields[name] !== "string") {
        throw invalidRecord(`${name} must be a string`);
      }
      if (
        (fields[name] as string).length > MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH
      ) {
        throw invalidRecord(`${name} is too long`);
      }
    }
  }
  if (
    fields.attempt !== undefined &&
    (typeof fields.attempt !== "number" ||
      !Number.isSafeInteger(fields.attempt) ||
      fields.attempt < 0)
  ) {
    throw invalidRecord("attempt must be a non-negative integer");
  }
  const payload = fields.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw invalidRecord("payload must be an object");
  }
  assertWorkflowEventJsonSafe(payload, "payload");
  if (fields.clipped !== undefined) {
    if (typeof fields.clipped !== "object" || fields.clipped === null) {
      throw invalidRecord("clipped must be an object");
    }
    assertWorkflowEventJsonSafe(fields.clipped, "clipped");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    throw invalidRecord("the record cannot be serialized");
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxRecordBytes) {
    throw new WorkflowStorageError(
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
      `An event record of ${bytes} bytes exceeds the limit of ${maxRecordBytes} bytes`,
      { details: { bytes, maxRecordBytes } },
    );
  }
  return bytes;
}

/**
 * Encodes the id of the last listed execution as an opaque cursor.
 *
 * @param executionId - Last execution id of a page.
 * @returns The cursor.
 * @internal
 */
export function encodeWorkflowEventListCursor(executionId: string): string {
  return Buffer.from(executionId, "utf8").toString("base64url");
}

/**
 * Decodes a cursor made by {@link encodeWorkflowEventListCursor}.
 *
 * @param cursor - The cursor.
 * @returns The execution id to list after.
 * @throws {@link WorkflowStorageError} with code
 * `WORKFLOW_STORAGE_INVALID_OPTION` for a cursor that is not valid.
 * @internal
 */
export function decodeWorkflowEventListCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    decoded === "" ||
    Buffer.from(decoded, "utf8").toString("base64url") !== cursor
  ) {
    throw invalidOption("cursor", "is not a valid cursor");
  }
  return decoded;
}
