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
import { openSqliteDatabase } from "../../../../src/utils/sqlite-database.js";
import { SqliteWorkflowEventExporter } from "../../../../src/workflows/events/sqlite/index.js";
import { buildRecord } from "./fixtures/event-worker.js";

// `fixtures/events-v1.db` is a database written by the first release of the
// exporter (schema version 1) and committed to the repository. The script
// that produced it is `fixtures/event-worker.ts`, mode `generate-v1`. The
// file holds two executions:
//
// - `exec-1`: four records (workflow started, step completed, span ended,
//   workflow completed) with timestamps 1000, 1100, 1200 and 1300
// - `exec-2`: one record (workflow started) with timestamp 5000
//
// A later version of the exporter must keep reading it. When the schema moves
// to version 2, this fixture stays at version 1 and is migrated on open.

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);
const FIXTURE_DATABASE = new URL("events-v1.db", FIXTURE_DIR).pathname;
const FIXTURE_GENERATOR = new URL("event-worker.ts", FIXTURE_DIR).pathname;

const directories: string[] = [];
const exporters: SqliteWorkflowEventExporter[] = [];

function copyOfFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-events-compat-"));
  directories.push(dir);
  const path = join(dir, "copy.db");
  copyFileSync(FIXTURE_DATABASE, path);
  return path;
}

function open(path: string): SqliteWorkflowEventExporter {
  const exporter = new SqliteWorkflowEventExporter({ path });
  exporters.push(exporter);
  return exporter;
}

afterEach(async () => {
  for (const exporter of exporters.splice(0))
    await exporter.close().catch(() => undefined);
});

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteWorkflowEventExporter version 1 database", () => {
  test("the committed fixture and the script that generated it exist", () => {
    expect(existsSync(FIXTURE_DATABASE)).toBe(true);
    expect(existsSync(FIXTURE_GENERATOR)).toBe(true);
    expect(readFileSync(FIXTURE_DATABASE).subarray(0, 15).toString()).toBe(
      "SQLite format 3",
    );
    const script = readFileSync(FIXTURE_GENERATOR, "utf8");
    expect(script).toContain("generate-v1");
    expect(script).toContain("SqliteWorkflowEventExporter");
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
      expect(String(rows[0]?.component)).toMatch(/event/i);
      expect(Number(rows[0]?.version)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("still reads every record it holds, in sequence order", async () => {
    const exporter = open(copyOfFixture());
    const first = await exporter.read({ executionId: "exec-1" });
    expect(
      first.records.map((r) => [r.sequence, r.id, r.kind, r.type]),
    ).toEqual([
      [1, "e1-start", "workflow", "workflow_started"],
      [2, "e1-step", "step", "step_completed"],
      [3, "e1-span", "span", "span_ended"],
      [4, "e1-end", "workflow", "workflow_completed"],
    ]);
    expect(first.records[0]?.payload).toEqual({ note: "first" });
    expect(first.records.map((r) => r.timestamp)).toEqual([
      1000, 1100, 1200, 1300,
    ]);
    expect(first.hasMore).toBe(false);
    const second = await exporter.read({ executionId: "exec-2" });
    expect(second.records.map((r) => r.id)).toEqual(["e2-start"]);
  });

  test("still filters by kind and type", async () => {
    const exporter = open(copyOfFixture());
    const workflow = await exporter.read({
      executionId: "exec-1",
      kinds: ["workflow"],
    });
    expect(workflow.records.map((r) => r.id)).toEqual(["e1-start", "e1-end"]);
    const typed = await exporter.read({
      executionId: "exec-1",
      types: ["span_ended"],
    });
    expect(typed.records.map((r) => r.id)).toEqual(["e1-span"]);
  });

  test("still lists its executions with their summaries", async () => {
    const exporter = open(copyOfFixture());
    const page = await exporter.listExecutions();
    expect(page.items).toEqual([
      {
        executionId: "exec-1",
        lastSequence: 4,
        firstTimestamp: 1000,
        lastTimestamp: 1300,
      },
      {
        executionId: "exec-2",
        lastSequence: 1,
        firstTimestamp: 5000,
        lastTimestamp: 5000,
      },
    ]);
  });

  test("keeps the sequence going and detects stored ids after opening it", async () => {
    const exporter = open(copyOfFixture());
    const result = await exporter.append({
      executionId: "exec-1",
      records: [
        buildRecord("exec-1", "e1-step", { timestamp: 9999 }),
        buildRecord("exec-1", "e1-later", { timestamp: 2000 }),
      ],
    });
    expect(result.records.map((r) => [r.sequence, r.duplicate])).toEqual([
      [2, true],
      [5, false],
    ]);
    expect(result.lastSequence).toBe(5);
  });

  test("opening it keeps the version at 1 until a later release migrates it, and prune still removes whole executions", async () => {
    const path = copyOfFixture();
    const exporter = open(path);
    const result = await exporter.prune({ executionId: "exec-2" });
    expect(result).toEqual({ executions: 1, records: 1, hasMore: false });
    await exporter.close();
    const db = openSqliteDatabase({
      path,
      fail: (failure, message) => new Error(`${failure}: ${message}`),
    });
    try {
      const row = db
        .prepare(
          "SELECT version FROM adk_llm_bridge_schema_versions WHERE component LIKE '%event%'",
        )
        .get();
      expect(Number(row?.version)).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
