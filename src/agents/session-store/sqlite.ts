import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  openSqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteOpenFailure,
  type SqliteStatementHandle,
} from "../../utils/sqlite-database.js";
import type { SessionKey, SessionStore, SessionStoreEntry } from "./types.js";

/** Codes of {@link SqliteSessionStoreError}. */
export type SqliteSessionStoreErrorCode =
  | "SESSION_STORE_SQLITE_UNAVAILABLE"
  | "SESSION_STORE_INVALID_KEY"
  | "SESSION_STORE_INVALID_ENTRY"
  | "SESSION_STORE_INVALID_OPTION"
  | "SESSION_STORE_SCHEMA_UNSUPPORTED"
  | "SESSION_STORE_UNSAFE_PATH";

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
 * - `SESSION_STORE_UNSAFE_PATH`: the database path is a symlink or not a
 *   regular file, the file is owned by another user, or its directory is
 *   not a directory, is owned by another user (other than root), or can be
 *   written by others without the sticky bit.
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

const TABLE = "claude_session_entries";
// The main transcript has no subpath; the SDK forbids an empty one, so ''
// stands for "main" and keeps the unique index free of NULL subpaths.
const MAIN = "";
const MAX_BUSY_TIMEOUT_MS = 2 ** 31 - 1;
const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    sql: `
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
    `,
  },
];

/**
 * Creates or checks the database file before SQLite opens it.
 *
 * @remarks
 * Security invariant (POSIX): session transcripts never go to a file another
 * user controls or reads.
 * - The directory is created `0700` when missing. An existing one is checked
 *   at its real path and left as it is: it must be a directory owned by this
 *   user or root, and not writable by others unless it has the sticky bit
 *   (like `/tmp`). It is not tightened, since it may be a directory the user
 *   chose, such as the project directory.
 * - The file is opened with `O_NOFOLLOW`, so a symlink planted at the path
 *   (dangling or not) is refused instead of followed. A new file is created
 *   with `O_EXCL` and set to `0600` with `fchmod`, whatever the umask;
 *   SQLite gives the `-wal` and `-shm` files the database file's mode. An
 *   existing file keeps its mode and must be a regular file owned by this
 *   user.
 * - On Windows there is no `O_NOFOLLOW`, POSIX owner or mode: a symbolic link
 *   or junction at the path is refused from `lstat` before the open (a link
 *   swapped in after that check is not caught), `O_EXCL` still refuses one
 *   that appears while the file is created, and no owner or mode check is
 *   made, because NTFS access follows the directory's ACL.
 *
 * @param path - The database path.
 * @throws {@link SqliteSessionStoreError} with code
 * `SESSION_STORE_UNSAFE_PATH` when a check fails.
 */
function prepareDatabaseFile(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const unsafe = (reason: string, cause?: unknown) =>
    new SqliteSessionStoreError(
      "SESSION_STORE_UNSAFE_PATH",
      `Refusing the session store database ${path}: ${reason}.`,
      cause === undefined ? undefined : { cause },
    );
  if (uid !== undefined) {
    // statSync follows symlinks, so the checks apply to the real directory.
    const dir = statSync(directory);
    if (!dir.isDirectory()) {
      throw unsafe(`${directory} is not a directory`);
    }
    if (dir.uid !== uid && dir.uid !== 0) {
      throw unsafe(`its directory ${directory} is owned by another user`);
    }
    if ((dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0) {
      throw unsafe(
        `its directory ${directory} can be written by other users and has no sticky bit`,
      );
    }
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0) {
    // Without `O_NOFOLLOW` the open would follow a link: look first.
    let link: ReturnType<typeof lstatSync> | undefined;
    try {
      link = lstatSync(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (link?.isSymbolicLink()) throw unsafe("the path is a symlink");
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw wrapOpenError(error, unsafe);
    try {
      fd = openSync(path, constants.O_RDWR | noFollow);
    } catch (reopenError) {
      throw wrapOpenError(reopenError, unsafe);
    }
  }
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) {
      throw unsafe("it is not a regular file");
    }
    if (uid !== undefined && file.uid !== uid) {
      throw unsafe("the file is owned by another user");
    }
  } finally {
    closeSync(fd);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** `ELOOP` (and `EMLINK` on some BSDs) is how `O_NOFOLLOW` refuses a symlink. */
function wrapOpenError(
  error: unknown,
  unsafe: (reason: string, cause?: unknown) => SqliteSessionStoreError,
): unknown {
  const code = errorCode(error);
  return code === "ELOOP" || code === "EMLINK"
    ? unsafe("the path is a symlink", error)
    : error;
}

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
  readonly #db: SqliteDatabaseHandle;
  readonly #upsert: SqliteStatementHandle;
  readonly #insert: SqliteStatementHandle;

  /**
   * Opens (and creates when missing) the database.
   *
   * @param options - The database file and busy timeout.
   * @throws {@link SqliteSessionStoreError} with code
   * `SESSION_STORE_INVALID_OPTION` for a bad `busyTimeoutMs` (checked before
   * any file is created), `SESSION_STORE_SQLITE_UNAVAILABLE` when the runtime
   * has no `node:sqlite`, `SESSION_STORE_UNSAFE_PATH` when the path or its
   * directory fails the safety checks (a symlink at the path, a file or
   * directory owned by another user, a directory others can write without
   * the sticky bit), or `SESSION_STORE_SCHEMA_UNSUPPORTED` when a newer
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
    const path =
      options.path === ":memory:" ? ":memory:" : resolve(options.path);
    if (path !== ":memory:") {
      prepareDatabaseFile(path);
    }
    // prepareDatabaseFile has created or checked the file without following
    // a symlink, so the helper opens that checked file as it is.
    this.#db = openSqliteDatabase({
      path,
      busyTimeoutMs: timeout,
      synchronous: "full",
      symlinks: "follow",
      fail: failOpen,
    });
    try {
      // Take the write lock even when the schema is current, as this store
      // always did.
      this.#db.migrate("session store", SCHEMA_MIGRATIONS, "user_version", {
        lockWhenCurrent: true,
      });
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
    this.#db.transaction(() => {
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

function failOpen(
  failure: SqliteOpenFailure,
  message: string,
  cause?: unknown,
): Error {
  switch (failure) {
    case "unavailable":
      return new SqliteSessionStoreError(
        "SESSION_STORE_SQLITE_UNAVAILABLE",
        "SqliteSessionStore needs the built-in node:sqlite module: Node 22.13 or later, or Bun. On Node 22.5 to 22.12 run with --experimental-sqlite.",
        { cause },
      );
    case "invalid_option":
      return new SqliteSessionStoreError(
        "SESSION_STORE_INVALID_OPTION",
        message,
      );
    case "schema_unsupported":
      return new SqliteSessionStoreError(
        "SESSION_STORE_SCHEMA_UNSUPPORTED",
        message,
      );
    default:
      // `not_a_database` rethrows the plain `node:sqlite` error; `unsafe_path`
      // (a directory or FIFO at the path) has no cause and gets a plain Error.
      return cause instanceof Error ? cause : new Error(message, { cause });
  }
}
