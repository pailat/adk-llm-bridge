import { WorkflowStorageError } from "./errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type BaseWorkflowEventExporterOptions,
  DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES,
  decodeWorkflowEventListCursor,
  encodeWorkflowEventListCursor,
  type ListWorkflowEventExecutionsInput,
  type ListWorkflowEventExecutionsResult,
  type PruneWorkflowEventRecordsInput,
  type PruneWorkflowEventRecordsResult,
  type ReadWorkflowEventRecordsInput,
  type ReadWorkflowEventRecordsResult,
  type WorkflowEventExporterCapabilities,
  type WorkflowEventRecord,
  type WorkflowEventRecordInput,
} from "./event-exporter.js";

const DEFAULT_MAX_RECORDS = 100_000;
const DEFAULT_PRUNE_LIMIT = 500;

/**
 * Options of {@link InMemoryWorkflowEventExporter}.
 *
 * @experimental
 */
export interface InMemoryWorkflowEventExporterOptions
  extends BaseWorkflowEventExporterOptions {
  /**
   * Largest number of records kept across all executions. An append that
   * would exceed it rejects with `WORKFLOW_STORAGE_UNAVAILABLE` (not
   * retryable); nothing is evicted, because eviction would leave gaps.
   *
   * @defaultValue 100000
   */
  maxRecords?: number;
}

/**
 * Reference event exporter that keeps records in the memory of one process:
 * the default for tests. URI: `memory://`.
 *
 * @remarks
 * It implements the whole contract with `durable: false` and
 * `multiProcess: false`.
 *
 * @experimental
 */
export class InMemoryWorkflowEventExporter extends BaseWorkflowEventExporter {
  /** Provider name: `memory`. */
  readonly providerName = "memory";
  /** Full contract, not durable, one process. */
  readonly capabilities: WorkflowEventExporterCapabilities;

  readonly #executions = new Map<string, WorkflowEventRecord[]>();
  readonly #ids = new Map<string, Map<string, number>>();
  readonly #maxRecords: number;
  #total = 0;

  /**
   * Creates an empty exporter.
   *
   * @param options - Capacity and the shared exporter options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for a capacity that is not a positive safe integer.
   */
  constructor(options: InMemoryWorkflowEventExporterOptions = {}) {
    super(options);
    const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        "maxRecords must be a positive safe integer",
        { details: { option: "maxRecords" } },
      );
    }
    this.#maxRecords = maxRecords;
    this.capabilities = Object.freeze({
      durable: false,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxRecordBytes:
        options.maxRecordBytes ?? DEFAULT_WORKFLOW_EVENT_RECORD_MAX_BYTES,
    });
  }

  protected override async appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    // The whole body is synchronous, so concurrent callers cannot interleave.
    const stored = this.#executions.get(executionId) ?? [];
    const ids = this.#ids.get(executionId) ?? new Map<string, number>();
    const fresh = records.filter((record) => !ids.has(record.id));
    if (this.#total + fresh.length > this.#maxRecords) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_UNAVAILABLE",
        `The memory event exporter holds its limit of ${this.#maxRecords} records`,
        { retryable: false, details: { maxRecords: this.#maxRecords } },
      );
    }
    const result: Array<{ id: string; sequence: number; duplicate: boolean }> =
      [];
    for (const record of records) {
      const known = ids.get(record.id);
      if (known !== undefined) {
        result.push({ id: record.id, sequence: known, duplicate: true });
        continue;
      }
      const sequence = stored.length + 1;
      const copy = JSON.parse(
        JSON.stringify(record),
      ) as WorkflowEventRecordInput;
      stored.push({ ...copy, sequence });
      ids.set(record.id, sequence);
      result.push({ id: record.id, sequence, duplicate: false });
    }
    if (fresh.length > 0) {
      this.#total += fresh.length;
      this.#executions.set(executionId, stored);
      this.#ids.set(executionId, ids);
    }
    return { records: result, lastSequence: stored.length };
  }

  protected override async readRecords(
    input: ReadWorkflowEventRecordsInput & {
      afterSequence: number;
      limit: number;
    },
  ): Promise<ReadWorkflowEventRecordsResult> {
    const stored = this.#executions.get(input.executionId) ?? [];
    const matches = (record: WorkflowEventRecord): boolean =>
      (input.kinds === undefined || input.kinds.includes(record.kind)) &&
      (input.types === undefined || input.types.includes(record.type));
    const page: WorkflowEventRecord[] = [];
    let hasMore = false;
    // Sequences are dense, so the record with sequence n is at index n - 1.
    for (let index = input.afterSequence; index < stored.length; index += 1) {
      const record = stored[index] as WorkflowEventRecord;
      if (!matches(record)) continue;
      if (page.length === input.limit) {
        hasMore = true;
        break;
      }
      page.push(JSON.parse(JSON.stringify(record)) as WorkflowEventRecord);
    }
    const last = page[page.length - 1];
    return {
      records: page,
      nextAfterSequence: last ? last.sequence : input.afterSequence,
      hasMore,
    };
  }

  protected override async listExportedExecutions(
    input: ListWorkflowEventExecutionsInput & { limit: number },
  ): Promise<ListWorkflowEventExecutionsResult> {
    const after =
      input.cursor === undefined
        ? undefined
        : decodeWorkflowEventListCursor(input.cursor);
    const ids = [...this.#executions.keys()]
      .filter((id) => after === undefined || id > after)
      .sort();
    const pageIds = ids.slice(0, input.limit);
    const items = pageIds.map((executionId) => {
      const stored = this.#executions.get(executionId) as WorkflowEventRecord[];
      return {
        executionId,
        lastSequence: stored.length,
        firstTimestamp: (stored[0] as WorkflowEventRecord).timestamp,
        lastTimestamp: (stored[stored.length - 1] as WorkflowEventRecord)
          .timestamp,
      };
    });
    const last = pageIds[pageIds.length - 1];
    return ids.length > pageIds.length && last !== undefined
      ? { items, nextCursor: encodeWorkflowEventListCursor(last) }
      : { items };
  }

  protected override async pruneRecords(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    let targets: string[];
    let hasMore = false;
    if ("executionId" in input) {
      targets = this.#executions.has(input.executionId)
        ? [input.executionId]
        : [];
    } else {
      const limit = input.limit ?? DEFAULT_PRUNE_LIMIT;
      const old = [...this.#executions.entries()]
        .filter(([, stored]) => {
          const last = stored[stored.length - 1] as WorkflowEventRecord;
          return last.timestamp < input.lastRecordBefore;
        })
        .map(([id]) => id)
        .sort();
      targets = old.slice(0, limit);
      hasMore = old.length > targets.length;
    }
    let records = 0;
    for (const id of targets) {
      records += this.#executions.get(id)?.length ?? 0;
      this.#executions.delete(id);
      this.#ids.delete(id);
    }
    this.#total -= records;
    return { executions: targets.length, records, hasMore };
  }
}
