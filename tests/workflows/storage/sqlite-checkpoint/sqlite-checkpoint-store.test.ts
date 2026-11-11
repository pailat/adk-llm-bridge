import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../../../../src/utils/sqlite-database.js";
import {
  SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
  SqliteWorkflowCheckpointStore,
  type SqliteWorkflowCheckpointStoreOptions,
} from "../../../../src/workflows/checkpoint/sqlite/index.js";
import type { BaseWorkflowCheckpointStore } from "../../../../src/workflows/storage/checkpoint-store.js";
import {
  defineWorkflowStorageConformanceTests,
  workflowCheckpointStoreConformanceCases,
} from "../../../../src/workflows/storage/conformance/index.js";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import { buildCheckpoint, spawnWorker } from "./fixtures/checkpoint-worker.js";

const directories: string[] = [];
const openStores: BaseWorkflowCheckpointStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-checkpoint-"));
  directories.push(dir);
  return dir;
}

function newStore(
  path: string,
  options: Partial<SqliteWorkflowCheckpointStoreOptions> = {},
): SqliteWorkflowCheckpointStore {
  const store = new SqliteWorkflowCheckpointStore({ path, ...options });
  openStores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    await store.close().catch(() => undefined);
  }
});

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

function rawDatabase(path: string) {
  return openSqliteDatabase({
    path,
    fail: (failure, message) => new Error(`${failure}: ${message}`),
  });
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectStorageError(error: unknown, code: string): void {
  expect(isWorkflowStorageError(error)).toBe(true);
  expect((error as { code?: string }).code).toBe(code);
}

const WORKFLOW = "wf-sqlite";
const NO_CONTEXT = {} as never;

async function seed(
  store: BaseWorkflowCheckpointStore,
  executionId: string,
  workflowId = WORKFLOW,
  step = 0,
) {
  const checkpoint = await buildCheckpoint(workflowId, executionId, step);
  return await store.put({ checkpoint });
}

// --- Provider contract ------------------------------------------------------

const databasePaths = new WeakMap<object, string>();
defineWorkflowStorageConformanceTests(
  await workflowCheckpointStoreConformanceCases({
    createStore: () => {
      const dir = tempDir();
      const store = new SqliteWorkflowCheckpointStore({
        path: join(dir, "conformance.db"),
      });
      databasePaths.set(store, dir);
      return store;
    },
    reopenStore: (store) => {
      const dir = databasePaths.get(store) as string;
      const reopened = new SqliteWorkflowCheckpointStore({
        path: join(dir, "conformance.db"),
      });
      databasePaths.set(reopened, dir);
      return reopened;
    },
    destroyStore: (store) => {
      const dir = databasePaths.get(store);
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
    workers: 8,
  }),
  { test, skip: test.skip },
);

// --- Files and paths --------------------------------------------------------

describe("SqliteWorkflowCheckpointStore database file", () => {
  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "creates the database file with mode 0600 and a missing directory with mode 0700",
    async () => {
      const dir = join(tempDir(), "nested", "state");
      const path = join(dir, "checkpoints.db");
      const store = newStore(path);
      await seed(store, "exec-mode");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  test("rejects a symbolic link at the database path and leaves its target untouched", async () => {
    const dir = tempDir();
    const target = join(dir, "real.db");
    const first = newStore(target);
    await seed(first, "exec-link");
    await first.close();
    const before = readFileSync(target);
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    const error = thrown(() => newStore(link));
    expectStorageError(error, "WORKFLOW_STORAGE_UNSAFE_PATH");
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  test("rejects a dangling symbolic link without creating its target", () => {
    const dir = tempDir();
    const target = join(dir, "missing.db");
    const link = join(dir, "dangling.db");
    symlinkSync(target, link);
    const error = thrown(() => newStore(link));
    expectStorageError(error, "WORKFLOW_STORAGE_UNSAFE_PATH");
    expect(existsSync(target)).toBe(false);
  });

  test("rejects a symbolic link in place of the write-ahead log file", async () => {
    const dir = tempDir();
    const path = join(dir, "wal-link.db");
    const decoy = join(dir, "decoy");
    writeFileSync(decoy, "");
    symlinkSync(decoy, `${path}-wal`);
    const error = thrown(() => newStore(path));
    expectStorageError(error, "WORKFLOW_STORAGE_UNSAFE_PATH");
  });

  test("rejects a directory at the database path", () => {
    const dir = tempDir();
    const path = join(dir, "is-a-directory.db");
    mkdirSync(path);
    expectStorageError(
      thrown(() => newStore(path)),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
  });

  test.skipIf(process.platform === "win32")(
    "rejects a FIFO at the database path without blocking",
    async () => {
      const dir = tempDir();
      const path = join(dir, "pipe.db");
      const made = Bun.spawnSync(["mkfifo", path]);
      expect(made.exitCode).toBe(0);
      const worker = spawnWorker("open", { path });
      try {
        const line = await worker.waitForLine(
          (text) => text.startsWith("{"),
          10_000,
        );
        const result = JSON.parse(line) as { opened: boolean; code?: string };
        expect(result.opened).toBe(false);
        expect(result.code).toBe("WORKFLOW_STORAGE_UNSAFE_PATH");
      } finally {
        worker.kill();
        await worker.exited;
      }
    },
    20_000,
  );

  test("rejects a file that is not a SQLite database as corrupt and does not overwrite it", () => {
    const dir = tempDir();
    const path = join(dir, "notes.db");
    const content = Buffer.from(
      "this is a text file, not a database. ".repeat(200),
    );
    writeFileSync(path, content, { mode: 0o600 });
    const error = thrown(() => newStore(path));
    expectStorageError(error, "WORKFLOW_STORAGE_CORRUPT");
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  test("a bad busy timeout is rejected as an invalid option before any file is created", () => {
    const dir = tempDir();
    for (const busyTimeoutMs of [-1, 1.5, 2 ** 31]) {
      const path = join(dir, `busy-${busyTimeoutMs}.db`);
      const error = thrown(() => newStore(path, { busyTimeoutMs }));
      expectStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION");
      expect(existsSync(path)).toBe(false);
    }
  });

  test("a relative database path is rejected as an invalid option", () => {
    const error = thrown(() => newStore("relative/checkpoints.db"));
    expectStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION");
    expect(existsSync("relative/checkpoints.db")).toBe(false);
  });

  test("a :memory: store works, is not durable and creates no file", async () => {
    const store = newStore(":memory:");
    expect(store.capabilities.durable).toBe(false);
    expect(store.capabilities.multiProcess).toBe(false);
    const put = await seed(store, "exec-memory");
    expect(
      (await store.get({ workflowId: WORKFLOW, executionId: "exec-memory" }))
        ?.revision,
    ).toBe(put.revision);
    expect(existsSync(":memory:")).toBe(false);
  });

  test("capabilities state a full, durable, multi-process provider", () => {
    const store = newStore(join(tempDir(), "caps.db"));
    expect(store.providerName).toBe("sqlite");
    expect(store.capabilities).toMatchObject({
      compareAndSet: "atomic",
      leases: true,
      durable: true,
      multiProcess: true,
      listing: true,
      pruning: true,
    });
  });

  test("close releases the database: the write-ahead log is folded into the file and removed", async () => {
    const path = join(tempDir(), "closed.db");
    const store = newStore(path);
    await seed(store, "exec-close");
    expect(existsSync(`${path}-wal`)).toBe(true);
    await store.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    const db = rawDatabase(path);
    try {
      const count = db.prepare("SELECT count(*) AS n FROM checkpoints").get();
      expect(Number(count?.n)).toBe(1);
    } finally {
      db.close();
    }
  });
});

// --- Settings of the connection --------------------------------------------

describe("SqliteWorkflowCheckpointStore connection settings", () => {
  async function pragmasOf(args: Record<string, unknown>) {
    const worker = spawnWorker("pragmas", {
      path: join(tempDir(), "p.db"),
      ...args,
    });
    try {
      const line = await worker.waitForLine((text) =>
        text.includes("journalMode"),
      );
      return JSON.parse(line) as Record<string, unknown>;
    } finally {
      worker.kill();
      await worker.exited;
    }
  }

  test("opens through the shared helper once, rejecting symbolic links, in WAL mode with a short per-statement busy timeout and full synchronous", async () => {
    const settings = await pragmasOf({ busyTimeoutMs: 1234 });
    expect(settings.openCalls).toBe(1);
    expect(settings.symlinks).toBe("reject");
    expect(settings.journalMode).toBe("wal");
    // The configured wait happens between statements, off the event loop.
    expect(settings.busyTimeout).toBe(20);
    expect(settings.synchronous).toBe(2);
  }, 30_000);

  test("each statement blocks for at most the 20 ms busy slice by default", async () => {
    const settings = await pragmasOf({});
    expect(settings.busyTimeout).toBe(20);
    expect(settings.synchronous).toBe(2);
  }, 30_000);

  test("synchronous normal is applied when asked for", async () => {
    const settings = await pragmasOf({ synchronous: "normal" });
    expect(settings.synchronous).toBe(1);
  }, 30_000);

  test("the journal mode written to the file reads back as wal from another connection", async () => {
    const path = join(tempDir(), "wal.db");
    const store = newStore(path);
    await seed(store, "exec-wal");
    const db = rawDatabase(path);
    try {
      expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });

  test("the store source never imports node:sqlite and opens its database through openSqliteDatabase", () => {
    const source = readFileSync(
      new URL(
        "../../../../src/workflows/checkpoint/sqlite/sqlite-checkpoint-store.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /(from\s+|require\(\s*|import\(\s*)["']node:sqlite["']/,
    );
    expect(source).toContain("openSqliteDatabase");
  });
});

// --- Schema -----------------------------------------------------------------

describe("SqliteWorkflowCheckpointStore schema", () => {
  const versionRows = (path: string) => {
    const db = rawDatabase(path);
    try {
      return db
        .prepare(
          "SELECT component, version FROM adk_llm_bridge_schema_versions ORDER BY component",
        )
        .all()
        .map((row) => ({
          component: String(row.component),
          version: Number(row.version),
        }));
    } finally {
      db.close();
    }
  };

  test("creates the checkpoints and leases tables keyed by workflow and execution, with indexes for list by workflow, status and time", async () => {
    const path = join(tempDir(), "layout.db");
    const store = newStore(path);
    await seed(store, "exec-layout");
    const db = rawDatabase(path);
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(names).toContain("checkpoints");
      expect(names).toContain("leases");
      expect(names).toContain("adk_llm_bridge_schema_versions");
      for (const table of ["checkpoints", "leases"]) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all();
        const key = columns
          .filter((column) => Number(column.pk) > 0)
          .map((column) => column.name)
          .sort();
        expect(key).toEqual(["execution_id", "workflow_id"]);
      }
      const checkpointColumns = db
        .prepare("PRAGMA table_info(checkpoints)")
        .all()
        .map((column) => column.name);
      for (const column of ["revision", "status", "updated_at"]) {
        expect(checkpointColumns).toContain(column);
      }
      const indexed = new Set<string>();
      for (const index of db.prepare("PRAGMA index_list(checkpoints)").all()) {
        for (const column of db
          .prepare(`PRAGMA index_info(${JSON.stringify(String(index.name))})`)
          .all()) {
          indexed.add(String(column.name));
        }
      }
      expect(indexed.has("status")).toBe(true);
      expect(indexed.has("updated_at")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a saved row holds the JSON text, its byte size, its SHA-256, the revision, the status and the save time", async () => {
    const path = join(tempDir(), "row.db");
    const store = newStore(path);
    const checkpoint = await buildCheckpoint(WORKFLOW, "exec-row", 1);
    const put = await store.put({ checkpoint });
    const db = rawDatabase(path);
    try {
      const row = db.prepare("SELECT * FROM checkpoints").get() as Record<
        string,
        unknown
      >;
      expect(row.revision).toBe(put.revision);
      expect(row.status).toBe("completed");
      expect(row.updated_at).toBe(put.updatedAt);
      const text = Object.values(row).find(
        (value): value is string =>
          typeof value === "string" && value.startsWith("{"),
      );
      expect(text).toBeDefined();
      expect(JSON.parse(text as string)).toEqual(
        JSON.parse(JSON.stringify(checkpoint)),
      );
      const digest = createHash("sha256")
        .update(text as string)
        .digest("hex");
      expect(
        Object.values(row).some(
          (value) => typeof value === "string" && value.includes(digest),
        ),
      ).toBe(true);
      expect(Object.values(row)).toContain(Buffer.byteLength(text as string));
    } finally {
      db.close();
    }
  });

  test("keeps the schema version in the versions table under one component name, not in user_version", async () => {
    const path = join(tempDir(), "version.db");
    const store = newStore(path);
    await seed(store, "exec-version");
    const rows = versionRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION);
    expect(rows[0]?.component).toMatch(/checkpoint/i);
    const db = rawDatabase(path);
    try {
      expect(
        Number(db.prepare("PRAGMA user_version").get()?.user_version),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("refuses a database written with a newer schema version and changes nothing in it", async () => {
    const path = join(tempDir(), "newer.db");
    const first = newStore(path);
    await seed(first, "exec-newer");
    await first.close();
    const component = versionRows(path)[0]?.component as string;
    const db = rawDatabase(path);
    try {
      db.prepare(
        "UPDATE adk_llm_bridge_schema_versions SET version = 99 WHERE component = ?",
      ).run(component);
    } finally {
      db.close();
    }
    const error = thrown(() => newStore(path));
    expectStorageError(error, "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED");
    expect(versionRows(path)).toEqual([{ component, version: 99 }]);
    const check = rawDatabase(path);
    try {
      expect(
        Number(check.prepare("SELECT count(*) AS n FROM checkpoints").get()?.n),
      ).toBe(1);
    } finally {
      check.close();
    }
  });

  test("shares a file with other components: their version rows are left alone, even a newer one", async () => {
    const path = join(tempDir(), "shared.db");
    const db = rawDatabase(path);
    try {
      db.exec(
        "CREATE TABLE adk_llm_bridge_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)",
      );
      db.exec(
        "INSERT INTO adk_llm_bridge_schema_versions VALUES ('sibling-component', 7), ('future-component', 99)",
      );
    } finally {
      db.close();
    }
    const store = newStore(path);
    await seed(store, "exec-shared");
    await store.close();
    const rows = versionRows(path);
    expect(
      rows.find((row) => row.component === "sibling-component")?.version,
    ).toBe(7);
    expect(
      rows.find((row) => row.component === "future-component")?.version,
    ).toBe(99);
    const own = rows.filter((row) => /checkpoint/i.test(row.component));
    expect(own).toEqual([
      {
        component: own[0]?.component as string,
        version: SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
      },
    ]);
  });

  test("reopening a database at the current version keeps its checkpoints and its version", async () => {
    const path = join(tempDir(), "reopen.db");
    const first = newStore(path);
    const put = await seed(first, "exec-reopen");
    await first.close();
    const second = newStore(path);
    expect(
      (await second.get({ workflowId: WORKFLOW, executionId: "exec-reopen" }))
        ?.revision,
    ).toBe(put.revision);
    expect(versionRows(path)[0]?.version).toBe(
      SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    );
  });
});

// --- Integrity --------------------------------------------------------------

describe("SqliteWorkflowCheckpointStore integrity", () => {
  async function tamperedStore(
    mutate: (
      db: ReturnType<typeof rawDatabase>,
      row: Record<string, unknown>,
      text: string,
    ) => void,
  ) {
    const path = join(tempDir(), "tampered.db");
    const first = newStore(path);
    const checkpoint = await buildCheckpoint(WORKFLOW, "exec-tamper", 1);
    await first.put({ checkpoint });
    await first.close();
    const db = rawDatabase(path);
    try {
      const row = db.prepare("SELECT * FROM checkpoints").get() as Record<
        string,
        unknown
      >;
      const text = Object.values(row).find(
        (value): value is string =>
          typeof value === "string" && value.startsWith("{"),
      ) as string;
      mutate(db, row, text);
    } finally {
      db.close();
    }
    return newStore(path);
  }

  const columnHolding = (row: Record<string, unknown>, needle: string) =>
    Object.entries(row).find(
      ([, value]) => typeof value === "string" && value.includes(needle),
    )?.[0] as string;

  test("rejects a row whose JSON text was changed after it was saved", async () => {
    const store = await tamperedStore((db, row, text) => {
      const column = columnHolding(row, "step-1-");
      db.prepare(`UPDATE checkpoints SET ${column} = ?`).run(
        text.replace("step-1-", "step-9-"),
      );
    });
    for (const read of [
      () => store.get({ workflowId: WORKFLOW, executionId: "exec-tamper" }),
      () =>
        store.load({
          workflowId: WORKFLOW,
          executionId: "exec-tamper",
          context: NO_CONTEXT,
        }),
    ]) {
      expectStorageError(await rejected(read()), "WORKFLOW_STORAGE_CORRUPT");
    }
  });

  test("rejects a row whose stored SHA-256 does not match its JSON text", async () => {
    const store = await tamperedStore((db, row, text) => {
      const digest = createHash("sha256").update(text).digest("hex");
      const column = columnHolding(row, digest);
      const original = String(row[column]);
      const wrong = original.replace(digest, "0".repeat(64));
      db.prepare(`UPDATE checkpoints SET ${column} = ?`).run(wrong);
    });
    expectStorageError(
      await rejected(
        store.get({ workflowId: WORKFLOW, executionId: "exec-tamper" }),
      ),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("rejects a row whose revision column does not match its checkpoint", async () => {
    const store = await tamperedStore((db) => {
      db.prepare("UPDATE checkpoints SET revision = ?").run(
        `sha256:${"0".repeat(64)}`,
      );
    });
    expectStorageError(
      await rejected(
        store.get({ workflowId: WORKFLOW, executionId: "exec-tamper" }),
      ),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("a row whose JSON text is not JSON is corrupt, not a crash", async () => {
    const store = await tamperedStore((db, row, text) => {
      const column = columnHolding(row, text.slice(0, 20));
      db.prepare(`UPDATE checkpoints SET ${column} = ?`).run("{not json");
    });
    expectStorageError(
      await rejected(
        store.get({ workflowId: WORKFLOW, executionId: "exec-tamper" }),
      ),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });
});

// --- Health -----------------------------------------------------------------

describe("SqliteWorkflowCheckpointStore healthCheck", () => {
  test("reports ok with the provider name and the schema version", async () => {
    const store = newStore(join(tempDir(), "health.db"));
    const health = await store.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("sqlite");
    expect(health.schemaVersion).toBe(
      SQLITE_WORKFLOW_CHECKPOINT_SCHEMA_VERSION,
    );
  });

  test("its write probe is rolled back: no row is left in any table", async () => {
    const path = join(tempDir(), "health-clean.db");
    const store = newStore(path);
    await seed(store, "exec-a");
    await seed(store, "exec-b");
    await store.acquireLease({
      workflowId: WORKFLOW,
      executionId: "exec-a",
      ownerId: "me",
      ttlMs: 60_000,
    });
    const counts = () => {
      const db = rawDatabase(path);
      try {
        return ["checkpoints", "leases"].map((table) =>
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
        );
      } finally {
        db.close();
      }
    };
    expect(counts()).toEqual([2, 1]);
    for (let i = 0; i < 3; i++)
      expect((await store.healthCheck()).ok).toBe(true);
    expect(counts()).toEqual([2, 1]);
    expect((await store.list({})).items).toHaveLength(2);
  });

  test("its write probe needs the write lock: a locked database makes it fail with WORKFLOW_STORAGE_UNAVAILABLE", async () => {
    const path = join(tempDir(), "health-locked.db");
    const store = newStore(path, { busyTimeoutMs: 150 });
    await seed(store, "exec-a");
    const holder = spawnWorker("hold-lock", { path, holdMs: 3000 });
    try {
      await holder.waitForLine((line) => line.includes("locked"));
      const health = await store.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.code).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 30_000);

  test("its read probe fails when the checkpoints table is gone, and it does not throw", async () => {
    const path = join(tempDir(), "health-dropped.db");
    const store = newStore(path);
    await seed(store, "exec-a");
    const db = rawDatabase(path);
    try {
      db.exec("DROP TABLE checkpoints");
    } finally {
      db.close();
    }
    const health = await store.healthCheck();
    expect(health.ok).toBe(false);
    expect(typeof health.code).toBe("string");
  });

  test("quick_check reports a damaged database file as WORKFLOW_STORAGE_CORRUPT", async () => {
    const path = join(tempDir(), "health-damaged.db");
    const first = newStore(path);
    for (let i = 0; i < 60; i++) {
      await first.put({
        checkpoint: await buildCheckpoint(WORKFLOW, `exec-${i}`, 1, 2000),
      });
    }
    await first.close();
    const bytes = readFileSync(path);
    expect(bytes.length).toBeGreaterThan(8192);
    const pageSize = bytes.readUInt16BE(16) || 65536;
    // Overwrite every page after the first, so the damage is in table and index pages.
    const damaged = Buffer.from(bytes);
    damaged.fill(0xff, pageSize);
    writeFileSync(path, damaged);
    chmodSync(path, 0o600);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    let opened: SqliteWorkflowCheckpointStore | undefined;
    const openError = thrown(() => {
      opened = newStore(path);
    });
    if (openError !== undefined) {
      expectStorageError(openError, "WORKFLOW_STORAGE_CORRUPT");
      return;
    }
    const health = await (
      opened as SqliteWorkflowCheckpointStore
    ).healthCheck();
    expect(health.ok).toBe(false);
    expect(health.code).toBe("WORKFLOW_STORAGE_CORRUPT");
  });
});

// --- Busy database ----------------------------------------------------------

describe("SqliteWorkflowCheckpointStore busy database", () => {
  test("a write that waits past the busy timeout fails as retryable WORKFLOW_STORAGE_UNAVAILABLE and writes nothing", async () => {
    const path = join(tempDir(), "busy.db");
    const store = newStore(path, {
      busyTimeoutMs: 300,
      retry: { maxAttempts: 1 },
    });
    await seed(store, "exec-existing");
    const holder = spawnWorker("hold-lock", { path, holdMs: 3000 });
    try {
      await holder.waitForLine((line) => line.includes("locked"));
      const checkpoint = await buildCheckpoint(WORKFLOW, "exec-blocked", 0);
      const started = performance.now();
      const error = await rejected(
        store.put({ checkpoint, expectedRevision: null }),
      );
      const elapsed = performance.now() - started;
      expectStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE");
      expect((error as { retryable?: boolean }).retryable).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      holder.kill();
      await holder.exited;
    }
    expect(
      await store.get({ workflowId: WORKFLOW, executionId: "exec-blocked" }),
    ).toBeUndefined();
    const retried = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-blocked", 0),
      expectedRevision: null,
    });
    expect(retried.revision).toBeDefined();
  }, 30_000);

  test("a write waits for a lock that is released within the busy timeout, then succeeds", async () => {
    const path = join(tempDir(), "busy-wait.db");
    const store = newStore(path, { busyTimeoutMs: 8000 });
    await seed(store, "exec-existing");
    const holder = spawnWorker("hold-lock", { path, holdMs: 500 });
    try {
      await holder.waitForLine((line) => line.includes("locked"));
      const started = performance.now();
      const put = await store.put({
        checkpoint: await buildCheckpoint(WORKFLOW, "exec-waited", 0),
        expectedRevision: null,
      });
      expect(performance.now() - started).toBeGreaterThanOrEqual(300);
      expect(put.revision).toBeDefined();
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 30_000);

  test("reads are not blocked by another process holding the write lock", async () => {
    const path = join(tempDir(), "busy-read.db");
    const store = newStore(path, { busyTimeoutMs: 200 });
    const put = await seed(store, "exec-read");
    const holder = spawnWorker("hold-lock", { path, holdMs: 2000 });
    try {
      await holder.waitForLine((line) => line.includes("locked"));
      const started = performance.now();
      const got = await store.get({
        workflowId: WORKFLOW,
        executionId: "exec-read",
      });
      expect(got?.revision).toBe(put.revision);
      expect((await store.list({})).items).toHaveLength(1);
      expect(performance.now() - started).toBeLessThan(150);
    } finally {
      holder.kill();
      await holder.exited;
    }
  }, 30_000);
});

// --- Leases and fencing -----------------------------------------------------

describe("SqliteWorkflowCheckpointStore leases", () => {
  const locator = { workflowId: WORKFLOW, executionId: "exec-lease" };

  test("fencing tokens grow by one with every lease granted, across release and reopen", async () => {
    const path = join(tempDir(), "tokens.db");
    const first = newStore(path);
    const a = await first.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 60_000,
    });
    await first.releaseLease(a);
    const b = await first.acquireLease({
      ...locator,
      ownerId: "b",
      ttlMs: 60_000,
    });
    await first.releaseLease(b);
    await first.close();
    const second = newStore(path);
    const c = await second.acquireLease({
      ...locator,
      ownerId: "c",
      ttlMs: 60_000,
    });
    expect([a.fencingToken, b.fencingToken, c.fencingToken]).toEqual([1, 2, 3]);
  });

  test("a fenced save from the old holder is rejected as LEASE_LOST and writes nothing", async () => {
    const path = join(tempDir(), "fenced.db");
    const store = newStore(path);
    const old = await store.acquireLease({
      ...locator,
      ownerId: "old",
      ttlMs: 30,
    });
    await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 0),
      fencingToken: old.fencingToken,
    });
    await Bun.sleep(80);
    const current = await store.acquireLease({
      ...locator,
      ownerId: "new",
      ttlMs: 60_000,
    });
    expect(current.fencingToken).toBe(old.fencingToken + 1);
    const before = await store.get(locator);
    const error = await rejected(
      store.put({
        checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 7),
        fencingToken: old.fencingToken,
      }),
    );
    expectStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST");
    const after = await store.get(locator);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    const holderSave = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 8),
      fencingToken: current.fencingToken,
    });
    expect((await store.get(locator))?.revision).toBe(holderSave.revision);
  });

  test("a save under a released lease's token is rejected after another owner took over", async () => {
    const store = newStore(join(tempDir(), "released.db"));
    const a = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 60_000,
    });
    await store.releaseLease(a);
    const b = await store.acquireLease({
      ...locator,
      ownerId: "b",
      ttlMs: 60_000,
    });
    const error = await rejected(
      store.put({
        checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 1),
        fencingToken: a.fencingToken,
      }),
    );
    expectStorageError(error, "WORKFLOW_STORAGE_LEASE_LOST");
    expect(await store.get(locator)).toBeUndefined();
    expect(b.fencingToken).toBe(a.fencingToken + 1);
  });

  test("another owner is refused with LEASE_HELD and the expiry while the lease is unexpired", async () => {
    const store = newStore(join(tempDir(), "held.db"));
    const held = await store.acquireLease({
      ...locator,
      ownerId: "a",
      ttlMs: 60_000,
    });
    const error = await rejected(
      store.acquireLease({ ...locator, ownerId: "b", ttlMs: 60_000 }),
    );
    expectStorageError(error, "WORKFLOW_STORAGE_LEASE_HELD");
    expect(
      (error as { details: { expiresAt?: number } }).details.expiresAt,
    ).toBe(held.expiresAt);
  });

  test("the old holder cannot renew after a takeover, and a renewal keeps the token", async () => {
    const store = newStore(join(tempDir(), "renew.db"));
    const old = await store.acquireLease({
      ...locator,
      ownerId: "old",
      ttlMs: 30,
    });
    const renewed = await store.renewLease(old, 60_000);
    expect(renewed.fencingToken).toBe(old.fencingToken);
    expect(renewed.expiresAt).toBeGreaterThan(old.expiresAt);
    const short = await store.acquireLease({
      ...locator,
      workflowId: "wf-other",
      ownerId: "old",
      ttlMs: 30,
    });
    await Bun.sleep(80);
    await store.acquireLease({
      workflowId: "wf-other",
      executionId: locator.executionId,
      ownerId: "new",
      ttlMs: 60_000,
    });
    expectStorageError(
      await rejected(store.renewLease(short, 60_000)),
      "WORKFLOW_STORAGE_LEASE_LOST",
    );
  });

  function leaseRows(path: string): string[] {
    const db = rawDatabase(path);
    try {
      return db
        .prepare(
          "SELECT execution_id FROM leases WHERE workflow_id <> '' ORDER BY execution_id",
        )
        .all()
        .map((row) => String(row.execution_id));
    } finally {
      db.close();
    }
  }

  test("delete removes the lease row of the execution, and a later lease still gets a larger token", async () => {
    const path = join(tempDir(), "lease-delete.db");
    const store = newStore(path);
    const old = await store.acquireLease({
      ...locator,
      ownerId: "old",
      ttlMs: 60_000,
    });
    await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 0),
      fencingToken: old.fencingToken,
    });
    await store.releaseLease(old);
    expect(await store.delete(locator)).toBe(true);
    expect(leaseRows(path)).toEqual([]);
    // With no row, the old token matches nothing.
    expectStorageError(
      await rejected(
        store.put({
          checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 0),
          fencingToken: old.fencingToken,
        }),
      ),
      "WORKFLOW_STORAGE_LEASE_LOST",
    );
    await store.close();
    const reopened = newStore(path);
    const next = await reopened.acquireLease({
      ...locator,
      ownerId: "new",
      ttlMs: 60_000,
    });
    expect(next.fencingToken).toBeGreaterThan(old.fencingToken);
  });

  test("prune removes the lease rows of pruned executions and of free leases without a checkpoint, and keeps the others", async () => {
    const path = join(tempDir(), "lease-prune.db");
    const store = newStore(path);
    const lease = (executionId: string, ttlMs = 60_000) =>
      store.acquireLease({
        workflowId: WORKFLOW,
        executionId,
        ownerId: "owner",
        ttlMs,
      });
    // Finished and pruned.
    await store.releaseLease(await lease("done"));
    await seed(store, "done", WORKFLOW, 1);
    // Leased and released, never saved.
    const released = await lease("released");
    await store.releaseLease(released);
    // Leased by a holder that died, never saved.
    const expired = await lease("expired", 30);
    // Held now, not saved yet.
    await lease("held");
    // Still running, so its checkpoint and lease stay.
    await store.releaseLease(await lease("running"));
    await seed(store, "running");
    await Bun.sleep(80);
    const result = await store.prune({
      updatedBefore: Date.now() + 1000,
      limit: 10,
    });
    expect(result).toEqual({ deleted: 1, hasMore: false });
    expect(leaseRows(path)).toEqual(["held", "running"]);
    const again = await lease("released");
    expect(again.fencingToken).toBeGreaterThan(released.fencingToken);
    const after = await lease("expired");
    expect(after.fencingToken).toBeGreaterThan(expired.fencingToken);
    expectStorageError(
      await rejected(
        store.put({
          checkpoint: await buildCheckpoint(WORKFLOW, "expired", 0),
          fencingToken: expired.fencingToken,
        }),
      ),
      "WORKFLOW_STORAGE_LEASE_LOST",
    );
  });
});

// --- Listing, delete and prune ---------------------------------------------

describe("SqliteWorkflowCheckpointStore listing", () => {
  const ids = (items: ReadonlyArray<{ executionId: string }>) =>
    items.map((item) => item.executionId);

  test("pages by an opaque keyset cursor: deleting rows already returned does not skip or repeat any", async () => {
    const store = newStore(join(tempDir(), "keyset.db"));
    for (let i = 1; i <= 7; i++)
      await seed(store, `exec-${String(i).padStart(2, "0")}`);
    const first = await store.list({ workflowId: WORKFLOW, limit: 3 });
    expect(ids(first.items)).toEqual(["exec-01", "exec-02", "exec-03"]);
    expect(typeof first.nextCursor).toBe("string");
    expect(first.nextCursor).not.toContain("exec-03");
    for (const executionId of ids(first.items))
      await store.delete({ workflowId: WORKFLOW, executionId });
    await seed(store, "exec-00");
    const second = await store.list({
      workflowId: WORKFLOW,
      limit: 3,
      cursor: first.nextCursor as string,
    });
    expect(ids(second.items)).toEqual(["exec-04", "exec-05", "exec-06"]);
    const third = await store.list({
      workflowId: WORKFLOW,
      limit: 3,
      cursor: second.nextCursor as string,
    });
    expect(ids(third.items)).toEqual(["exec-07"]);
    expect(third.nextCursor).toBeUndefined();
  });

  test("a cursor that was not issued by the store is rejected", async () => {
    const store = newStore(join(tempDir(), "cursor.db"));
    await seed(store, "exec-a");
    const error = await rejected(store.list({ cursor: "not-a-cursor" }));
    expect(isWorkflowStorageError(error)).toBe(true);
  });

  test("filters by workflow, status and last save time, and summaries carry revision, status, time and byte size", async () => {
    const store = newStore(join(tempDir(), "filters.db"));
    const running = await seed(store, "exec-run", "wf-a");
    await Bun.sleep(15);
    const mark = Date.now();
    await Bun.sleep(15);
    const done = await seed(store, "exec-done", "wf-a", 1);
    await seed(store, "exec-other", "wf-b", 1);
    expect(ids((await store.list({ workflowId: "wf-a" })).items)).toEqual([
      "exec-done",
      "exec-run",
    ]);
    expect(ids((await store.list({ status: "completed" })).items)).toEqual([
      "exec-done",
      "exec-other",
    ]);
    expect(ids((await store.list({ updatedBefore: mark })).items)).toEqual([
      "exec-run",
    ]);
    const summary = (
      await store.list({ workflowId: "wf-a", status: "completed" })
    ).items[0];
    expect(summary).toMatchObject({
      workflowId: "wf-a",
      executionId: "exec-done",
      revision: done.revision,
      status: "completed",
      updatedAt: done.updatedAt,
      bytes: Buffer.byteLength(JSON.stringify(done.checkpoint)),
    });
    expect(running.revision).not.toBe(done.revision);
  });

  test("prune deletes in bounded batches and leaves running checkpoints", async () => {
    const path = join(tempDir(), "prune.db");
    const store = newStore(path);
    for (let i = 0; i < 25; i++)
      await seed(store, `done-${String(i).padStart(2, "0")}`, WORKFLOW, 1);
    for (let i = 0; i < 3; i++) await seed(store, `live-${i}`);
    const cutoff = Date.now() + 1000;
    const batches = [];
    for (let i = 0; i < 4; i++) {
      const result = await store.prune({ updatedBefore: cutoff, limit: 10 });
      batches.push(result);
      if (!result.hasMore) break;
    }
    expect(batches).toEqual([
      { deleted: 10, hasMore: true },
      { deleted: 10, hasMore: true },
      { deleted: 5, hasMore: false },
    ]);
    expect(ids((await store.list({})).items)).toEqual([
      "live-0",
      "live-1",
      "live-2",
    ]);
  });

  test("delete with a stale expected revision keeps the row", async () => {
    const store = newStore(join(tempDir(), "delete.db"));
    const put = await seed(store, "exec-del");
    const error = await rejected(
      store.delete({
        workflowId: WORKFLOW,
        executionId: "exec-del",
        expectedRevision: `sha256:${"2".repeat(64)}`,
      }),
    );
    expect(error).toBeDefined();
    expect(
      (await store.get({ workflowId: WORKFLOW, executionId: "exec-del" }))
        ?.revision,
    ).toBe(put.revision);
    expect(
      await store.delete({
        workflowId: WORKFLOW,
        executionId: "exec-del",
        expectedRevision: put.revision,
      }),
    ).toBe(true);
  });
});

// --- Failures other than busy and corrupt -------------------------------------

describe("SqliteWorkflowCheckpointStore other SQLite failures", () => {
  // Skipped on Windows: a read-only flag is not a POSIX mode.
  test.skipIf(process.platform === "win32")(
    "a read-only database file fails as a typed WORKFLOW_STORAGE_UNAVAILABLE, not a raw driver error",
    async () => {
      if (process.getuid?.() === 0) return; // root ignores file modes
      const path = join(tempDir(), "readonly.db");
      const first = newStore(path);
      await seed(first, "exec-ro");
      await first.close();
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      chmodSync(path, 0o400);
      try {
        let opened: SqliteWorkflowCheckpointStore | undefined;
        const openError = thrown(() => {
          opened = newStore(path);
        });
        if (openError !== undefined) {
          expectStorageError(openError, "WORKFLOW_STORAGE_UNAVAILABLE");
          expect((openError as { cause?: unknown }).cause).toBeDefined();
          return;
        }
        // Opened anyway: a write must still fail typed.
        const error = await rejected(
          (opened as SqliteWorkflowCheckpointStore).put({
            checkpoint: await buildCheckpoint(WORKFLOW, "exec-ro-2", 0),
          }),
        );
        expectStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE");
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  test("a save writes its row once, already carrying its SHA-256 and byte size: no state without them is ever written", async () => {
    const path = join(tempDir(), "one-write.db");
    const store = newStore(path);
    // Triggers record every state a row is written in, including states
    // that a later statement of the same save would overwrite.
    const db = rawDatabase(path);
    try {
      db.exec(`
CREATE TABLE row_writes (json TEXT, sha TEXT, bytes INTEGER);
CREATE TRIGGER record_insert AFTER INSERT ON checkpoints BEGIN
  INSERT INTO row_writes VALUES (NEW.checkpoint_json, NEW.sha256, NEW.bytes);
END;
CREATE TRIGGER record_update AFTER UPDATE ON checkpoints BEGIN
  INSERT INTO row_writes VALUES (NEW.checkpoint_json, NEW.sha256, NEW.bytes);
END;`);
    } finally {
      db.close();
    }
    const first = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-once", 1),
    });
    await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-once", 2),
      expectedRevision: first.revision,
    });
    const reader = rawDatabase(path);
    try {
      const writes = reader.prepare("SELECT * FROM row_writes").all();
      expect(writes.length).toBe(2);
      for (const write of writes) {
        const text = String(write.json);
        expect(write.sha).toBe(createHash("sha256").update(text).digest("hex"));
        expect(Number(write.bytes)).toBe(Buffer.byteLength(text));
      }
    } finally {
      reader.close();
    }
  });

  test("a read uses one snapshot: a row replaced by another connection between its two selects is not mixed in", async () => {
    const path = join(tempDir(), "snapshot.db");
    const store = newStore(path);
    const locator = { workflowId: WORKFLOW, executionId: "exec-snapshot" };
    const first = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-snapshot", 1),
    });
    const other = rawDatabase(path);
    const select =
      "SELECT revision, checkpoint_json, bytes, sha256 FROM checkpoints WHERE workflow_id = ? AND execution_id = ?";
    const rowOf = () =>
      other.prepare(select).get(locator.workflowId, locator.executionId) as {
        revision: string;
        checkpoint_json: string;
        bytes: number;
        sha256: string;
      };
    const write = (row: ReturnType<typeof rowOf>) =>
      other
        .prepare(
          "UPDATE checkpoints SET revision = ?, checkpoint_json = ?, bytes = ?, sha256 = ? WHERE workflow_id = ? AND execution_id = ?",
        )
        .run(
          row.revision,
          row.checkpoint_json,
          row.bytes,
          row.sha256,
          locator.workflowId,
          locator.executionId,
        );
    const older = rowOf();
    const second = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-snapshot", 2),
      expectedRevision: first.revision,
    });
    const newer = rowOf();
    write(older);
    // Every handle shares one prototype. When the store prepares the select
    // that reads the text, after its size check has run, the other
    // connection replaces the row.
    const prototype = Object.getPrototypeOf(other) as {
      prepare: (this: unknown, sql: string) => unknown;
    };
    const prepare = prototype.prepare;
    let replaced = false;
    prototype.prepare = function (this: unknown, sql: string) {
      if (
        !replaced &&
        this !== other &&
        sql.includes("checkpoint_json, bytes, sha256")
      ) {
        replaced = true;
        write(newer);
      }
      return prepare.call(this, sql);
    };
    try {
      const read = await store.get(locator);
      expect(replaced).toBe(true);
      expect(read?.revision).toBe(first.revision);
    } finally {
      prototype.prepare = prepare;
    }
    expect((await store.get(locator))?.revision).toBe(second.revision);
    other.close();
  });

  test("a stored row larger than the size limit is refused before it is read", async () => {
    const path = join(tempDir(), "oversize.db");
    const first = newStore(path);
    await first.put({
      checkpoint: await buildCheckpoint(WORKFLOW, "exec-big", 1, 5000),
    });
    await first.close();
    const small = newStore(path, { maxCheckpointBytes: 2048 });
    const error = await rejected(
      small.get({ workflowId: WORKFLOW, executionId: "exec-big" }),
    );
    expectStorageError(error, "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE");
  });
});
