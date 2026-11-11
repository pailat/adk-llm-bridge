/**
 * A plain SQLite connection for tests that need a second connection next to
 * the one under test (to hold a lock, change the schema or read it back). It
 * uses the built-in `node:sqlite`, which Bun and Node both provide, so a suite
 * using it runs on both.
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

/** Opens (and creates, when missing) the database file at `path`. */
export function openRawDatabase(path: string): RawDatabase {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => Omit<RawDatabase, "query">;
  };
  const database = new DatabaseSync(path);
  return Object.assign(database, {
    query: (sql: string) => database.prepare(sql),
  });
}
