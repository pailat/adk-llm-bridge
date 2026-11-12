/**
 * A plain SQLite connection for tests that need a second connection next to
 * the one under test (to hold a lock, change the schema or read it back). It
 * uses the built-in `node:sqlite`, which Bun and Node both provide on recent
 * versions. A host without it cannot open a connection, so a suite that uses
 * this file checks {@link nodeSqliteAvailable} and skips itself when it is false.
 */

import { createRequire } from "node:module";

type Statement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
};

/** The part of a `node:sqlite` connection the tests use. */
export interface RawDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Same as {@link RawDatabase.prepare}; the name `bun:sqlite` uses. */
  query(sql: string): Statement;
  close(): void;
}

export type NodeSqlite = {
  DatabaseSync: new (path: string) => Omit<RawDatabase, "query">;
};

/** Loads `node:sqlite`, or returns `undefined` when the host does not have it. */
export function loadNodeSqlite(
  load: (specifier: string) => unknown = createRequire(import.meta.url),
): NodeSqlite | undefined {
  try {
    const module = load("node:sqlite") as Partial<NodeSqlite>;
    return typeof module.DatabaseSync === "function"
      ? (module as NodeSqlite)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this host provides `node:sqlite` (checked once, when the module loads). */
export const nodeSqliteAvailable: boolean = loadNodeSqlite() !== undefined;

/** Opens (and creates, when missing) the database file at `path`. */
export function openRawDatabase(path: string): RawDatabase {
  return openRawDatabaseWith(createRequire(import.meta.url), path);
}

/** Same as {@link openRawDatabase}, loading `node:sqlite` through `load`. */
export function openRawDatabaseWith(
  load: (specifier: string) => unknown,
  path: string,
): RawDatabase {
  const sqlite = loadNodeSqlite(load);
  if (sqlite === undefined) {
    throw new Error(
      "node:sqlite is not available on this host; check nodeSqliteAvailable and skip the suite before calling openRawDatabase",
    );
  }
  const database = new sqlite.DatabaseSync(path);
  return Object.assign(database, {
    query: (sql: string) => database.prepare(sql),
  });
}
