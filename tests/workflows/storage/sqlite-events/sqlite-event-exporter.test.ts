import { afterAll, afterEach, describe, expect, test } from "bun:test";
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
import { SqliteWorkflowCheckpointStore } from "../../../../src/workflows/checkpoint/sqlite/index.js";
import {
  SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION,
  SqliteWorkflowEventExporter,
  type SqliteWorkflowEventExporterOptions,
} from "../../../../src/workflows/events/sqlite/index.js";
import {
  defineWorkflowStorageConformanceTests,
  workflowEventExporterConformanceCases,
} from "../../../../src/workflows/storage/conformance/index.js";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import type { BaseWorkflowEventExporter } from "../../../../src/workflows/storage/event-exporter.js";
import { isBun } from "../../../utils/fixtures/runtime.js";
import { buildCheckpoint } from "../sqlite-checkpoint/fixtures/checkpoint-worker.js";
import {
  buildRecord,
  type SpawnedWorker,
  spawnWorker,
} from "./fixtures/event-worker.js";

const directories: string[] = [];
const openExporters: BaseWorkflowEventExporter[] = [];
const workers: SpawnedWorker[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-events-"));
  directories.push(dir);
  return dir;
}

function newExporter(
  path: string,
  options: Partial<SqliteWorkflowEventExporterOptions> = {},
): SqliteWorkflowEventExporter {
  const exporter = new SqliteWorkflowEventExporter({ path, ...options });
  openExporters.push(exporter);
  return exporter;
}

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.kill("SIGKILL");
    await worker.exited.catch(() => undefined);
  }
  for (const exporter of openExporters.splice(0)) {
    await exporter.close().catch(() => undefined);
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

function rawCount(path: string, sql: string, ...params: string[]): number {
  const db = rawDatabase(path);
  try {
    return Number(db.prepare(sql).get(...params)?.n);
  } finally {
    db.close();
  }
}

function versionRows(
  path: string,
): Array<{ component: string; version: number }> {
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

async function appendMany(
  exporter: BaseWorkflowEventExporter,
  executionId: string,
  count: number,
  base = 0,
) {
  return await exporter.append({
    executionId,
    records: Array.from({ length: count }, (_, i) =>
      buildRecord(executionId, `${executionId}-${base + i}`, {
        timestamp: 1_000 + base + i,
      }),
    ),
  });
}

// --- Provider contract ------------------------------------------------------

const databaseDirs = new WeakMap<object, string>();
defineWorkflowStorageConformanceTests(
  await workflowEventExporterConformanceCases({
    createExporter: () => {
      const dir = tempDir();
      const exporter = new SqliteWorkflowEventExporter({
        path: join(dir, "conformance.db"),
      });
      databaseDirs.set(exporter, dir);
      return exporter;
    },
    reopenExporter: (exporter) => {
      const dir = databaseDirs.get(exporter) as string;
      const reopened = new SqliteWorkflowEventExporter({
        path: join(dir, "conformance.db"),
      });
      databaseDirs.set(reopened, dir);
      return reopened;
    },
    destroyExporter: (exporter) => {
      const dir = databaseDirs.get(exporter);
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
    workers: 8,
  }),
  { test, skip: test.skip },
);

// --- Files and paths --------------------------------------------------------

describe("SqliteWorkflowEventExporter database file", () => {
  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "creates the database file with mode 0600 and a missing directory with mode 0700",
    async () => {
      const dir = join(tempDir(), "nested", "state");
      const path = join(dir, "events.db");
      const exporter = newExporter(path);
      await appendMany(exporter, "exec-mode", 1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "sets an existing database file that others can read back to 0600",
    async () => {
      const path = join(tempDir(), "events.db");
      const first = newExporter(path);
      await appendMany(first, "exec-open-mode", 1);
      await first.close();
      chmodSync(path, 0o644);
      const second = newExporter(path);
      await appendMany(second, "exec-open-mode-2", 1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  test("rejects a symbolic link at the database path and leaves its target untouched", async () => {
    const dir = tempDir();
    const target = join(dir, "real.db");
    const first = newExporter(target);
    await appendMany(first, "exec-link", 1);
    await first.close();
    const before = readFileSync(target);
    const link = join(dir, "link.db");
    symlinkSync(target, link);
    expectStorageError(
      thrown(() => newExporter(link)),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(readFileSync(target).equals(before)).toBe(true);
  });

  test("rejects a dangling symbolic link without creating its target", () => {
    const dir = tempDir();
    const target = join(dir, "missing.db");
    const link = join(dir, "dangling.db");
    symlinkSync(target, link);
    expectStorageError(
      thrown(() => newExporter(link)),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(existsSync(target)).toBe(false);
  });

  test("rejects a symbolic link in place of the write-ahead log file", () => {
    const dir = tempDir();
    const path = join(dir, "wal-link.db");
    const decoy = join(dir, "decoy");
    writeFileSync(decoy, "");
    symlinkSync(decoy, `${path}-wal`);
    expectStorageError(
      thrown(() => newExporter(path)),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
  });

  test("rejects a database path inside a directory that is a symbolic link and creates nothing there", () => {
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real);
    const linked = join(dir, "linked");
    symlinkSync(real, linked);
    expectStorageError(
      thrown(() => newExporter(join(linked, "events.db"))),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(existsSync(join(real, "events.db"))).toBe(false);
  });

  for (const suffix of ["-wal", "-shm"]) {
    test(`rejects a symbolic link at ${suffix} of an existing database and leaves its target untouched`, async () => {
      const dir = tempDir();
      const path = join(dir, "existing.db");
      const first = newExporter(path);
      await appendMany(first, "exec-companion-link", 1);
      await first.close();
      const decoy = join(dir, "decoy");
      writeFileSync(decoy, "decoy");
      // Under a strict umask the link itself has no group or world bits, so
      // only a check for links, not for loose modes, can reject it.
      const previousUmask = process.umask(0o077);
      try {
        symlinkSync(decoy, `${path}${suffix}`);
      } finally {
        process.umask(previousUmask);
      }
      expectStorageError(
        thrown(() => newExporter(path)),
        "WORKFLOW_STORAGE_UNSAFE_PATH",
      );
      expect(readFileSync(decoy, "utf8")).toBe("decoy");
    });

    // Skipped on Windows: POSIX modes.
    test.skipIf(process.platform === "win32")(
      `sets an existing ${suffix} file that others can read back to 0600 on open`,
      async () => {
        const dir = tempDir();
        const path = join(dir, "companion-mode.db");
        const first = newExporter(path);
        await appendMany(first, "exec-companion-mode", 1);
        await first.close();
        // A second connection keeps the -wal and -shm files in place, as a
        // process that is still running would.
        const live = rawDatabase(path);
        try {
          live.exec("CREATE TABLE IF NOT EXISTS keep_open (x)");
          live.exec("INSERT INTO keep_open VALUES (1)");
          expect(existsSync(`${path}${suffix}`)).toBe(true);
          chmodSync(`${path}${suffix}`, 0o644);
          newExporter(path);
          expect(statSync(`${path}${suffix}`).mode & 0o777).toBe(0o600);
        } finally {
          live.close();
        }
      },
    );
  }

  test("rejects a directory at the database path", () => {
    const path = join(tempDir(), "is-a-directory.db");
    mkdirSync(path);
    expectStorageError(
      thrown(() => newExporter(path)),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
  });

  test("rejects a file that is not a SQLite database as corrupt and does not overwrite it", () => {
    const path = join(tempDir(), "notes.db");
    const content = Buffer.from(
      "this is a text file, not a database. ".repeat(200),
    );
    writeFileSync(path, content, { mode: 0o600 });
    expectStorageError(
      thrown(() => newExporter(path)),
      "WORKFLOW_STORAGE_CORRUPT",
    );
    expect(readFileSync(path).equals(content)).toBe(true);
  });

  test("a bad busy timeout is rejected as an invalid option before any file is created", () => {
    const dir = tempDir();
    for (const busyTimeoutMs of [-1, 1.5, 2 ** 31]) {
      const path = join(dir, `busy-${busyTimeoutMs}.db`);
      expectStorageError(
        thrown(() => newExporter(path, { busyTimeoutMs })),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
      expect(existsSync(path)).toBe(false);
    }
  });

  test("a relative database path is rejected as an invalid option", () => {
    expectStorageError(
      thrown(() => newExporter("relative/events.db")),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expect(existsSync("relative/events.db")).toBe(false);
  });

  test("a :memory: exporter works, is not durable and creates no file", async () => {
    const exporter = newExporter(":memory:");
    expect(exporter.capabilities.durable).toBe(false);
    expect(exporter.capabilities.multiProcess).toBe(false);
    const result = await appendMany(exporter, "exec-memory", 2);
    expect(result.lastSequence).toBe(2);
    expect(existsSync(":memory:")).toBe(false);
  });

  test("a file exporter reports the full contract", () => {
    const exporter = newExporter(join(tempDir(), "caps.db"));
    expect(exporter.providerName).toBe("sqlite");
    expect(exporter.capabilities).toMatchObject({
      durable: true,
      multiProcess: true,
      listing: true,
      pruning: true,
    });
  });

  test("close folds the write-ahead log into the file and removes it", async () => {
    const path = join(tempDir(), "closed.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-close", 3);
    expect(existsSync(`${path}-wal`)).toBe(true);
    await exporter.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(
      rawCount(path, "SELECT count(*) AS n FROM workflow_event_records"),
    ).toBe(3);
  });
});

// --- Settings of the connection --------------------------------------------

// Skipped under Node: the worker wraps the shared helper with `mock.module` of `bun:test`.
describe.skipIf(!isBun)(
  "SqliteWorkflowEventExporter connection settings",
  () => {
    async function pragmasOf(args: Record<string, unknown>) {
      const worker = spawnWorker("pragmas", {
        path: join(tempDir(), "p.db"),
        ...args,
      });
      workers.push(worker);
      const line = await worker.waitForLine((text) =>
        text.includes("journalMode"),
      );
      return JSON.parse(line) as Record<string, unknown>;
    }

    test("opens through the shared helper once, rejecting symbolic links, in WAL mode with a short per-statement busy timeout", async () => {
      const settings = await pragmasOf({ busyTimeoutMs: 1234 });
      expect(settings.openCalls).toBe(1);
      expect(settings.symlinks).toBe("reject");
      expect(String(settings.journalMode).toLowerCase()).toBe("wal");
      // The configured wait happens between statements, off the event loop.
      expect(settings.busyTimeout).toBe(20);
    }, 30_000);

    test("each statement blocks for at most the 20 ms busy slice by default", async () => {
      expect((await pragmasOf({})).busyTimeout).toBe(20);
    }, 30_000);

    test("synchronous is normal by default and full when asked", async () => {
      // SQLite reports synchronous as 1 for NORMAL and 2 for FULL.
      expect((await pragmasOf({})).synchronous).toBe(1);
      expect((await pragmasOf({ synchronous: "full" })).synchronous).toBe(2);
    }, 30_000);
  },
);

// --- Layout ------------------------------------------------------------------

describe("SqliteWorkflowEventExporter layout", () => {
  function indexColumns(
    path: string,
  ): Map<string, { unique: boolean; columns: string[] }> {
    const db = rawDatabase(path);
    try {
      const found = new Map<string, { unique: boolean; columns: string[] }>();
      const list = db
        .prepare("PRAGMA index_list(workflow_event_records)")
        .all();
      for (const row of list) {
        const name = String(row.name);
        const columns = db
          .prepare(`PRAGMA index_info(${JSON.stringify(name)})`)
          .all()
          .sort((a, b) => Number(a.seqno) - Number(b.seqno))
          .map((info) => String(info.name));
        found.set(name, { unique: Number(row.unique) === 1, columns });
      }
      return found;
    } finally {
      db.close();
    }
  }

  test("keys records by execution and sequence, makes execution and id unique, and indexes kind and type", async () => {
    const path = join(tempDir(), "layout.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-layout", 1);
    const indexes = [...indexColumns(path).values()];
    const has = (unique: boolean, columns: string[]) =>
      indexes.some(
        (index) =>
          index.unique === unique &&
          index.columns.join(",") === columns.join(","),
      );
    expect(has(true, ["execution_id", "sequence"])).toBe(true);
    expect(has(true, ["execution_id", "id"])).toBe(true);
    expect(has(false, ["execution_id", "kind", "sequence"])).toBe(true);
    expect(has(false, ["execution_id", "type", "sequence"])).toBe(true);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM sqlite_master WHERE name = 'workflow_event_executions'",
      ),
    ).toBe(1);
  });

  test("lists executions from the summary table without scanning records", async () => {
    const path = join(tempDir(), "summary.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-summary", 3);
    expect(
      rawCount(path, "SELECT count(*) AS n FROM workflow_event_executions"),
    ).toBe(1);
    const page = await exporter.listExecutions();
    expect(page.items).toEqual([
      {
        executionId: "exec-summary",
        lastSequence: 3,
        firstTimestamp: 1_000,
        lastTimestamp: 1_002,
      },
    ]);
  });
});

describe("SqliteWorkflowEventExporter execution summary", () => {
  test("keeps first_timestamp from the first append when later batches arrive", async () => {
    const exporter = newExporter(join(tempDir(), "first-ts.db"));
    await appendMany(exporter, "exec-first-ts", 2);
    await appendMany(exporter, "exec-first-ts", 2, 10);
    const page = await exporter.listExecutions();
    expect(page.items).toEqual([
      {
        executionId: "exec-first-ts",
        lastSequence: 4,
        firstTimestamp: 1_000,
        lastTimestamp: 1_011,
      },
    ]);
  });
});

// --- Schema versions ---------------------------------------------------------

describe("SqliteWorkflowEventExporter schema version", () => {
  test("records its own component at the current version in the shared versions table", async () => {
    const path = join(tempDir(), "version.db");
    newExporter(path);
    const rows = versionRows(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.component).toMatch(/event/i);
    expect(rows[0]?.version).toBe(SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION);
  });

  test("refuses a database written with a newer schema version and changes nothing in it", async () => {
    const path = join(tempDir(), "newer.db");
    const first = newExporter(path);
    await appendMany(first, "exec-newer", 2);
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
    expectStorageError(
      thrown(() => newExporter(path)),
      "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
    );
    expect(versionRows(path)).toEqual([{ component, version: 99 }]);
    expect(
      rawCount(path, "SELECT count(*) AS n FROM workflow_event_records"),
    ).toBe(2);
  });

  test("refuses a database that is exactly one schema version newer", async () => {
    const path = join(tempDir(), "newer-by-one.db");
    const first = newExporter(path);
    await first.close();
    const component = versionRows(path)[0]?.component as string;
    const next = SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION + 1;
    const db = rawDatabase(path);
    try {
      db.prepare(
        "UPDATE adk_llm_bridge_schema_versions SET version = ? WHERE component = ?",
      ).run(next, component);
    } finally {
      db.close();
    }
    expectStorageError(
      thrown(() => newExporter(path)),
      "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
    );
    expect(versionRows(path)).toEqual([{ component, version: next }]);
  });

  test("does not run a migration step again when another process finished the migration while it waited for the lock", async () => {
    const dir = tempDir();
    const path = join(dir, "migrated-while-waiting.db");
    const holder = spawnWorker("commit-current-schema", {
      path,
      template: join(dir, "template.db"),
      holdMs: 1500,
    });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes('"locked"'));
    const opener = spawnWorker("open", { path });
    workers.push(opener);
    const outcome = JSON.parse(
      await opener.waitForLine((line) => line.includes('"opened"')),
    ) as { opened: boolean; code?: string; message?: string };
    await holder.waitForLine((line) => line.includes('"committed"'));
    expect(outcome).toMatchObject({ opened: true });
    expect(versionRows(path)).toEqual([
      {
        component: "workflow-events",
        version: SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION,
      },
    ]);
  });

  test("reports a newer schema version at once while another process holds the write lock", async () => {
    const path = join(tempDir(), "newer-locked.db");
    const first = newExporter(path);
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
    const holder = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../../utils/fixtures/sqlite-write-holder.ts"),
        path,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
      const chunk = await reader.read();
      reader.releaseLock();
      expect(new TextDecoder().decode(chunk.value).trim()).toBe("locked");
      const started = performance.now();
      const error = thrown(() => newExporter(path, { busyTimeoutMs: 3000 }));
      const elapsed = performance.now() - started;
      expectStorageError(error, "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED");
      expect(elapsed).toBeLessThan(1000);
    } finally {
      holder.kill(9);
      await holder.exited;
    }
  });

  test("refuses a newer schema version committed by another process while it waited for the write lock", async () => {
    const path = join(tempDir(), "newer-while-waiting.db");
    // The other process holds the write lock with version 99 not yet
    // committed: the opener reads no version, waits for the lock, and must
    // check the version again once it has the lock.
    const holder = spawnWorker("commit-newer-version", {
      path,
      component: "workflow-events",
      version: 99,
      holdMs: 1500,
    });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes('"locked"'));
    const opener = spawnWorker("open", { path });
    workers.push(opener);
    const outcome = JSON.parse(
      await opener.waitForLine((line) => line.includes('"opened"')),
    ) as { opened: boolean; code?: string };
    await holder.waitForLine((line) => line.includes('"committed"'));
    expect(outcome).toMatchObject({
      opened: false,
      code: "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
    });
    expect(versionRows(path)).toEqual([
      { component: "workflow-events", version: 99 },
    ]);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'workflow_event%'",
      ),
    ).toBe(0);
  });

  test("migrates a database that has no version row for it, keeping the rows of other components", async () => {
    const path = join(tempDir(), "older.db");
    const db = rawDatabase(path);
    try {
      db.exec(
        "CREATE TABLE adk_llm_bridge_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)",
      );
      db.exec(
        "INSERT INTO adk_llm_bridge_schema_versions VALUES ('sibling-component', 7)",
      );
    } finally {
      db.close();
    }
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-older", 2);
    await exporter.close();
    const rows = versionRows(path);
    expect(
      rows.find((row) => row.component === "sibling-component")?.version,
    ).toBe(7);
    const own = rows.filter((row) => /event/i.test(row.component));
    expect(own).toHaveLength(1);
    expect(own[0]?.version).toBe(SQLITE_WORKFLOW_EVENT_SCHEMA_VERSION);
  });

  test("a newer version of another component does not stop it", async () => {
    const path = join(tempDir(), "future-sibling.db");
    const db = rawDatabase(path);
    try {
      db.exec(
        "CREATE TABLE adk_llm_bridge_schema_versions (component TEXT PRIMARY KEY, version INTEGER NOT NULL)",
      );
      db.exec(
        "INSERT INTO adk_llm_bridge_schema_versions VALUES ('future-component', 99)",
      );
    } finally {
      db.close();
    }
    const exporter = newExporter(path);
    expect((await appendMany(exporter, "exec-future", 1)).lastSequence).toBe(1);
    expect(
      versionRows(path).find((row) => row.component === "future-component")
        ?.version,
    ).toBe(99);
  });
});

// --- Sharing a file with the checkpoint store -------------------------------

describe("SqliteWorkflowEventExporter sharing a file with SqliteWorkflowCheckpointStore", () => {
  test("both keep working on one file, each with its own version row, across a reopen", async () => {
    const path = join(tempDir(), "shared.db");
    const checkpoints = new SqliteWorkflowCheckpointStore({ path });
    const events = newExporter(path);
    try {
      const put = await checkpoints.put({
        checkpoint: await buildCheckpoint("shared-flow", "exec-shared", 0),
      });
      await appendMany(events, "exec-shared", 3);
      expect(put.revision).toBeDefined();
    } finally {
      await checkpoints.close();
      await events.close();
    }
    const rows = versionRows(path);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.component)).size).toBe(2);
    expect(rows.some((row) => /event/i.test(row.component))).toBe(true);
    expect(rows.some((row) => /checkpoint/i.test(row.component))).toBe(true);

    const reopenedCheckpoints = new SqliteWorkflowCheckpointStore({ path });
    const reopenedEvents = newExporter(path);
    try {
      const got = await reopenedCheckpoints.get({
        workflowId: "shared-flow",
        executionId: "exec-shared",
      });
      expect(got?.checkpoint.executionId).toBe("exec-shared");
      const page = await reopenedEvents.read({ executionId: "exec-shared" });
      expect(page.records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    } finally {
      await reopenedCheckpoints.close();
    }
  });
});

// --- Stored records never change ---------------------------------------------

describe("SqliteWorkflowEventExporter append-only storage", () => {
  test("a repeated id stores nothing: no row, no sequence, no change to the summary", async () => {
    const path = join(tempDir(), "dup.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-dup", 2);
    const before = rawCount(
      path,
      "SELECT count(*) AS n FROM workflow_event_records",
    );
    const again = await exporter.append({
      executionId: "exec-dup",
      records: [
        buildRecord("exec-dup", "exec-dup-1", { timestamp: 999_999 }),
        buildRecord("exec-dup", "exec-dup-new", { timestamp: 2_000 }),
      ],
    });
    expect(again.records.map((r) => [r.sequence, r.duplicate])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect(
      rawCount(path, "SELECT count(*) AS n FROM workflow_event_records"),
    ).toBe(before + 1);
    const summary = (await exporter.listExecutions()).items[0];
    expect(summary?.lastSequence).toBe(3);
    expect(summary?.lastTimestamp).toBe(2_000);
  });

  test("a repeated id with a different payload leaves the stored record as it was", async () => {
    const exporter = newExporter(join(tempDir(), "immutable.db"));
    await exporter.append({
      executionId: "exec-immutable",
      records: [
        buildRecord("exec-immutable", "r1", {
          payload: { value: "original" },
          timestamp: 10,
          type: "step_started",
        }),
      ],
    });
    await exporter.append({
      executionId: "exec-immutable",
      records: [
        buildRecord("exec-immutable", "r1", {
          payload: { value: "changed" },
          timestamp: 20,
          type: "step_failed",
        }),
      ],
    });
    const stored = (await exporter.read({ executionId: "exec-immutable" }))
      .records;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload).toEqual({ value: "original" });
    expect(stored[0]?.timestamp).toBe(10);
    expect(stored[0]?.type).toBe("step_started");
  });

  test("a later append never rewrites the rows already stored", async () => {
    const path = join(tempDir(), "rows.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-rows", 5);
    const snapshot = () => {
      const db = rawDatabase(path);
      try {
        return JSON.stringify(
          db
            .prepare(
              "SELECT * FROM workflow_event_records WHERE execution_id = ? ORDER BY sequence",
            )
            .all("exec-rows"),
        );
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    await appendMany(exporter, "exec-rows", 5, 5);
    await appendMany(exporter, "other", 5);
    const after = snapshot();
    const beforeRows = JSON.parse(before) as unknown[];
    expect(JSON.parse(after).slice(0, beforeRows.length)).toEqual(beforeRows);
  });

  test("a batch with an invalid record stores nothing, not even the valid records before it", async () => {
    const path = join(tempDir(), "atomic.db");
    const exporter = newExporter(path);
    const error = await rejected(
      exporter.append({
        executionId: "exec-atomic",
        records: [
          buildRecord("exec-atomic", "ok-1"),
          buildRecord("exec-atomic", "ok-2"),
          { ...buildRecord("exec-atomic", "bad"), kind: "nonsense" as never },
        ],
      }),
    );
    expect(error).toBeDefined();
    expect(
      rawCount(path, "SELECT count(*) AS n FROM workflow_event_records"),
    ).toBe(0);
    const next = await appendMany(exporter, "exec-atomic", 1);
    expect(next.records[0]?.sequence).toBe(1);
  });
});

// --- Reading -----------------------------------------------------------------

describe("SqliteWorkflowEventExporter reads", () => {
  test("pages by sequence through a large execution, visiting every record once", async () => {
    const exporter = newExporter(join(tempDir(), "paging.db"));
    await appendMany(exporter, "exec-page", 250);
    const seen: number[] = [];
    let after = 0;
    for (let pages = 0; pages < 20; pages++) {
      const page = await exporter.read({
        executionId: "exec-page",
        afterSequence: after,
        limit: 100,
      });
      seen.push(...page.records.map((record) => record.sequence));
      after = page.nextAfterSequence;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
  });

  test("filters by kind and by type, keeping sequence order and paging through the filter", async () => {
    const exporter = newExporter(join(tempDir(), "filters.db"));
    const kinds = ["workflow", "step", "span", "agent_run", "warning"] as const;
    await exporter.append({
      executionId: "exec-filter",
      records: Array.from({ length: 40 }, (_, i) =>
        buildRecord("exec-filter", `f-${i}`, {
          kind: kinds[i % kinds.length],
          type: i % 2 === 0 ? "even_type" : "odd_type",
        }),
      ),
    });
    const spans = await exporter.read({
      executionId: "exec-filter",
      kinds: ["span"],
      limit: 3,
    });
    expect(spans.records.every((record) => record.kind === "span")).toBe(true);
    expect(spans.records).toHaveLength(3);
    expect(spans.hasMore).toBe(true);
    const rest = await exporter.read({
      executionId: "exec-filter",
      kinds: ["span"],
      afterSequence: spans.nextAfterSequence,
    });
    expect(rest.records).toHaveLength(5);
    const both = await exporter.read({
      executionId: "exec-filter",
      kinds: ["step", "span"],
      types: ["odd_type"],
      limit: 1000,
    });
    expect(
      both.records.every(
        (record) =>
          ["step", "span"].includes(record.kind) && record.type === "odd_type",
      ),
    ).toBe(true);
    const sequences = both.records.map((record) => record.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(sequences.length).toBeGreaterThan(0);
  });

  test("a read is not blocked by another process holding the write lock", async () => {
    const path = join(tempDir(), "busy-read.db");
    const exporter = newExporter(path, { busyTimeoutMs: 200 });
    await appendMany(exporter, "exec-read", 3);
    const holder = spawnWorker("hold-lock", { path, holdMs: 2000 });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes("locked"));
    const started = performance.now();
    const page = await exporter.read({ executionId: "exec-read" });
    expect(page.records).toHaveLength(3);
    expect((await exporter.listExecutions()).items).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(150);
  }, 30_000);
});

// --- Listing -----------------------------------------------------------------

describe("SqliteWorkflowEventExporter listing", () => {
  test("pages through executions with an opaque cursor and reports each summary", async () => {
    const exporter = newExporter(join(tempDir(), "list.db"));
    for (const id of ["a", "b", "c", "d", "e"]) {
      await appendMany(exporter, `exec-${id}`, 2);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 10; pages++) {
      const page = await exporter.listExecutions({ cursor, limit: 2 });
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const item of page.items) {
        seen.push(item.executionId);
        expect(item.lastSequence).toBe(2);
        expect(item.firstTimestamp).toBeLessThanOrEqual(item.lastTimestamp);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
      expect(typeof cursor).toBe("string");
    }
    expect([...seen].sort()).toEqual([
      "exec-a",
      "exec-b",
      "exec-c",
      "exec-d",
      "exec-e",
    ]);
    expect(new Set(seen).size).toBe(5);
  });

  test("a cursor that is not valid is an invalid option", async () => {
    const exporter = newExporter(join(tempDir(), "bad-cursor.db"));
    const error = await rejected(
      exporter.listExecutions({ cursor: "not a cursor!!" }),
    );
    expectStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION");
  });
});

// --- Pruning -----------------------------------------------------------------

describe("SqliteWorkflowEventExporter pruning", () => {
  test("prune by execution deletes every record and the summary of that execution only", async () => {
    const path = join(tempDir(), "prune-one.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-gone", 7);
    await appendMany(exporter, "exec-kept", 4);
    const result = await exporter.prune({ executionId: "exec-gone" });
    expect(result).toEqual({ executions: 1, records: 7, hasMore: false });
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_records WHERE execution_id = ?",
        "exec-gone",
      ),
    ).toBe(0);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_executions WHERE execution_id = ?",
        "exec-gone",
      ),
    ).toBe(0);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_records WHERE execution_id = ?",
        "exec-kept",
      ),
    ).toBe(4);
  });

  test("a prune that fails part way deletes nothing: records and summary stay together", async () => {
    const path = join(tempDir(), "prune-atomic.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-atomic-prune", 6);
    const db = rawDatabase(path);
    try {
      db.exec(
        "CREATE TRIGGER block_summary_delete BEFORE DELETE ON workflow_event_executions BEGIN SELECT RAISE(ABORT, 'blocked'); END",
      );
    } finally {
      db.close();
    }
    const byExecution = await rejected(
      exporter.prune({ executionId: "exec-atomic-prune" }),
    );
    expect(byExecution).toBeDefined();
    const byAge = await rejected(exporter.prune({ lastRecordBefore: 10_000 }));
    expect(byAge).toBeDefined();
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_records WHERE execution_id = ?",
        "exec-atomic-prune",
      ),
    ).toBe(6);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_executions WHERE execution_id = ?",
        "exec-atomic-prune",
      ),
    ).toBe(1);
    expect(
      (await exporter.read({ executionId: "exec-atomic-prune" })).records,
    ).toHaveLength(6);
  });

  test("prune by age keeps an execution that received a newer record after it was chosen", async () => {
    const path = join(tempDir(), "prune-race.db");
    const exporter = newExporter(path);
    await exporter.append({
      executionId: "a-old",
      records: [buildRecord("a-old", "a1", { timestamp: 10 })],
    });
    await exporter.append({
      executionId: "b-old",
      records: [buildRecord("b-old", "b1", { timestamp: 20 })],
    });
    // Deleting the records of "a-old" makes "b-old" fresh, as an append from
    // another process between the choice and the delete would.
    const db = rawDatabase(path);
    try {
      db.exec(
        `CREATE TRIGGER freshen_other BEFORE DELETE ON workflow_event_records
         WHEN OLD.execution_id = 'a-old'
         BEGIN UPDATE workflow_event_executions SET last_timestamp = 99999 WHERE execution_id = 'b-old'; END`,
      );
    } finally {
      db.close();
    }
    const result = await exporter.prune({ lastRecordBefore: 1_000 });
    expect(result).toEqual({ executions: 1, records: 1, hasMore: false });
    expect(
      (await exporter.read({ executionId: "b-old" })).records,
    ).toHaveLength(1);
    expect(
      (await exporter.read({ executionId: "a-old" })).records,
    ).toHaveLength(0);
  });

  test("a stored record that does not match its row is reported as corrupt", async () => {
    const path = join(tempDir(), "tampered.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-tamper", 2);
    const db = rawDatabase(path);
    try {
      db.prepare(
        "UPDATE workflow_event_records SET id = 'other' WHERE execution_id = ? AND sequence = 2",
      ).run("exec-tamper");
    } finally {
      db.close();
    }
    expectStorageError(
      await rejected(exporter.read({ executionId: "exec-tamper" })),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("prune by age keeps an execution whose newest record is exactly at the cutoff", async () => {
    const exporter = newExporter(join(tempDir(), "prune-boundary.db"));
    await exporter.append({
      executionId: "at-cutoff",
      records: [buildRecord("at-cutoff", "c1", { timestamp: 100 })],
    });
    await exporter.append({
      executionId: "before-cutoff",
      records: [buildRecord("before-cutoff", "b1", { timestamp: 99 })],
    });
    const result = await exporter.prune({ lastRecordBefore: 100, limit: 1 });
    expect(result).toEqual({ executions: 1, records: 1, hasMore: false });
    expect(
      (await exporter.listExecutions()).items.map((item) => item.executionId),
    ).toEqual(["at-cutoff"]);
  });

  test("prune by age keeps an execution that becomes exactly as new as the cutoff after it was chosen", async () => {
    const path = join(tempDir(), "prune-race-boundary.db");
    const exporter = newExporter(path);
    await exporter.append({
      executionId: "a-old",
      records: [buildRecord("a-old", "a1", { timestamp: 10 })],
    });
    await exporter.append({
      executionId: "b-old",
      records: [buildRecord("b-old", "b1", { timestamp: 20 })],
    });
    const db = rawDatabase(path);
    try {
      db.exec(
        `CREATE TRIGGER freshen_to_cutoff BEFORE DELETE ON workflow_event_records
         WHEN OLD.execution_id = 'a-old'
         BEGIN UPDATE workflow_event_executions SET last_timestamp = 1000 WHERE execution_id = 'b-old'; END`,
      );
    } finally {
      db.close();
    }
    const result = await exporter.prune({ lastRecordBefore: 1_000 });
    expect(result).toEqual({ executions: 1, records: 1, hasMore: false });
    expect(
      (await exporter.read({ executionId: "b-old" })).records,
    ).toHaveLength(1);
  });

  test("prune by age deletes whole executions whose newest record is old, never part of one", async () => {
    const path = join(tempDir(), "prune-age.db");
    const exporter = newExporter(path);
    await exporter.append({
      executionId: "old",
      records: [
        buildRecord("old", "o1", { timestamp: 10 }),
        buildRecord("old", "o2", { timestamp: 20 }),
      ],
    });
    // Starts old and ends new: some of its records are older than the cutoff,
    // yet the execution must stay whole.
    await exporter.append({
      executionId: "mixed",
      records: [
        buildRecord("mixed", "m1", { timestamp: 10 }),
        buildRecord("mixed", "m2", { timestamp: 500 }),
      ],
    });
    const result = await exporter.prune({ lastRecordBefore: 100 });
    expect(result).toEqual({ executions: 1, records: 2, hasMore: false });
    const left = (await exporter.listExecutions()).items.map(
      (item) => item.executionId,
    );
    expect(left).toEqual(["mixed"]);
    expect(
      (await exporter.read({ executionId: "mixed" })).records.map(
        (record) => record.id,
      ),
    ).toEqual(["m1", "m2"]);
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_records WHERE execution_id = ?",
        "old",
      ),
    ).toBe(0);
  });

  test("prune by age chooses executions by their newest record, not their first", async () => {
    const exporter = newExporter(join(tempDir(), "prune-newest.db"));
    // Its first record is the oldest of all, its newest is past the cutoff.
    await exporter.append({
      executionId: "started-early",
      records: [
        buildRecord("started-early", "s1", { timestamp: 5 }),
        buildRecord("started-early", "s2", { timestamp: 500 }),
      ],
    });
    await exporter.append({
      executionId: "all-old",
      records: [
        buildRecord("all-old", "a1", { timestamp: 50 }),
        buildRecord("all-old", "a2", { timestamp: 60 }),
      ],
    });
    const result = await exporter.prune({ lastRecordBefore: 100, limit: 1 });
    expect(result).toEqual({ executions: 1, records: 2, hasMore: false });
    expect(
      (await exporter.listExecutions()).items.map((item) => item.executionId),
    ).toEqual(["started-early"]);
  });

  test("prune by age works in bounded batches and reports that more remain", async () => {
    const exporter = newExporter(join(tempDir(), "prune-batches.db"));
    for (let i = 0; i < 5; i++) {
      await exporter.append({
        executionId: `old-${i}`,
        records: [
          buildRecord(`old-${i}`, "r1", { timestamp: 1 }),
          buildRecord(`old-${i}`, "r2", { timestamp: 2 }),
        ],
      });
    }
    const first = await exporter.prune({ lastRecordBefore: 100, limit: 2 });
    expect(first).toEqual({ executions: 2, records: 4, hasMore: true });
    const second = await exporter.prune({ lastRecordBefore: 100, limit: 2 });
    expect(second).toEqual({ executions: 2, records: 4, hasMore: true });
    const third = await exporter.prune({ lastRecordBefore: 100, limit: 2 });
    expect(third).toEqual({ executions: 1, records: 2, hasMore: false });
    expect((await exporter.listExecutions()).items).toHaveLength(0);
  });

  test("a pruned execution starts again at sequence 1 and keeps no old id", async () => {
    const exporter = newExporter(join(tempDir(), "prune-restart.db"));
    await appendMany(exporter, "exec-restart", 3);
    await exporter.prune({ executionId: "exec-restart" });
    const again = await appendMany(exporter, "exec-restart", 1);
    expect(again.records.map((r) => [r.sequence, r.duplicate])).toEqual([
      [1, false],
    ]);
  });
});

// --- Health ------------------------------------------------------------------

describe("SqliteWorkflowEventExporter health", () => {
  test("reports ok for an open database", async () => {
    const exporter = newExporter(join(tempDir(), "health.db"));
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("sqlite");
  });

  test("answers while another process holds the write lock", async () => {
    const path = join(tempDir(), "health-bad.db");
    const exporter = newExporter(path);
    await appendMany(exporter, "exec-health", 1);
    const lock = spawnWorker("hold-lock", { path, holdMs: 3000 });
    workers.push(lock);
    await lock.waitForLine((line) => line.includes("locked"));
    const health = await exporter.healthCheck();
    // The write lock is held elsewhere, so a probe that needs the lock cannot
    // succeed; a probe that only reads may still pass. Either way it answers.
    expect(typeof health.ok).toBe("boolean");
    if (!health.ok) expect(health.code).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
  }, 30_000);
});

// --- Busy database ------------------------------------------------------------

describe("SqliteWorkflowEventExporter busy database", () => {
  test("an append that waits past the busy timeout fails as retryable WORKFLOW_STORAGE_UNAVAILABLE and stores nothing", async () => {
    const path = join(tempDir(), "busy.db");
    const exporter = newExporter(path, { busyTimeoutMs: 300 });
    await appendMany(exporter, "exec-existing", 1);
    const holder = spawnWorker("hold-lock", { path, holdMs: 3000 });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes("locked"));
    const started = performance.now();
    const error = await rejected(appendMany(exporter, "exec-blocked", 2));
    const elapsed = performance.now() - started;
    expectStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE");
    expect((error as { retryable?: boolean }).retryable).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2500);
    holder.kill();
    await holder.exited;
    expect(
      rawCount(
        path,
        "SELECT count(*) AS n FROM workflow_event_records WHERE execution_id = ?",
        "exec-blocked",
      ),
    ).toBe(0);
    const retried = await appendMany(exporter, "exec-blocked", 2);
    expect(retried.records.map((r) => r.sequence)).toEqual([1, 2]);
  }, 30_000);

  test("an append of only repeated ids still needs the write lock, so it waits and fails while another process holds it", async () => {
    const path = join(tempDir(), "busy-duplicates.db");
    const exporter = newExporter(path, { busyTimeoutMs: 300 });
    await appendMany(exporter, "exec-dup-lock", 2);
    const holder = spawnWorker("hold-lock", { path, holdMs: 3000 });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes("locked"));
    const error = await rejected(appendMany(exporter, "exec-dup-lock", 2));
    expectStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE");
    holder.kill();
    await holder.exited;
  }, 30_000);

  test("an append waits for a lock that is released within the busy timeout, then succeeds", async () => {
    const path = join(tempDir(), "busy-wait.db");
    const exporter = newExporter(path, { busyTimeoutMs: 8000 });
    await appendMany(exporter, "exec-existing", 1);
    const holder = spawnWorker("hold-lock", { path, holdMs: 500 });
    workers.push(holder);
    await holder.waitForLine((line) => line.includes("locked"));
    const started = performance.now();
    const result = await appendMany(exporter, "exec-waited", 1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(300);
    expect(result.records[0]?.sequence).toBe(1);
  }, 30_000);
});
