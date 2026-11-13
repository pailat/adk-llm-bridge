import {
  isSqliteBusyError,
  openSqliteDatabase,
  runWhileSqliteBusy,
  SQLITE_BUSY_SLICE_MS,
  type SqliteDatabaseHandle,
  type SqliteMigration,
  type SqliteOpenFailure,
  type SqliteValue,
} from "../../../utils/sqlite-database.js";
import {
  WorkflowStorageError,
  type WorkflowStorageErrorCode,
} from "../../storage/errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type BaseWorkflowEventExporterOptions,
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
} from "../../storage/event-exporter.js";

/** Name this provider keeps its schema version under. */
const COMPONENT = "workflow-events";
const DEFAULT_PRUNE_LIMIT = 500;

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE workflow_event_records (
  execution_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp REAL NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (execution_id, sequence)
);
CREATE UNIQUE INDEX workflow_event_records_by_id
  ON workflow_event_records (execution_id, id);
CREATE INDEX workflow_event_records_by_kind
  ON workflow_event_records (execution_id, kind, sequence);
CREATE INDEX workflow_event_records_by_type
  ON workflow_event_records (execution_id, type, sequence);
CREATE TABLE workflow_event_executions (
  execution_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL,
  first_timestamp REAL NOT NULL,
  last_timestamp REAL NOT NULL
);
CREATE INDEX workflow_event_executions_by_last_timestamp
  ON workflow_event_executions (last_timestamp, execution_id);
`,
  },
];

/** Schema version {@link SqliteWorkflowEventExporter} writes. */
export const SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION = 1;

/**
 * Options of {@link SqliteWorkflowEventExporter}.
 *
 * @experimental
 */
export interface SqliteWorkflowEventExporterOptions
  extends BaseWorkflowEventExporterOptions {
  /**
   * Absolute path of the database file. Created with mode `0600` when
   * missing, and its directory with `0700`; the path is never followed when
   * it is a symbolic link. `":memory:"` keeps the data in memory.
   */
  path: string;
  /**
   * Milliseconds a write waits for another process holding the database
   * lock: an integer from 0 to 2147483647. The wait is asynchronous, so the
   * event loop keeps running.
   *
   * @defaultValue 5000
   */
  busyTimeoutMs?: number;
  /**
   * SQLite `synchronous` level. `normal` keeps every committed batch when
   * the process is killed and can lose the newest ones on a power loss;
   * `full` syncs every commit.
   *
   * @defaultValue `"normal"`
   */
  synchronous?: "full" | "normal";
}

/**
 * Event exporter that appends records to a SQLite file through the
 * runtime's built-in `node:sqlite`; it adds no dependency. URI:
 * `sqlite:///absolute/path.db`.
 *
 * @remarks
 * Runs on Node 22.13 and later and on Bun. The database uses WAL mode and a
 * busy timeout. An `append` is one `BEGIN IMMEDIATE` transaction that reads
 * the execution's last sequence, skips ids already stored and inserts the
 * rest, so several processes can append to one execution and the sequence
 * stays without gaps or repeats. Records are indexed by execution and
 * sequence, by execution, kind and sequence, and by execution, type and
 * sequence. The schema version lives in the database: a newer one is refused
 * with `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED`, older ones are migrated on
 * open. The file can be shared with `SqliteWorkflowCheckpointStore`.
 *
 * @example
 * ```ts
 * import { WorkflowEventExportPlugin } from "adk-llm-bridge/workflows";
 * import { SqliteWorkflowEventExporter } from "adk-llm-bridge/workflows/events/sqlite";
 *
 * const exporter = new SqliteWorkflowEventExporter({ path: "/var/lib/app/workflows.db" });
 * const runner = new Runner({ appName, agent, sessionService, plugins: [new WorkflowEventExportPlugin({ exporter })] });
 * ```
 *
 * @experimental
 */
export class SqliteWorkflowEventExporter extends BaseWorkflowEventExporter {
  /** Provider name: `sqlite`. */
  readonly providerName = "sqlite";
  /** Full contract, durable, several processes on one host. */
  readonly capabilities: WorkflowEventExporterCapabilities;

  /**
   * Opens (and creates when missing) the database and migrates its schema.
   *
   * @param options - Database path, busy timeout, sync level and the shared
   * exporter options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for a bad option (before any file is created),
   * `WORKFLOW_STORAGE_DRIVER_MISSING` when the runtime has no `node:sqlite`,
   * `WORKFLOW_STORAGE_UNSAFE_PATH` when the path is a symbolic link or not a
   * regular file, `WORKFLOW_STORAGE_CORRUPT` when the file is not a SQLite
   * database, or `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED` when a newer version
   * wrote it.
   */
  constructor(options: SqliteWorkflowEventExporterOptions) {
    super(options);
    if (typeof options.path !== "string" || options.path === "") {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        'path must be an absolute file path or ":memory:"',
        { details: { option: "path" } },
      );
    }
    if (
      options.synchronous !== undefined &&
      options.synchronous !== "full" &&
      options.synchronous !== "normal"
    ) {
      throw new WorkflowStorageError(
        "WORKFLOW_STORAGE_INVALID_OPTION",
        'synchronous must be "full" or "normal"',
        { details: { option: "synchronous" } },
      );
    }
    this.capabilities = Object.freeze({
      durable: options.path !== ":memory:",
      multiProcess: options.path !== ":memory:",
      listing: true,
      pruning: true,
      maxRecordBytes: options.maxRecordBytes ?? 256 * 1024,
    });
    let db: SqliteDatabaseHandle;
    try {
      db = openSqliteDatabase({
        path: options.path,
        ...(options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: options.busyTimeoutMs }),
        synchronous: options.synchronous ?? "normal",
        symlinks: "reject",
        fail: openFailure,
      });
    } catch (error) {
      throw mapSqliteError(error, "open", true);
    }
    try {
      db.migrate(COMPONENT, MIGRATIONS);
    } catch (error) {
      try {
        db.close();
      } catch {
        // Nothing more to release.
      }
      throw mapSqliteError(error, "open");
    }
    // Statements block for one short slice at most; the rest of the wait for
    // a lock held by another process is asynchronous (runWhileSqliteBusy), so
    // timers, including the operation timeout, keep running.
    db.exec(
      `PRAGMA busy_timeout = ${Math.min(SQLITE_BUSY_SLICE_MS, options.busyTimeoutMs ?? SQLITE_BUSY_SLICE_MS)}`,
    );
    this.#busyWaitMs = options.busyTimeoutMs ?? 5000;
    this.#db = db;
  }

  #db: SqliteDatabaseHandle;
  readonly #busyWaitMs: number;

  protected override async appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    return this.#run("append", () =>
      this.#db.transaction(() => {
        const summary = this.#db
          .prepare(
            "SELECT last_sequence FROM workflow_event_executions WHERE execution_id = ?",
          )
          .get(executionId);
        let last = Number(summary?.last_sequence ?? 0);
        const find = this.#db.prepare(
          "SELECT sequence FROM workflow_event_records WHERE execution_id = ? AND id = ?",
        );
        const insert = this.#db.prepare(
          `INSERT INTO workflow_event_records (execution_id, sequence, id, kind, type, timestamp, record_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        const results: Array<{
          id: string;
          sequence: number;
          duplicate: boolean;
        }> = [];
        let firstTimestamp: number | undefined;
        let lastTimestamp: number | undefined;
        for (const record of records) {
          const stored = find.get(executionId, record.id);
          if (stored !== undefined) {
            results.push({
              id: record.id,
              sequence: Number(stored.sequence),
              duplicate: true,
            });
            continue;
          }
          last += 1;
          const { sequence: _ignored, ...envelope } =
            record as WorkflowEventRecord;
          insert.run(
            executionId,
            last,
            record.id,
            record.kind,
            record.type,
            record.timestamp,
            JSON.stringify(envelope),
          );
          firstTimestamp ??= record.timestamp;
          lastTimestamp = record.timestamp;
          results.push({ id: record.id, sequence: last, duplicate: false });
        }
        if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
          this.#db
            .prepare(
              `INSERT INTO workflow_event_executions (execution_id, last_sequence, first_timestamp, last_timestamp)
               VALUES (?, ?, ?, ?)
               ON CONFLICT (execution_id) DO UPDATE SET
                 last_sequence = excluded.last_sequence,
                 last_timestamp = excluded.last_timestamp`,
            )
            .run(executionId, last, firstTimestamp, lastTimestamp);
        }
        return { records: results, lastSequence: last };
      }),
    );
  }

  protected override async readRecords(
    input: ReadWorkflowEventRecordsInput & {
      afterSequence: number;
      limit: number;
    },
  ): Promise<ReadWorkflowEventRecordsResult> {
    const { kinds, types } = input;
    if (kinds?.length === 0 || types?.length === 0) {
      return {
        records: [],
        nextAfterSequence: input.afterSequence,
        hasMore: false,
      };
    }
    return this.#run("read", () => {
      const parameters: SqliteValue[] = [
        input.executionId,
        input.afterSequence,
      ];
      let filter = "";
      if (kinds !== undefined) {
        filter += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
        parameters.push(...kinds);
      }
      if (types !== undefined) {
        filter += ` AND type IN (${types.map(() => "?").join(",")})`;
        parameters.push(...types);
      }
      parameters.push(input.limit + 1);
      const rows = this.#db
        .prepare(
          `SELECT sequence, id, execution_id, kind, type, record_json FROM workflow_event_records
           WHERE execution_id = ? AND sequence > ?${filter}
           ORDER BY sequence LIMIT ?`,
        )
        .all(...parameters);
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const records = page.map(toRecord);
      const lastRecord = records[records.length - 1];
      return {
        records,
        nextAfterSequence: lastRecord?.sequence ?? input.afterSequence,
        hasMore,
      };
    });
  }

  protected override async listExportedExecutions(
    input: ListWorkflowEventExecutionsInput & { limit: number },
  ): Promise<ListWorkflowEventExecutionsResult> {
    const after =
      input.cursor === undefined
        ? undefined
        : decodeWorkflowEventListCursor(input.cursor);
    return this.#run("list", () => {
      const rows = this.#db
        .prepare(
          `SELECT execution_id, last_sequence, first_timestamp, last_timestamp
           FROM workflow_event_executions
           WHERE execution_id > ?
           ORDER BY execution_id LIMIT ?`,
        )
        .all(after ?? "", input.limit + 1);
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(
        (row) => ({
          executionId: String(row.execution_id),
          lastSequence: Number(row.last_sequence),
          firstTimestamp: Number(row.first_timestamp),
          lastTimestamp: Number(row.last_timestamp),
        }),
      );
      const last = items[items.length - 1];
      return {
        items,
        ...(hasMore && last !== undefined
          ? { nextCursor: encodeWorkflowEventListCursor(last.executionId) }
          : {}),
      };
    });
  }

  /**
   * Deletes whole executions, each in its own transaction. When a delete
   * fails part way, the executions already deleted stay deleted and the error
   * replaces the counts; calling again carries on.
   */
  protected override async pruneRecords(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    return this.#run("prune", () => {
      let ids: string[];
      let hasMore = false;
      if ("executionId" in input && input.executionId !== undefined) {
        ids = [input.executionId];
      } else if ("lastRecordBefore" in input) {
        const limit = input.limit ?? DEFAULT_PRUNE_LIMIT;
        const rows = this.#db
          .prepare(
            `SELECT execution_id FROM workflow_event_executions
             WHERE last_timestamp < ?
             ORDER BY last_timestamp, execution_id LIMIT ?`,
          )
          .all(input.lastRecordBefore, limit + 1);
        hasMore = rows.length > limit;
        ids = rows.slice(0, limit).map((row) => String(row.execution_id));
      } else {
        ids = [];
      }
      const cutoff =
        "lastRecordBefore" in input && !("executionId" in input)
          ? input.lastRecordBefore
          : undefined;
      let executions = 0;
      let records = 0;
      // One transaction per execution: the records and the summary of an
      // execution go together, and the write lock is held for one execution
      // at a time.
      for (const id of ids) {
        const outcome = this.#db.transaction(() => {
          if (cutoff !== undefined) {
            // The execution was chosen before this transaction began: another
            // process may have appended to it since, so check its age again.
            const current = this.#db
              .prepare(
                "SELECT last_timestamp FROM workflow_event_executions WHERE execution_id = ?",
              )
              .get(id);
            if (
              current === undefined ||
              Number(current.last_timestamp) >= cutoff
            ) {
              return { removed: 0, summary: 0 };
            }
          }
          const removed = Number(
            this.#db
              .prepare(
                "DELETE FROM workflow_event_records WHERE execution_id = ?",
              )
              .run(id).changes,
          );
          const summary = Number(
            this.#db
              .prepare(
                "DELETE FROM workflow_event_executions WHERE execution_id = ?",
              )
              .run(id).changes,
          );
          return { removed, summary };
        });
        records += outcome.removed;
        if (outcome.summary > 0 || outcome.removed > 0) executions += 1;
      }
      return { executions, records, hasMore };
    });
  }

  protected override async checkHealth(): Promise<number | undefined> {
    return this.#run("health check", () => {
      this.#db.prepare("SELECT 1 FROM workflow_event_records LIMIT 1").get();
      this.#db.prepare("SELECT 1 FROM workflow_event_executions LIMIT 1").get();
      // The write probe takes the write lock and is rolled back.
      const probe = new Error("rolled back health probe");
      try {
        this.#db.transaction(() => {
          this.#db
            .prepare(
              `INSERT INTO workflow_event_executions (execution_id, last_sequence, first_timestamp, last_timestamp)
               VALUES ('', 0, 0, 0)
               ON CONFLICT (execution_id) DO UPDATE SET last_sequence = last_sequence`,
            )
            .run();
          throw probe;
        });
      } catch (error) {
        if (error !== probe) throw error;
      }
      const checks = this.#db.prepare("PRAGMA quick_check(1)").all();
      const first = checks[0];
      if (first === undefined || Object.values(first)[0] !== "ok") {
        throw corrupt("PRAGMA quick_check reported a damaged database");
      }
      return this.#db.schemaVersion(COMPONENT);
    });
  }

  protected override async closeExporter(): Promise<void> {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Closing the last connection folds the log anyway; a busy log is not
      // a reason to fail the close.
    }
    this.#db.close();
  }

  async #run<T>(operation: string, body: () => T): Promise<T> {
    try {
      return await runWhileSqliteBusy(body, this.#busyWaitMs);
    } catch (error) {
      throw mapSqliteError(error, operation);
    }
  }
}

function toRecord(row: Record<string, SqliteValue>): WorkflowEventRecord {
  const columns = row;
  let parsed: unknown;
  try {
    parsed =
      typeof row.record_json === "string" ? JSON.parse(row.record_json) : null;
  } catch (cause) {
    throw corrupt("A stored event record is not valid JSON", cause);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw corrupt("A stored event record is not an object");
  }
  const stored = parsed as Partial<WorkflowEventRecordInput>;
  if (
    stored.id !== columns.id ||
    stored.executionId !== columns.execution_id ||
    stored.kind !== columns.kind ||
    stored.type !== columns.type
  ) {
    throw corrupt("A stored event record does not match its row");
  }
  return {
    ...(parsed as WorkflowEventRecordInput),
    sequence: Number(row.sequence),
  };
}

function openFailure(
  failure: SqliteOpenFailure,
  message: string,
  cause?: unknown,
): Error {
  const codes: Record<SqliteOpenFailure, WorkflowStorageErrorCode> = {
    unavailable: "WORKFLOW_STORAGE_DRIVER_MISSING",
    invalid_option: "WORKFLOW_STORAGE_INVALID_OPTION",
    unsafe_path: "WORKFLOW_STORAGE_UNSAFE_PATH",
    not_a_database: "WORKFLOW_STORAGE_CORRUPT",
    schema_unsupported: "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
  };
  return new WorkflowStorageError(codes[failure], message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

function corrupt(message: string, cause?: unknown): WorkflowStorageError {
  return new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", message, {
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Turns a SQLite failure into a typed storage error: a busy database is
 * retryable `UNAVAILABLE`, a damaged file is `CORRUPT`. Typed errors pass
 * through.
 */
function mapSqliteError(
  error: unknown,
  operation: string,
  openingFile = false,
): unknown {
  if (error instanceof WorkflowStorageError) return error;
  if (isSqliteBusyError(error)) {
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      `The SQLite database stayed busy past its timeout during ${operation}`,
      { cause: error, retryable: true },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  const primary = typeof errcode === "number" ? errcode & 0xff : undefined;
  const notADatabase =
    !openingFile && (primary === 26 || /not a database/i.test(message));
  if (
    notADatabase ||
    primary === 11 ||
    /malformed|no such (table|column)/i.test(message)
  ) {
    return corrupt(
      `The SQLite database is damaged: ${operation} failed`,
      error,
    );
  }
  if (primary === 10 || primary === 13 || primary === 14) {
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      `The SQLite database could not be used during ${operation}`,
      { cause: error, retryable: true },
    );
  }
  if (primary !== undefined || /readonly database/i.test(message)) {
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      `The SQLite database refused ${operation} (SQLite result code ${String(primary ?? "unknown")})`,
      { cause: error, retryable: false, details: { sqliteCode: primary } },
    );
  }
  return error;
}
