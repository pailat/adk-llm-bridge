import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenSqliteDatabaseOptions,
  openSqliteDatabase,
  type SqliteSchemaVersionStorage,
} from "../../src/utils/sqlite-database.js";
import { SqliteWorkflowCheckpointStore } from "../../src/workflows/checkpoint/sqlite/index.js";
import { SqliteWorkflowEventExporter } from "../../src/workflows/events/sqlite/index.js";

const holderScript = join(
  import.meta.dir,
  "fixtures",
  "sqlite-write-holder.ts",
);
const directories: string[] = [];
const holders: Array<ReturnType<typeof Bun.spawn>> = [];

// Opening must not wait for the lock at all. The default busy timeout is
// 5000 ms, so a wait shows as seconds; this bound leaves room for a slow
// machine.
const OPEN_BOUND_MS = 1_000;

const fail: OpenSqliteDatabaseOptions["fail"] = (failure, message, cause) =>
  Object.assign(new Error(message, { cause }), { failure });

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill(9);
    await holder.exited;
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-open-locked-"));
  directories.push(dir);
  return join(dir, name);
}

/** Starts a process that holds the write lock of `path` until it is killed. */
async function holdWriteLock(path: string): Promise<void> {
  const holder = Bun.spawn([process.execPath, holderScript, path], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  holders.push(holder);
  const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  const text = chunk.done ? "" : new TextDecoder().decode(chunk.value);
  if (text.trim() !== "locked") {
    throw new Error(
      `the holder did not lock: ${text} ${await new Response(holder.stderr as ReadableStream).text()}`,
    );
  }
}

/** Milliseconds `open` blocks the calling thread. */
function blockedMs(open: () => void): number {
  const started = performance.now();
  open();
  return performance.now() - started;
}

describe("opening a SQLite database whose schema is current while another process writes", () => {
  test("the checkpoint store opens without waiting for the write lock", async () => {
    const path = tempPath("checkpoints.db");
    new SqliteWorkflowCheckpointStore({ path }).close();
    await holdWriteLock(path);

    let store: SqliteWorkflowCheckpointStore | undefined;
    const elapsed = blockedMs(() => {
      store = new SqliteWorkflowCheckpointStore({ path });
    });
    try {
      expect(elapsed).toBeLessThan(OPEN_BOUND_MS);
      expect(
        await store?.load({
          workflowId: "wf",
          executionId: "missing",
          // The store does not read the invocation context.
          context: {} as never,
        }),
      ).toBeUndefined();
    } finally {
      await store?.close();
    }
  }, 30_000);

  test("the event exporter opens without waiting for the write lock", async () => {
    const path = tempPath("events.db");
    await new SqliteWorkflowEventExporter({ path }).close();
    await holdWriteLock(path);

    let exporter: SqliteWorkflowEventExporter | undefined;
    const elapsed = blockedMs(() => {
      exporter = new SqliteWorkflowEventExporter({ path });
    });
    try {
      expect(elapsed).toBeLessThan(OPEN_BOUND_MS);
      const page = await exporter?.read({ executionId: "missing" });
      expect(page?.records).toEqual([]);
    } finally {
      await exporter?.close();
    }
  }, 30_000);

  for (const storage of ["table", "user_version"] as const) {
    test(`the shared helper reports a current schema (${storage} marker) without taking the write lock`, async () => {
      const path = tempPath(`helper-${storage}.db`);
      const migrations = [
        { version: 1, sql: "CREATE TABLE items (id TEXT PRIMARY KEY)" },
      ];
      const migrate = (kind: SqliteSchemaVersionStorage) => {
        const db = openSqliteDatabase({ path, fail, busyTimeoutMs: 5_000 });
        try {
          return db.migrate("items", migrations, kind);
        } finally {
          db.close();
        }
      };
      expect(migrate(storage)).toEqual({ from: 0, to: 1 });
      await holdWriteLock(path);

      let result: { from: number; to: number } | undefined;
      const elapsed = blockedMs(() => {
        result = migrate(storage);
      });
      expect(elapsed).toBeLessThan(OPEN_BOUND_MS);
      expect(result).toEqual({ from: 1, to: 1 });
    }, 30_000);
  }
});
