/**
 * The one place this package opens a SQLite database through the runtime's
 * built-in `node:sqlite`. The Claude session store, the workflow checkpoint
 * provider and the workflow event exporter all open their file here, so the
 * file mode, the symbolic-link check, WAL, the busy timeout, transactions and
 * schema versions behave the same in each.
 */

import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const MAX_BUSY_TIMEOUT_MS = 2 ** 31 - 1;
const VERSIONS_TABLE = "adk_llm_bridge_schema_versions";
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_NOTADB = 26;

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementHandle;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => NodeSqliteDatabase;
}

function loadNodeSqlite(): NodeSqliteModule {
  return createRequire(import.meta.url)("node:sqlite") as NodeSqliteModule;
}

function errcodeOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { errcode } = error as { errcode?: unknown };
  return typeof errcode === "number" ? errcode & 0xff : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A bound parameter or a column value. */
export type SqliteValue = string | number | bigint | null | Uint8Array;

/**
 * The subset of a `node:sqlite` prepared statement this package uses.
 *
 * @internal
 */
export interface SqliteStatementHandle {
  /** Runs the statement and returns the change count. */
  run(...parameters: SqliteValue[]): { changes: number | bigint };
  /** Returns the first row, or `undefined`. */
  get(...parameters: SqliteValue[]): Record<string, SqliteValue> | undefined;
  /** Returns every row. */
  all(...parameters: SqliteValue[]): Array<Record<string, SqliteValue>>;
}

/**
 * Why {@link openSqliteDatabase} failed, for the caller to turn into its own
 * typed error.
 *
 * - `unavailable`: the runtime has no `node:sqlite`.
 * - `invalid_option`: `busyTimeoutMs` is not an integer from 0 to 2147483647,
 *   or `path` is relative.
 * - `unsafe_path`: the path, or its `-wal` or `-shm` companion, is a symbolic
 *   link or not a regular file.
 * - `not_a_database`: the file is not a SQLite database.
 * - `schema_unsupported`: a component's stored schema version is newer than
 *   the one this package writes.
 *
 * @internal
 */
export type SqliteOpenFailure =
  | "unavailable"
  | "invalid_option"
  | "unsafe_path"
  | "not_a_database"
  | "schema_unsupported";

/**
 * Options of {@link openSqliteDatabase}.
 *
 * @internal
 */
export interface OpenSqliteDatabaseOptions {
  /** Database file, or `":memory:"`. */
  path: string;
  /**
   * Milliseconds a write waits for the database lock.
   *
   * @defaultValue 5000
   */
  busyTimeoutMs?: number;
  /**
   * SQLite `synchronous` level set on the connection.
   *
   * @defaultValue `"normal"`
   */
  synchronous?: "full" | "normal";
  /**
   * What to do when `path` exists and is a symbolic link. `reject` fails with
   * `unsafe_path`; `follow` opens the target (the behavior the Claude session
   * store shipped with). A missing file is always created with
   * `O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`, and its directory with
   * `0700`.
   *
   * @defaultValue `"reject"`
   */
  symlinks?: "reject" | "follow";
  /**
   * Builds the error to throw for a failure, so each caller keeps its own
   * error class and codes.
   */
  fail: (failure: SqliteOpenFailure, message: string, cause?: unknown) => Error;
}

/**
 * One forward-only schema step of a component.
 *
 * @internal
 */
export interface SqliteMigration {
  /** Version the database has after this step; steps are numbered from 1. */
  version: number;
  /** SQL that moves the schema from `version - 1` to `version`. */
  sql: string;
}

/**
 * Where a component keeps its schema version.
 *
 * - `user_version`: the database-wide `PRAGMA user_version` (the Claude
 *   session store, which shipped with it).
 * - `table`: one row per component in `adk_llm_bridge_schema_versions`, so
 *   several components can share one file.
 *
 * @internal
 */
export type SqliteSchemaVersionStorage = "user_version" | "table";

/**
 * An open database.
 *
 * @internal
 */
export interface SqliteDatabaseHandle {
  /** Runs SQL that returns no rows. */
  exec(sql: string): void;
  /** Prepares a statement. */
  prepare(sql: string): SqliteStatementHandle;
  /**
   * Runs `body` in a `BEGIN IMMEDIATE` transaction: it commits when `body`
   * returns and rolls back when it throws, keeping the first error.
   */
  transaction<T>(body: () => T): T;
  /**
   * Brings a component's schema to its newest version inside one
   * transaction, running only the steps the database has not seen. Fails
   * with `schema_unsupported` when the stored version is newer than the last
   * step.
   *
   * @returns The version before and after.
   */
  migrate(
    component: string,
    migrations: readonly SqliteMigration[],
    storage?: SqliteSchemaVersionStorage,
  ): { from: number; to: number };
  /** Reads a component's stored schema version; `0` when it has none. */
  schemaVersion(
    component: string,
    storage?: SqliteSchemaVersionStorage,
  ): number;
  /** Closes the database. Closing twice does nothing. */
  close(): void;
}

/**
 * Tells whether an error is SQLite reporting a busy or locked database
 * (`SQLITE_BUSY`, `SQLITE_LOCKED`), which a caller may retry.
 *
 * @param error - Error thrown by a statement.
 * @returns `true` for a busy or locked database.
 * @internal
 */
export function isSqliteBusyError(error: unknown): boolean {
  const code = errcodeOf(error);
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return true;
  if (!(error instanceof Error)) return false;
  return /SQLITE_(BUSY|LOCKED)|database (table )?is locked/i.test(
    error.message,
  );
}

/**
 * Busy timeout, in milliseconds, that a store which waits with
 * {@link runWhileSqliteBusy} sets on its connection: the longest a single
 * statement blocks the event loop.
 *
 * @internal
 */
export const SQLITE_BUSY_SLICE_MS = 20;

/**
 * Runs a synchronous database step and, while it fails because another
 * process holds the lock, tries again after an asynchronous pause until
 * `waitMs` has passed.
 *
 * @remarks
 * `node:sqlite` is synchronous: a long busy timeout freezes the event loop
 * and no timer, including an operation timeout, can fire. With a short busy
 * timeout on the connection ({@link SQLITE_BUSY_SLICE_MS}) the waiting
 * happens here instead, between statements. `body` must leave no transaction
 * open when it throws, so a new try starts clean.
 *
 * @param body - The step; it is run again after a busy failure.
 * @param waitMs - Total time to keep trying.
 * @returns The value of the first try that is not busy.
 * @throws The last error of `body` when it is not a busy error or the time
 * is up.
 * @internal
 */
export async function runWhileSqliteBusy<T>(
  body: () => T,
  waitMs: number,
): Promise<T> {
  const deadline = performance.now() + waitMs;
  for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
    try {
      return body();
    } catch (error) {
      const left = deadline - performance.now();
      if (!isSqliteBusyError(error) || left <= 0) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pause, left));
      });
    }
  }
}

/**
 * Opens a SQLite database with the settings every store of this package
 * needs: the file created `0600` without following a symbolic link, WAL
 * journal mode, the busy timeout and the `synchronous` level.
 *
 * @remarks
 * `node:sqlite` is loaded here, on the first call, through `createRequire`,
 * so importing a module that uses this helper never needs the runtime module.
 *
 * @param options - Path, timeouts, symbolic-link rule and the error factory.
 * @returns The open database.
 * @throws The error built by `options.fail` for each {@link SqliteOpenFailure}.
 * Other I/O errors (a directory that cannot be created, `SQLITE_CANTOPEN`)
 * are thrown as they are.
 * @internal
 */
export function openSqliteDatabase(
  options: OpenSqliteDatabaseOptions,
): SqliteDatabaseHandle {
  const { path, fail } = options;
  const timeout = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > MAX_BUSY_TIMEOUT_MS
  ) {
    throw fail(
      "invalid_option",
      `busyTimeoutMs must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}; got ${String(options.busyTimeoutMs)}.`,
    );
  }
  const synchronous = options.synchronous ?? "normal";
  const symlinks = options.symlinks ?? "reject";
  const inMemory = path === ":memory:";
  if (!inMemory && !isAbsolute(path)) {
    throw fail(
      "invalid_option",
      `The database path must be absolute or ":memory:"; got ${JSON.stringify(path)}.`,
    );
  }

  let sqlite: NodeSqliteModule;
  try {
    sqlite = loadNodeSqlite();
  } catch (error) {
    throw fail(
      "unavailable",
      "The built-in node:sqlite module is not available: it needs Node 22.13 or later, or Bun. On Node 22.5 to 22.12 run with --experimental-sqlite.",
      error,
    );
  }
  if (!inMemory) prepareFile(path, symlinks, fail);

  let raw: NodeSqliteDatabase | undefined;
  try {
    raw = new sqlite.DatabaseSync(path, { timeout });
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(`PRAGMA busy_timeout = ${timeout}`);
    raw.exec(
      `PRAGMA synchronous = ${synchronous === "full" ? "FULL" : "NORMAL"}`,
    );
  } catch (error) {
    // The first statements are the first to read the file.
    tryClose(raw);
    if (
      errcodeOf(error) === SQLITE_NOTADB ||
      /not a database/i.test(messageOf(error))
    ) {
      throw fail(
        "not_a_database",
        `The file at ${path} is not a SQLite database.`,
        error,
      );
    }
    throw error;
  }
  return new Handle(raw, fail);
}

function tryClose(db: NodeSqliteDatabase | undefined): void {
  try {
    db?.close();
  } catch {
    // Nothing more to release.
  }
}

function lstatOrUndefined(
  path: string,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Checks what is at `path` and creates the file and its directory when it is
 * missing. Nothing is created when the check fails.
 */
function prepareFile(
  path: string,
  symlinks: "reject" | "follow",
  fail: OpenSqliteDatabaseOptions["fail"],
): void {
  const unsafe = (what: string): Error =>
    fail("unsafe_path", `The database path ${path} ${what}.`);
  if (symlinks === "reject") {
    // The directory that holds the file is checked too: a link there would
    // put the database, and its -wal and -shm files, somewhere else. Links
    // higher up belong to the host's layout (on macOS, /var is one).
    if (lstatOrUndefined(dirname(path))?.isSymbolicLink()) {
      throw unsafe("is in a directory that is a symbolic link");
    }
    for (const suffix of ["-wal", "-shm"]) {
      const companion = lstatOrUndefined(path + suffix);
      if (companion?.isSymbolicLink()) {
        throw unsafe(`has a symbolic link at ${suffix}`);
      }
      if (companion !== undefined) ownerOnly(path + suffix, companion, unsafe);
    }
  }
  const info = lstatOrUndefined(path);
  if (info === undefined) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(
        openSync(
          path,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        ),
      );
    } catch (error) {
      // Another process created it first: check what it made.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const raced = lstatSync(path);
      if (raced.isSymbolicLink() || !raced.isFile()) {
        throw unsafe("is not a regular file");
      }
    }
    return;
  }
  if (info.isSymbolicLink()) {
    if (symlinks === "reject") throw unsafe("is a symbolic link");
    let target: ReturnType<typeof statSync> | undefined;
    try {
      target = statSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (target === undefined) {
      // A dangling link: opening for append creates the target.
      closeSync(openSync(path, "a", 0o600));
    } else if (!target.isFile()) {
      throw unsafe("does not lead to a regular file");
    }
    return;
  }
  if (!info.isFile()) throw unsafe("is not a regular file");
  // SQLite gives -wal and -shm the mode of the database file, so tightening
  // the file keeps all three owner-only.
  if (symlinks === "reject") ownerOnly(path, info, unsafe);
}

/** Sets an existing file to `0600` when others can read or write it. */
function ownerOnly(
  path: string,
  info: Stats | BigIntStats,
  unsafe: (what: string) => Error,
): void {
  if ((Number(info.mode) & 0o077) === 0) return;
  if (!info.isFile())
    throw unsafe("has a companion that is not a regular file");
  try {
    chmodSync(path, 0o600);
  } catch {
    throw unsafe("can be read by other users and its mode cannot be changed");
  }
}

class Handle implements SqliteDatabaseHandle {
  readonly #db: NodeSqliteDatabase;
  readonly #fail: OpenSqliteDatabaseOptions["fail"];
  #closed = false;

  constructor(db: NodeSqliteDatabase, fail: OpenSqliteDatabaseOptions["fail"]) {
    this.#db = db;
    this.#fail = fail;
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): SqliteStatementHandle {
    return this.#db.prepare(sql);
  }

  transaction<T>(body: () => T): T {
    // IMMEDIATE takes the write lock up front, so a concurrent writer waits
    // on the busy timeout instead of failing mid-transaction.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may have rolled back already (a full disk, an interrupt, a
      // RAISE(ROLLBACK)); then ROLLBACK itself fails. Keep the first error.
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Nothing left to roll back.
      }
      throw error;
    }
  }

  schemaVersion(
    component: string,
    storage: SqliteSchemaVersionStorage = "table",
  ): number {
    if (storage === "user_version") {
      const row = this.#db.prepare("PRAGMA user_version").get();
      return this.#checkedVersion(component, row?.user_version ?? 0);
    }
    const exists = this.#db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(VERSIONS_TABLE);
    if (exists === undefined) return 0;
    const row = this.#db
      .prepare(`SELECT version FROM ${VERSIONS_TABLE} WHERE component = ?`)
      .get(component);
    return this.#checkedVersion(component, row?.version ?? 0);
  }

  /**
   * A marker that is not a whole number is refused: `Number` would make it
   * `NaN`, every comparison with it false, and the file would be trusted.
   */
  #checkedVersion(component: string, stored: SqliteValue): number {
    const version =
      typeof stored === "bigint" ? Number(stored) : (stored as unknown);
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      throw this.#fail(
        "schema_unsupported",
        `The ${component} database has an unreadable schema version ${JSON.stringify(String(stored)).slice(0, 80)}; it was not written by adk-llm-bridge.`,
      );
    }
    return version;
  }

  migrate(
    component: string,
    migrations: readonly SqliteMigration[],
    storage: SqliteSchemaVersionStorage = "table",
  ): { from: number; to: number } {
    migrations.forEach((step, index) => {
      if (step.version !== index + 1) {
        throw new Error(
          `Migrations of ${component} must be numbered 1, 2, 3 in order; step ${index + 1} is version ${step.version}.`,
        );
      }
    });
    const last = migrations.length;
    const refuseNewer = (from: number): void => {
      if (from > last) {
        throw this.#fail(
          "schema_unsupported",
          `The ${component} database has schema version ${from}; this version of adk-llm-bridge reads version ${last}. Upgrade adk-llm-bridge.`,
        );
      }
    };
    // Refuse a newer schema before asking for the write lock, so a locked or
    // read-only file still reports the typed failure; the check is repeated
    // inside the transaction in case another process migrated in between.
    refuseNewer(this.schemaVersion(component, storage));
    return this.transaction(() => {
      const from = this.schemaVersion(component, storage);
      refuseNewer(from);
      for (const step of migrations) {
        if (step.version > from) this.#db.exec(step.sql);
      }
      if (last > from) this.#writeVersion(component, storage, last);
      return { from, to: Math.max(from, last) };
    });
  }

  #writeVersion(
    component: string,
    storage: SqliteSchemaVersionStorage,
    version: number,
  ): void {
    if (storage === "user_version") {
      this.#db.exec(`PRAGMA user_version = ${version}`);
      return;
    }
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (component TEXT PRIMARY KEY, version INTEGER NOT NULL)`,
    );
    this.#db
      .prepare(
        `INSERT INTO ${VERSIONS_TABLE} (component, version) VALUES (?, ?)
         ON CONFLICT (component) DO UPDATE SET version = excluded.version`,
      )
      .run(component, version);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}
