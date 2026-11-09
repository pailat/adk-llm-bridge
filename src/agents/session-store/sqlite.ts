import { closeSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "./types.js";

/** Codes of {@link SqliteSessionStoreError}. */
export type SqliteSessionStoreErrorCode =
  | "SESSION_STORE_SQLITE_UNAVAILABLE"
  | "SESSION_STORE_INVALID_KEY"
  | "SESSION_STORE_INVALID_ENTRY"
  | "SESSION_STORE_INVALID_OPTION"
  | "SESSION_STORE_SCHEMA_UNSUPPORTED";

/**
 * Error raised by {@link SqliteSessionStore}, discriminated by
 * {@link SqliteSessionStoreErrorCode}.
 *
 * @remarks
 * - `SESSION_STORE_SQLITE_UNAVAILABLE`: the runtime has no built-in
 *   `node:sqlite` (Node before 22.13 without `--experimental-sqlite`, or a
 *   runtime that does not provide it).
 * - `SESSION_STORE_INVALID_KEY`: an empty `projectKey` or `sessionId`, or an
 *   empty-string `subpath`.
 * - `SESSION_STORE_INVALID_ENTRY`: an entry that is not a JSON object, that
 *   JSON cannot represent (a `bigint`, a cycle; `cause` holds the
 *   serialization error), or whose `toJSON()` gives something other than a
 *   JSON object.
 * - `SESSION_STORE_INVALID_OPTION`: a `busyTimeoutMs` that is not an integer
 *   from 0 to 2147483647.
 * - `SESSION_STORE_SCHEMA_UNSUPPORTED`: the database was written by a newer
 *   version of the store.
 *
 * @experimental
 */
export class SqliteSessionStoreError extends Error {
  /** Machine-readable failure code. */
  readonly code: SqliteSessionStoreErrorCode;

  /**
   * Creates the error for a store failure.
   *
   * @param code - Failure code.
   * @param message - Human-readable description.
   * @param options - Standard error options; `cause` holds the underlying
   * error.
   */
  constructor(
    code: SqliteSessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteSessionStoreError";
    this.code = code;
  }
}

/** Options of {@link SqliteSessionStore}. */
export interface SqliteSessionStoreOptions {
  /**
   * Database file. Created with mode `0600` when missing (transcripts can
   * hold tool output and file contents), and its directory with `0700`. An
   * existing file keeps its mode, and SQLite gives the `-wal` and `-shm` files the
   * mode of the database file. `":memory:"` keeps the data in memory.
   */
  path: string;
  /**
   * Milliseconds a write waits for another process holding the database
   * lock before it fails: an integer from 0 to 2147483647 (SQLite's limit).
   *
   * @defaultValue 5000
   */
  busyTimeoutMs?: number;
}

/** The subset of `node:sqlite` the store uses. */
interface SqliteStatement {
  run(...parameters: Array<string | number | null>): unknown;
  get(...parameters: Array<string | number | null>): unknown;
  all(...parameters: Array<string | number | null>): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => SqliteDatabase;
};

const SCHEMA_VERSION = 1;
const TABLE = "claude_session_entries";
// The main transcript has no subpath; the SDK forbids an empty one, so ''
// stands for "main" and keeps the unique index free of NULL subpaths.
const MAIN = "";
const MAX_BUSY_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * A {@link SessionStore} that keeps Claude session transcripts in a SQLite
 * file, through the runtime's built-in `node:sqlite`.
 *
 * @remarks
 * Runs on Node 22.13 and later (Node 22 prints an `ExperimentalWarning` for
 * `node:sqlite`) and on Bun; it adds no dependency. Entries are stored as
 * JSON text in append order; an entry with a `uuid` the transcript already
 * holds replaces the stored one in place, so retried and replayed batches
 * add no rows. The database uses WAL mode and a busy timeout, and each
 * `append` is one transaction, so several processes can share the file.
 * Retention is up to the caller: the store deletes only through `delete`.
 *
 * @example
 * ```ts
 * import { ClaudeAgent } from "adk-llm-bridge/agents";
 * import { SqliteSessionStore } from "adk-llm-bridge/agents/session-store/sqlite";
 *
 * const sessionStore = new SqliteSessionStore({ path: "./data/claude-sessions.db" });
 * const agent = new ClaudeAgent({
 *   name: "coder",
 *   workingDirectory: process.cwd(),
 *   driverOptions: { sessionStore },
 * });
 * ```
 *
 * @experimental Implements the Claude Agent SDK's `@alpha` session store
 * contract.
 */
export class SqliteSessionStore implements SessionStore {
  readonly #db: SqliteDatabase;
  readonly #upsert: SqliteStatement;
  readonly #insert: SqliteStatement;

  /**
   * Opens (and creates when missing) the database.
   *
   * @param options - The database file and busy timeout.
   * @throws {@link SqliteSessionStoreError} with code
   * `SESSION_STORE_INVALID_OPTION` for a bad `busyTimeoutMs` (checked before
   * any file is created), `SESSION_STORE_SQLITE_UNAVAILABLE` when the runtime
   * has no `node:sqlite`, or `SESSION_STORE_SCHEMA_UNSUPPORTED` when a newer
   * store wrote the file. A file that is not a SQLite database, and any use
   * after {@link SqliteSessionStore.close}, throw the plain `node:sqlite`
   * error.
   */
  constructor(options: SqliteSessionStoreOptions) {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (
      !Number.isInteger(timeout) ||
      timeout < 0 ||
      timeout > MAX_BUSY_TIMEOUT_MS
    ) {
      throw new SqliteSessionStoreError(
        "SESSION_STORE_INVALID_OPTION",
        `busyTimeoutMs must be an integer from 0 to ${MAX_BUSY_TIMEOUT_MS}; got ${String(options.busyTimeoutMs)}.`,
      );
    }
    const { DatabaseSync } = loadSqlite();
    if (options.path !== ":memory:") {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
      // SQLite creates new files 0644; create it first so the mode is ours.
      // SQLite gives the -wal and -shm files the mode of the database file.
      closeSync(openSync(options.path, "a", 0o600));
    }
    this.#db = new DatabaseSync(options.path, { timeout });
    try {
      this.#migrate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
    this.#upsert = this.#db.prepare(
      `INSERT INTO ${TABLE} (project_key, session_id, subpath, uuid, entry, mtime)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_key, session_id, subpath, uuid)
       DO UPDATE SET entry = excluded.entry, mtime = excluded.mtime`,
    );
    // Entries without a uuid are never deduplicated.
    this.#insert = this.#db.prepare(
      `INSERT INTO ${TABLE} (project_key, session_id, subpath, uuid, entry, mtime)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    );
  }

  #migrate(): void {
    this.#db.exec("PRAGMA journal_mode = WAL");
    const row = this.#db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (row.user_version > SCHEMA_VERSION) {
      throw new SqliteSessionStoreError(
        "SESSION_STORE_SCHEMA_UNSUPPORTED",
        `The session store database has schema version ${row.user_version}; this version of adk-llm-bridge reads version ${SCHEMA_VERSION}. Upgrade adk-llm-bridge.`,
      );
    }
    this.#transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          project_key TEXT NOT NULL,
          session_id TEXT NOT NULL,
          subpath TEXT NOT NULL,
          uuid TEXT,
          entry TEXT NOT NULL,
          mtime INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_uuid
          ON ${TABLE} (project_key, session_id, subpath, uuid);
        CREATE INDEX IF NOT EXISTS ${TABLE}_key
          ON ${TABLE} (project_key, session_id, subpath, seq);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
  }

  #transaction(body: () => void): void {
    // IMMEDIATE takes the write lock up front, so a concurrent writer waits
    // on the busy timeout instead of failing mid-transaction.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      body();
      this.#db.exec("COMMIT");
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

  /**
   * Stores entries after the existing ones of `key`; an entry whose `uuid`
   * the transcript already holds replaces the stored one in place. Only a
   * non-empty string `uuid` is an idempotency key: an entry with no `uuid`,
   * or an empty one, is always appended (refusing it would make the SDK
   * drop the whole batch after its retries).
   *
   * @param key - The transcript.
   * @param entries - The new entries, stored in this order.
   * @throws {@link SqliteSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY` or `SESSION_STORE_INVALID_ENTRY`; nothing of
   * the batch is stored then.
   */
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const { projectKey, sessionId, subpath } = checkKey(key);
    const rows = entries.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SqliteSessionStoreError(
          "SESSION_STORE_INVALID_ENTRY",
          `Session store entry ${index} is not a JSON object.`,
        );
      }
      // `JSON.stringify` gives `undefined` or a non-object when the entry
      // has a `toJSON` method; only a JSON object starts with `{`.
      let json: string | undefined;
      try {
        json = JSON.stringify(entry) as string | undefined;
      } catch (error) {
        throw new SqliteSessionStoreError(
          "SESSION_STORE_INVALID_ENTRY",
          `Session store entry ${index} cannot be stored as JSON.`,
          { cause: error },
        );
      }
      if (typeof json !== "string" || !json.startsWith("{")) {
        throw new SqliteSessionStoreError(
          "SESSION_STORE_INVALID_ENTRY",
          `Session store entry ${index} does not serialize to a JSON object.`,
        );
      }
      return {
        uuid:
          typeof entry.uuid === "string" && entry.uuid !== ""
            ? entry.uuid
            : undefined,
        json,
      };
    });
    if (rows.length === 0) return;
    const mtime = Date.now();
    this.#transaction(() => {
      for (const row of rows) {
        if (row.uuid === undefined) {
          this.#insert.run(projectKey, sessionId, subpath, row.json, mtime);
        } else {
          this.#upsert.run(
            projectKey,
            sessionId,
            subpath,
            row.uuid,
            row.json,
            mtime,
          );
        }
      }
    });
  }

  /**
   * Reads a whole transcript.
   *
   * @param key - The transcript.
   * @returns Its entries in append order, or `null` when nothing is stored.
   * @throws {@link SqliteSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY`.
   */
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const { projectKey, sessionId, subpath } = checkKey(key);
    const rows = this.#db
      .prepare(
        `SELECT entry FROM ${TABLE}
         WHERE project_key = ? AND session_id = ? AND subpath = ?
         ORDER BY seq`,
      )
      .all(projectKey, sessionId, subpath) as Array<{ entry: string }>;
    if (rows.length === 0) return null;
    return rows.map((row) => JSON.parse(row.entry) as SessionStoreEntry);
  }

  /**
   * Lists the sessions of a project that have a main transcript.
   *
   * @param projectKey - The project scope.
   * @returns Each session id with the time of its last main-transcript write,
   * in Unix epoch milliseconds.
   */
  async listSessions(
    projectKey: string,
  ): Promise<Array<{ sessionId: string; mtime: number }>> {
    const rows = this.#db
      .prepare(
        `SELECT session_id, MAX(mtime) AS mtime FROM ${TABLE}
         WHERE project_key = ? AND subpath = ?
         GROUP BY session_id`,
      )
      .all(projectKey, MAIN) as Array<{ session_id: string; mtime: number }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      mtime: Number(row.mtime),
    }));
  }

  /**
   * Lists the subagent transcripts of a session.
   *
   * @param key - The session.
   * @returns The `subpath` of each subagent transcript.
   */
  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const { projectKey, sessionId } = checkKey(key);
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT subpath FROM ${TABLE}
         WHERE project_key = ? AND session_id = ? AND subpath <> ?`,
      )
      .all(projectKey, sessionId, MAIN) as Array<{ subpath: string }>;
    return rows.map((row) => row.subpath);
  }

  /**
   * Deletes a transcript. Deleting a main transcript also deletes the
   * session's subagent transcripts.
   *
   * @param key - The transcript.
   * @throws {@link SqliteSessionStoreError} with code
   * `SESSION_STORE_INVALID_KEY`.
   */
  async delete(key: SessionKey): Promise<void> {
    const { projectKey, sessionId, subpath } = checkKey(key);
    if (subpath === MAIN) {
      this.#db
        .prepare(
          `DELETE FROM ${TABLE} WHERE project_key = ? AND session_id = ?`,
        )
        .run(projectKey, sessionId);
      return;
    }
    this.#db
      .prepare(
        `DELETE FROM ${TABLE}
         WHERE project_key = ? AND session_id = ? AND subpath = ?`,
      )
      .run(projectKey, sessionId, subpath);
  }

  /** Closes the database. The store cannot be used afterwards. */
  close(): void {
    this.#db.close();
  }
}

function checkKey(key: {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}): { projectKey: string; sessionId: string; subpath: string } {
  const valid =
    typeof key?.projectKey === "string" &&
    key.projectKey !== "" &&
    typeof key.sessionId === "string" &&
    key.sessionId !== "" &&
    (key.subpath === undefined ||
      (typeof key.subpath === "string" && key.subpath !== MAIN));
  if (!valid) {
    throw new SqliteSessionStoreError(
      "SESSION_STORE_INVALID_KEY",
      "A session key needs a non-empty projectKey and sessionId, and a subpath that is absent or non-empty.",
    );
  }
  return {
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    subpath: key.subpath ?? MAIN,
  };
}

function loadSqlite(): SqliteModule {
  try {
    return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } catch (error) {
    throw new SqliteSessionStoreError(
      "SESSION_STORE_SQLITE_UNAVAILABLE",
      "SqliteSessionStore needs the built-in node:sqlite module: Node 22.13 or later, or Bun. On Node 22.5 to 22.12 run with --experimental-sqlite.",
      { cause: error },
    );
  }
}
