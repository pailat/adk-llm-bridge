import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSqliteDatabase } from "../../../../src/utils/sqlite-database.js";
import { SqliteWorkflowCheckpointStore } from "../../../../src/workflows/checkpoint/sqlite/index.js";
import { buildCheckpoint } from "./fixtures/checkpoint-worker.js";

// `fixtures/checkpoint-v1.db` is a database written by the first release of
// the provider (schema version 1) and committed to the repository.
// `fixtures/generate-checkpoint-v1.ts` is the script that produced it. The
// file holds three checkpoints:
//
// - workflow `compat-flow`, execution `exec-1`: status running
// - workflow `compat-flow`, execution `exec-2`: status completed
// - workflow `other-flow`, execution `exec-1`: status running
//
// A later version of the provider must keep reading it. When the schema moves
// to version 2, this fixture stays at version 1 and is migrated on open.

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
const FIXTURE_DATABASE = fileURLToPath(
  new URL("checkpoint-v1.db", FIXTURE_DIR),
);
const FIXTURE_GENERATOR = fileURLToPath(
  new URL("generate-checkpoint-v1.ts", FIXTURE_DIR),
);

const directories: string[] = [];
const stores: SqliteWorkflowCheckpointStore[] = [];

function copyOfFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-checkpoint-compat-"));
  directories.push(dir);
  const path = join(dir, "copy.db");
  copyFileSync(FIXTURE_DATABASE, path);
  return path;
}

function open(path: string): SqliteWorkflowCheckpointStore {
  const store = new SqliteWorkflowCheckpointStore({ path });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const store of stores.splice(0))
    await store.close().catch(() => undefined);
});

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteWorkflowCheckpointStore version 1 database", () => {
  test("the committed fixture and the script that generated it exist", () => {
    expect(existsSync(FIXTURE_DATABASE)).toBe(true);
    expect(existsSync(FIXTURE_GENERATOR)).toBe(true);
    expect(readFileSync(FIXTURE_DATABASE).subarray(0, 15).toString()).toBe(
      "SQLite format 3",
    );
    expect(readFileSync(FIXTURE_GENERATOR, "utf8")).toContain(
      "SqliteWorkflowCheckpointStore",
    );
  });

  test("the fixture is at schema version 1 in the versions table", () => {
    const db = openSqliteDatabase({
      path: copyOfFixture(),
      fail: (failure, message) => new Error(`${failure}: ${message}`),
    });
    try {
      const rows = db
        .prepare(
          "SELECT component, version FROM adk_llm_bridge_schema_versions",
        )
        .all();
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.version)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("still loads every checkpoint it holds", async () => {
    const store = open(copyOfFixture());
    const first = await store.get({
      workflowId: "compat-flow",
      executionId: "exec-1",
    });
    expect(first?.checkpoint.status).toBe("running");
    expect(first?.checkpoint.workflowId).toBe("compat-flow");
    expect(first?.checkpoint.executionId).toBe("exec-1");
    expect(first?.revision).toMatch(/^sha256:/);
    const second = await store.get({
      workflowId: "compat-flow",
      executionId: "exec-2",
    });
    expect(second?.checkpoint.status).toBe("completed");
    const other = await store.get({
      workflowId: "other-flow",
      executionId: "exec-1",
    });
    expect(other?.checkpoint.workflowId).toBe("other-flow");
    expect(
      await store.get({ workflowId: "compat-flow", executionId: "missing" }),
    ).toBeUndefined();
  });

  test("still lists its checkpoints in workflow and execution order, and filters them", async () => {
    const store = open(copyOfFixture());
    const all = await store.list({});
    expect(
      all.items.map((item) => `${item.workflowId}/${item.executionId}`),
    ).toEqual([
      "compat-flow/exec-1",
      "compat-flow/exec-2",
      "other-flow/exec-1",
    ]);
    expect(all.items.map((item) => item.status)).toEqual([
      "running",
      "completed",
      "running",
    ]);
    expect(
      (await store.list({ workflowId: "compat-flow", status: "completed" }))
        .items,
    ).toHaveLength(1);
    const paged = await store.list({ limit: 2 });
    expect(paged.items).toHaveLength(2);
    const rest = await store.list({
      limit: 2,
      cursor: paged.nextCursor as string,
    });
    expect(rest.items.map((item) => item.executionId)).toEqual(["exec-1"]);
  });

  test("keeps accepting writes and leases, and stays at version 1", async () => {
    const path = copyOfFixture();
    const store = open(path);
    const current = await store.get({
      workflowId: "compat-flow",
      executionId: "exec-1",
    });
    const next = await store.put({
      checkpoint: await buildCheckpoint("compat-flow", "exec-1", 4),
      expectedRevision: current?.revision as string,
    });
    expect(
      (await store.get({ workflowId: "compat-flow", executionId: "exec-1" }))
        ?.revision,
    ).toBe(next.revision);
    const lease = await store.acquireLease({
      workflowId: "compat-flow",
      executionId: "exec-2",
      ownerId: "compat",
      ttlMs: 60_000,
    });
    expect(lease.fencingToken).toBe(1);
    expect((await store.healthCheck()).schemaVersion).toBe(1);
  });

  test("opening the fixture does not change what it holds", async () => {
    const path = copyOfFixture();
    const before = await (async () => {
      const store = open(path);
      return (await store.list({})).items;
    })();
    await stores.pop()?.close();
    const again = open(path);
    expect((await again.list({})).items).toEqual(before);
  });

  test("a later schema step is applied to a version 1 database and the stored version moves forward", async () => {
    const path = copyOfFixture();
    const db = openSqliteDatabase({
      path,
      fail: (failure, message) => new Error(`${failure}: ${message}`),
    });
    try {
      const component = String(
        db.prepare("SELECT component FROM adk_llm_bridge_schema_versions").get()
          ?.component,
      );
      const steps = [
        { version: 1, sql: "SELECT 1" },
        { version: 2, sql: "ALTER TABLE checkpoints ADD COLUMN note TEXT" },
      ];
      expect(db.migrate(component, steps)).toEqual({ from: 1, to: 2 });
      expect(db.schemaVersion(component)).toBe(2);
      const columns = db
        .prepare("PRAGMA table_info(checkpoints)")
        .all()
        .map((column) => column.name);
      expect(columns).toContain("note");
      expect(db.prepare("SELECT count(*) AS n FROM checkpoints").get()?.n).toBe(
        3,
      );
      // Running it again changes nothing.
      expect(db.migrate(component, steps)).toEqual({ from: 2, to: 2 });
    } finally {
      db.close();
    }
  });
});
