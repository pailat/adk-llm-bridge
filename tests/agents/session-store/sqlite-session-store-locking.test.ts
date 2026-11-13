import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionStore } from "../../../src/agents/session-store/sqlite.js";
import {
  nodeSqliteAvailable,
  openRawDatabase,
} from "../../utils/fixtures/raw-sqlite.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Needs the built-in `node:sqlite`: the store and the raw fixture both load it.
test.skipIf(!nodeSqliteAvailable)(
  "opening a current-schema file waits for another connection's write lock, as the shipped store did",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "session-store-lock-"));
    dirs.push(dir);
    const path = join(dir, "s.db");
    new SqliteSessionStore({ path }).close();
    const holder = openRawDatabase(path);
    try {
      holder.exec("BEGIN IMMEDIATE");
      expect(
        () => new SqliteSessionStore({ path, busyTimeoutMs: 0 }),
      ).toThrow();
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    new SqliteSessionStore({ path, busyTimeoutMs: 0 }).close();
  },
);
