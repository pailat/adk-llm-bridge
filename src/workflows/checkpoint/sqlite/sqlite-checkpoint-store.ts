import { createHash } from "node:crypto";
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
  type AcquireWorkflowCheckpointLeaseInput,
  BaseWorkflowCheckpointStore,
  type BaseWorkflowCheckpointStoreOptions,
  type DeleteWorkflowCheckpointInput,
  type ListWorkflowCheckpointsInput,
  type ListWorkflowCheckpointsResult,
  type PruneWorkflowCheckpointsInput,
  type PruneWorkflowCheckpointsResult,
  type StoredWorkflowCheckpoint,
  type WorkflowCheckpointLease,
  type WorkflowCheckpointStoreCapabilities,
  type WorkflowCheckpointSummary,
  type WorkflowCheckpointWriteRequest,
} from "../../storage/checkpoint-store.js";
import {
  WorkflowStorageError,
  type WorkflowStorageErrorCode,
} from "../../storage/errors.js";
import type { WorkflowCheckpointStatus } from "../schema.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointLocator,
  workflowCheckpointKey,
} from "../store.js";

/** Name this provider keeps its schema version under. */
const COMPONENT = "workflow-checkpoints";
const MAX_CURSOR_LENGTH = 8192;

const MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE checkpoints (
  workflow_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, execution_id)
);
CREATE INDEX checkpoints_by_status_time
  ON checkpoints (status, updated_at, workflow_id, execution_id);
CREATE INDEX checkpoints_by_time
  ON checkpoints (updated_at, workflow_id, execution_id);
CREATE TABLE leases (
  workflow_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  owner_id TEXT,
  fencing_token INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, execution_id)
);`,
  },
];

/** Schema version {@link SqliteWorkflowCheckpointStore} writes. */
export const SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION = 1;

/**
 * Options of {@link SqliteWorkflowCheckpointStore}.
 *
 * @experimental
 */
export interface SqliteWorkflowCheckpointStoreOptions
  extends BaseWorkflowCheckpointStoreOptions {
  /**
   * Absolute path of the database file. Created with mode `0600` when
   * missing, and its directory with `0700`; the path is never followed when
   * it is a symbolic link. `":memory:"` keeps the data in memory.
   */
  path: string;
  /**
   * Milliseconds a write waits for another process holding the database
   * lock: an integer from 0 to 2147483647. The wait is asynchronous, so the
   * event loop keeps running and never longer
   * than `operationTimeoutMs`.
   *
   * @defaultValue 5000
   */
  busyTimeoutMs?: number;
  /**
   * SQLite `synchronous` level. `full` syncs every commit to disk, so a
   * committed checkpoint survives a power loss; `normal` survives a process
   * kill but can lose the last commits on a power loss.
   *
   * @defaultValue `"full"`
   */
  synchronous?: "full" | "normal";
}

/**
 * Checkpoint provider that keeps checkpoints in a SQLite file through the
 * runtime's built-in `node:sqlite`; it adds no dependency. URI:
 * `sqlite:///absolute/path.db`.
 *
 * @remarks
 * Runs on Node 22.13 and later and on Bun. The database uses WAL mode and a
 * busy timeout. A save is one `BEGIN IMMEDIATE` transaction that compares the
 * stored revision and the fencing token and replaces the row, so writers in
 * several processes on one host are safe and a process killed mid-save leaves
 * the previous checkpoint. Each row keeps a SHA-256 of its JSON text, checked
 * on every read. The schema version lives in the database; a database written
 * by a newer version is refused with `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED`,
 * and older versions are migrated forward on open. The file can be shared
 * with `SqliteWorkflowEventExporter`.
 *
 * Capabilities: everything `true`, `compareAndSet: "atomic"`.
 *
 * @example
 * ```ts
 * import { WorkflowAgent } from "adk-llm-bridge/workflows";
 * import { SqliteWorkflowCheckpointStore } from "adk-llm-bridge/workflows/checkpoint/sqlite";
 *
 * const checkpointStore = new SqliteWorkflowCheckpointStore({ path: "/var/lib/app/workflows.db" });
 * const agent = new WorkflowAgent({ name: "release", definition, agents, checkpointStore });
 * ```
 *
 * @experimental
 */
export class SqliteWorkflowCheckpointStore extends BaseWorkflowCheckpointStore {
  /** Provider name: `sqlite`. */
  readonly providerName = "sqlite";
  /** Full contract, durable, several processes on one host. */
  readonly capabilities: WorkflowCheckpointStoreCapabilities;

  readonly #db: SqliteDatabaseHandle;
  readonly #busyWaitMs: number;

  /**
   * Opens (and creates when missing) the database and migrates its schema.
   *
   * @param options - Database path, busy timeout, sync level and the shared
   * provider options.
   * @throws `WorkflowStorageError` with code `WORKFLOW_STORAGE_INVALID_OPTION`
   * for a bad option (before any file is created),
   * `WORKFLOW_STORAGE_DRIVER_MISSING` when the runtime has no `node:sqlite`,
   * `WORKFLOW_STORAGE_UNSAFE_PATH` when the path is a symbolic link or not a
   * regular file, `WORKFLOW_STORAGE_CORRUPT` when the file is not a SQLite
   * database, or `WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED` when a newer version
   * wrote it.
   */
  constructor(options: SqliteWorkflowCheckpointStoreOptions) {
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
      compareAndSet: "atomic",
      leases: true,
      durable: options.path !== ":memory:",
      multiProcess: options.path !== ":memory:",
      listing: true,
      pruning: true,
      maxCheckpointBytes:
        options.maxCheckpointBytes ?? DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
    });
    let db: SqliteDatabaseHandle;
    try {
      db = openSqliteDatabase({
        path: options.path,
        ...(options.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: options.busyTimeoutMs }),
        synchronous: options.synchronous ?? "full",
        symlinks: "reject",
        fail: openFailure,
      });
    } catch (error) {
      // The helper classifies "not a database" itself; it is not repeated here.
      throw mapSqliteError(error, "open", { openingFile: true });
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
    this.#busyWaitMs = Math.min(
      options.busyTimeoutMs ?? 5000,
      options.operationTimeoutMs ?? 30_000,
    );
    this.#db = db;
  }

  protected override async readCheckpoint(
    locator: WorkflowCheckpointLocator,
  ): Promise<StoredWorkflowCheckpoint | undefined> {
    return this.#run("read", () => {
      // One read snapshot for both selects, so another process cannot replace
      // the row between the size check and the read of its text.
      this.#db.exec("BEGIN");
      try {
        return this.#readRow(locator);
      } finally {
        try {
          this.#db.exec("ROLLBACK");
        } catch {
          // Nothing left to end.
        }
      }
    });
  }

  #readRow(
    locator: WorkflowCheckpointLocator,
  ): StoredWorkflowCheckpoint | undefined {
    {
      let row = this.#db
        .prepare(
          "SELECT revision, length(CAST(checkpoint_json AS BLOB)) AS stored_bytes FROM checkpoints WHERE workflow_id = ? AND execution_id = ?",
        )
        .get(locator.workflowId, locator.executionId);
      if (row === undefined) return undefined;
      // Check the size before the text is read and hashed.
      if (Number(row.stored_bytes) > this.capabilities.maxCheckpointBytes) {
        throw new WorkflowStorageError(
          "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
          "A stored checkpoint is larger than the size limit of this store",
          {
            details: {
              bytes: Number(row.stored_bytes),
              maxCheckpointBytes: this.capabilities.maxCheckpointBytes,
            },
          },
        );
      }
      row = this.#db
        .prepare(
          "SELECT revision, checkpoint_json, bytes, sha256, updated_at FROM checkpoints WHERE workflow_id = ? AND execution_id = ?",
        )
        .get(locator.workflowId, locator.executionId);
      if (row === undefined) return undefined;
      const text = row.checkpoint_json;
      if (
        typeof text !== "string" ||
        typeof row.revision !== "string" ||
        typeof row.sha256 !== "string"
      ) {
        throw corrupt("A stored checkpoint row has a column of the wrong type");
      }
      const digest = createHash("sha256").update(text).digest("hex");
      if (
        digest !== row.sha256 ||
        Number(row.bytes) !== Buffer.byteLength(text)
      ) {
        throw corrupt(
          "A stored checkpoint does not match its SHA-256 or byte size",
        );
      }
      let checkpoint: unknown;
      try {
        checkpoint = JSON.parse(text);
      } catch (cause) {
        throw corrupt("A stored checkpoint is not valid JSON", cause);
      }
      return {
        checkpoint: checkpoint as StoredWorkflowCheckpoint["checkpoint"],
        revision: row.revision as StoredWorkflowCheckpoint["revision"],
        updatedAt: Number(row.updated_at),
      };
    }
  }

  protected override async writeCheckpoint(
    request: WorkflowCheckpointWriteRequest,
  ): Promise<number> {
    const updatedAt = this.currentTime();
    const digest = createHash("sha256")
      .update(request.serialized)
      .digest("hex");
    return this.#run("write", () =>
      this.#db.transaction(() => {
        if (request.fencingToken !== undefined) {
          const current = this.#currentToken(request);
          if (request.fencingToken !== current) {
            throw leaseLost(request.fencingToken, current);
          }
        }
        if (request.expectedRevision !== undefined) {
          const actual = this.#storedRevision(request);
          if (actual !== request.expectedRevision) {
            throw new WorkflowCheckpointConflictError(
              request.checkpointKey,
              request.expectedRevision,
              actual,
            );
          }
        }
        this.#db
          .prepare(
            `INSERT INTO checkpoints
               (workflow_id, execution_id, revision, status, checkpoint_json, bytes, sha256, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (workflow_id, execution_id) DO UPDATE SET
               revision = excluded.revision,
               status = excluded.status,
               checkpoint_json = excluded.checkpoint_json,
               bytes = excluded.bytes,
               sha256 = excluded.sha256,
               updated_at = excluded.updated_at`,
          )
          .run(
            request.workflowId,
            request.executionId,
            request.revision,
            request.checkpoint.status,
            request.serialized,
            request.bytes,
            digest,
            updatedAt,
          );
        return updatedAt;
      }),
    );
  }

  protected override async listCheckpoints(
    input: ListWorkflowCheckpointsInput & { limit: number },
  ): Promise<ListWorkflowCheckpointsResult> {
    const after =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const where: string[] = [];
    const parameters: SqliteValue[] = [];
    if (input.workflowId !== undefined) {
      where.push("workflow_id = ?");
      parameters.push(input.workflowId);
    }
    if (input.status !== undefined) {
      where.push("status = ?");
      parameters.push(input.status);
    }
    if (input.updatedBefore !== undefined) {
      where.push("updated_at < ?");
      parameters.push(input.updatedBefore);
    }
    if (after !== undefined) {
      where.push("(workflow_id, execution_id) > (?, ?)");
      parameters.push(after.workflowId, after.executionId);
    }
    const sql = `SELECT workflow_id, execution_id, revision, status, updated_at, bytes
      FROM checkpoints${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY workflow_id, execution_id LIMIT ?`;
    const rows = await this.#run("list", () =>
      this.#db.prepare(sql).all(...parameters, input.limit + 1),
    );
    const page = rows.slice(0, input.limit);
    const items = page.map(
      (row): WorkflowCheckpointSummary => ({
        workflowId: String(row.workflow_id),
        executionId: String(row.execution_id),
        revision: String(row.revision) as WorkflowCheckpointSummary["revision"],
        status: String(row.status) as WorkflowCheckpointStatus,
        updatedAt: Number(row.updated_at),
        bytes: Number(row.bytes),
      }),
    );
    const last = items[items.length - 1];
    return rows.length > page.length && last
      ? { items, nextCursor: encodeCursor(last) }
      : { items };
  }

  protected override async deleteCheckpoint(
    input: DeleteWorkflowCheckpointInput,
  ): Promise<boolean> {
    return this.#run("delete", () =>
      this.#db.transaction(() => {
        const actual = this.#storedRevision(input);
        if (input.expectedRevision !== undefined) {
          if (actual !== input.expectedRevision) {
            throw new WorkflowCheckpointConflictError(
              workflowCheckpointKey(input.workflowId, input.executionId),
              input.expectedRevision,
              actual,
            );
          }
        }
        this.#freeLease(input.workflowId, input.executionId);
        const result = this.#db
          .prepare(
            "DELETE FROM checkpoints WHERE workflow_id = ? AND execution_id = ?",
          )
          .run(input.workflowId, input.executionId);
        return Number(result.changes) > 0;
      }),
    );
  }

  protected override async pruneCheckpoints(
    input: Required<
      Pick<
        PruneWorkflowCheckpointsInput,
        "updatedBefore" | "statuses" | "limit"
      >
    > &
      Pick<PruneWorkflowCheckpointsInput, "workflowId">,
  ): Promise<PruneWorkflowCheckpointsResult> {
    if (input.statuses.length === 0) return { deleted: 0, hasMore: false };
    return this.#run("prune", () =>
      this.#db.transaction(() => {
        const marks = input.statuses.map(() => "?").join(", ");
        const parameters: SqliteValue[] = [
          input.updatedBefore,
          ...input.statuses,
        ];
        let workflowClause = "";
        if (input.workflowId !== undefined) {
          workflowClause = " AND workflow_id = ?";
          parameters.push(input.workflowId);
        }
        const doomed = this.#db
          .prepare(
            `SELECT workflow_id, execution_id FROM checkpoints
             WHERE updated_at < ? AND status IN (${marks})${workflowClause}
             ORDER BY workflow_id, execution_id LIMIT ?`,
          )
          .all(...parameters, input.limit + 1);
        const batch = doomed.slice(0, input.limit);
        const remove = this.#db.prepare(
          "DELETE FROM checkpoints WHERE workflow_id = ? AND execution_id = ?",
        );
        for (const row of batch) {
          remove.run(String(row.workflow_id), String(row.execution_id));
          this.#freeLease(String(row.workflow_id), String(row.execution_id));
        }
        return {
          deleted: batch.length,
          hasMore: doomed.length > batch.length,
        };
      }),
    );
  }

  protected override async acquireCheckpointLease(
    input: AcquireWorkflowCheckpointLeaseInput,
    now: number,
  ): Promise<WorkflowCheckpointLease> {
    return this.#run("acquire lease", () =>
      this.#db.transaction(() => {
        const current = this.#db
          .prepare(
            "SELECT owner_id, fencing_token, expires_at FROM leases WHERE workflow_id = ? AND execution_id = ?",
          )
          .get(input.workflowId, input.executionId);
        const owner = current?.owner_id;
        const expiresAtOfHolder = Number(current?.expires_at ?? 0);
        if (
          typeof owner === "string" &&
          owner !== input.ownerId &&
          now < expiresAtOfHolder
        ) {
          throw new WorkflowStorageError(
            "WORKFLOW_STORAGE_LEASE_HELD",
            "Another owner holds the lease of this execution",
            { details: { expiresAt: expiresAtOfHolder } },
          );
        }
        const fencingToken = Number(current?.fencing_token ?? 0) + 1;
        const expiresAt = now + input.ttlMs;
        this.#db
          .prepare(
            `INSERT INTO leases (workflow_id, execution_id, owner_id, fencing_token, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (workflow_id, execution_id) DO UPDATE SET
               owner_id = excluded.owner_id,
               fencing_token = excluded.fencing_token,
               expires_at = excluded.expires_at`,
          )
          .run(
            input.workflowId,
            input.executionId,
            input.ownerId,
            fencingToken,
            expiresAt,
          );
        return {
          workflowId: input.workflowId,
          executionId: input.executionId,
          ownerId: input.ownerId,
          fencingToken,
          expiresAt,
        };
      }),
    );
  }

  protected override async renewCheckpointLease(
    lease: WorkflowCheckpointLease,
    expiresAt: number,
  ): Promise<WorkflowCheckpointLease> {
    return this.#run("renew lease", () =>
      this.#db.transaction(() => {
        const result = this.#db
          .prepare(
            `UPDATE leases SET expires_at = ?
             WHERE workflow_id = ? AND execution_id = ? AND owner_id = ? AND fencing_token = ?`,
          )
          .run(
            expiresAt,
            lease.workflowId,
            lease.executionId,
            lease.ownerId,
            lease.fencingToken,
          );
        if (Number(result.changes) === 0) {
          throw leaseLost(lease.fencingToken, this.#currentToken(lease));
        }
        return { ...lease, expiresAt };
      }),
    );
  }

  protected override async releaseCheckpointLease(
    lease: WorkflowCheckpointLease,
  ): Promise<void> {
    await this.#run("release lease", () =>
      this.#db.transaction(() => {
        // The row and its token stay so the next lease still counts up.
        this.#db
          .prepare(
            `UPDATE leases SET owner_id = NULL, expires_at = 0
             WHERE workflow_id = ? AND execution_id = ? AND owner_id = ? AND fencing_token = ?`,
          )
          .run(
            lease.workflowId,
            lease.executionId,
            lease.ownerId,
            lease.fencingToken,
          );
      }),
    );
  }

  protected override async checkHealth(): Promise<number | undefined> {
    return this.#run("health check", () => {
      this.#db.prepare("SELECT 1 FROM checkpoints LIMIT 1").get();
      this.#db.prepare("SELECT 1 FROM leases LIMIT 1").get();
      // The write probe takes the write lock and is rolled back.
      const probe = new Error("rolled back health probe");
      try {
        this.#db.transaction(() => {
          this.#db
            .prepare(
              `INSERT INTO leases (workflow_id, execution_id, owner_id, fencing_token, expires_at)
               VALUES ('', '', NULL, 0, 0)
               ON CONFLICT (workflow_id, execution_id) DO UPDATE SET expires_at = expires_at`,
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

  protected override async closeStore(): Promise<void> {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Closing the last connection folds the log anyway; a busy log is not
      // a reason to fail the close.
    }
    this.#db.close();
  }

  /**
   * Frees the lease of a deleted execution. The row and its token stay, so
   * the next lease still counts up and a writer holding an old token can
   * never write again.
   */
  #freeLease(workflowId: string, executionId: string): void {
    this.#db
      .prepare(
        "UPDATE leases SET owner_id = NULL, expires_at = 0 WHERE workflow_id = ? AND execution_id = ?",
      )
      .run(workflowId, executionId);
  }

  #currentToken(locator: WorkflowCheckpointLocator): number {
    const row = this.#db
      .prepare(
        "SELECT fencing_token FROM leases WHERE workflow_id = ? AND execution_id = ?",
      )
      .get(locator.workflowId, locator.executionId);
    return Number(row?.fencing_token ?? 0);
  }

  #storedRevision(locator: WorkflowCheckpointLocator): string | null {
    const row = this.#db
      .prepare(
        "SELECT revision FROM checkpoints WHERE workflow_id = ? AND execution_id = ?",
      )
      .get(locator.workflowId, locator.executionId);
    return row === undefined ? null : String(row.revision);
  }

  async #run<T>(operation: string, body: () => T): Promise<T> {
    try {
      return await runWhileSqliteBusy(body, this.#busyWaitMs);
    } catch (error) {
      throw mapSqliteError(error, operation);
    }
  }
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

function leaseLost(given: number, current: number): WorkflowStorageError {
  return new WorkflowStorageError(
    "WORKFLOW_STORAGE_LEASE_LOST",
    "The lease of this execution was replaced; the write was not applied",
    { details: { fencingToken: given, currentFencingToken: current } },
  );
}

/**
 * Turns a SQLite failure into a typed storage error: a busy database is
 * retryable `UNAVAILABLE`, a damaged file is `CORRUPT`. Errors that are
 * already typed, and conflicts, pass through.
 */
function mapSqliteError(
  error: unknown,
  operation: string,
  where: { openingFile?: boolean } = {},
): unknown {
  if (error instanceof WorkflowStorageError) return error;
  if (error instanceof WorkflowCheckpointConflictError) return error;
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
    !where.openingFile && (primary === 26 || /not a database/i.test(message));
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
    // I/O error, full disk, file that cannot be opened: may pass.
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      `The SQLite database could not be used during ${operation}`,
      { cause: error, retryable: true },
    );
  }
  if (primary !== undefined || /readonly database/i.test(message)) {
    // A read-only file or mount, a permission change, a constraint or memory
    // failure: repeating the call does not help.
    return new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      `The SQLite database refused ${operation} (SQLite result code ${String(primary ?? "unknown")})`,
      { cause: error, retryable: false, details: { sqliteCode: primary } },
    );
  }
  return error;
}

function encodeCursor(entry: {
  workflowId: string;
  executionId: string;
}): string {
  return Buffer.from(
    JSON.stringify([entry.workflowId, entry.executionId]),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): {
  workflowId: string;
  executionId: string;
} {
  const invalid = () =>
    new WorkflowStorageError(
      "WORKFLOW_STORAGE_INVALID_OPTION",
      "cursor is not a cursor this provider returned",
      { details: { option: "cursor" } },
    );
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw invalid();
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { workflowId: parsed[0], executionId: parsed[1] };
    }
  } catch {
    // Falls through to the error below.
  }
  throw invalid();
}
