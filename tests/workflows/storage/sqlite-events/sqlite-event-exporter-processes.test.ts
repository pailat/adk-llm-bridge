import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../../../../src/utils/sqlite-database.js";
import { SqliteWorkflowEventExporter } from "../../../../src/workflows/events/sqlite/index.js";
import { type SpawnedWorker, spawnWorker } from "./fixtures/event-worker.js";

// These tests start real processes that share one database file: they race
// appends to one execution and kill a writer with SIGKILL.

const directories: string[] = [];
const spawned: SpawnedWorker[] = [];
const exporters: SqliteWorkflowEventExporter[] = [];

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-events-proc-"));
  directories.push(dir);
  return join(dir, name);
}

function start(mode: string, args: Record<string, unknown>): SpawnedWorker {
  const worker = spawnWorker(mode, args);
  spawned.push(worker);
  return worker;
}

function open(path: string): SqliteWorkflowEventExporter {
  const exporter = new SqliteWorkflowEventExporter({
    path,
    busyTimeoutMs: 20_000,
  });
  exporters.push(exporter);
  return exporter;
}

afterEach(async () => {
  for (const worker of spawned.splice(0)) {
    worker.kill("SIGKILL");
    await worker.exited.catch(() => undefined);
  }
  for (const exporter of exporters.splice(0)) {
    await exporter.close().catch(() => undefined);
  }
});

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

interface StoredRow {
  id: string;
  sequence: number;
}

function storedRows(path: string, executionId: string): StoredRow[] {
  const db = openSqliteDatabase({
    path,
    fail: (failure, message) => new Error(`${failure}: ${message}`),
  });
  try {
    return db
      .prepare(
        "SELECT id, sequence FROM workflow_event_records WHERE execution_id = ? ORDER BY sequence",
      )
      .all(executionId)
      .map((row) => ({ id: String(row.id), sequence: Number(row.sequence) }));
  } finally {
    db.close();
  }
}

function integrityOf(path: string): string {
  const db = openSqliteDatabase({
    path,
    fail: (failure, message) => new Error(`${failure}: ${message}`),
  });
  try {
    return String(
      Object.values(db.prepare("PRAGMA integrity_check").get() ?? {})[0],
    );
  } finally {
    db.close();
  }
}

function dense(rows: readonly StoredRow[]): boolean {
  return rows.every((row, index) => row.sequence === index + 1);
}

interface WorkerReport {
  done: boolean;
  index: number;
  sequences: number[];
  code?: string;
  message?: string;
}

async function runAppenders(
  path: string,
  count: number,
  args: Record<string, unknown>,
): Promise<WorkerReport[]> {
  const startAt = Date.now() + 3000;
  const group = Array.from({ length: count }, (_, index) =>
    start("append", { path, index, startAt, ...args }),
  );
  return await Promise.all(
    group.map(async (worker) => {
      const line = await worker.waitForLine(
        (text) => text.startsWith("{") && text.includes('"index"'),
        60_000,
      );
      return JSON.parse(line) as WorkerReport;
    }),
  );
}

describe("SqliteWorkflowEventExporter in several processes", () => {
  const WORKERS = 8;
  const BATCHES = 10;
  const BATCH_SIZE = 5;
  const TOTAL = WORKERS * BATCHES * BATCH_SIZE;

  test("N processes appending to one execution leave sequences 1..N with no gap and no repeat", async () => {
    const path = tempPath("race.db");
    open(path);
    const reports = await runAppenders(path, WORKERS, {
      executionId: "race",
      batches: BATCHES,
      batchSize: BATCH_SIZE,
    });
    for (const report of reports) {
      expect(report.done).toBe(true);
      expect(report.sequences).toHaveLength(BATCHES * BATCH_SIZE);
    }
    const reported = reports.flatMap((report) => report.sequences);
    expect(new Set(reported).size).toBe(TOTAL);
    expect([...reported].sort((a, b) => a - b)).toEqual(
      Array.from({ length: TOTAL }, (_, i) => i + 1),
    );
    const rows = storedRows(path, "race");
    expect(rows).toHaveLength(TOTAL);
    expect(dense(rows)).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(TOTAL);
    const summary = (await open(path).listExecutions()).items[0];
    expect(summary?.lastSequence).toBe(TOTAL);
  }, 120_000);

  test("a batch of one process gets consecutive sequences: no other process writes inside it", async () => {
    const path = tempPath("contiguous.db");
    open(path);
    const reports = await runAppenders(path, WORKERS, {
      executionId: "contiguous",
      batches: BATCHES,
      batchSize: BATCH_SIZE,
    });
    for (const report of reports) {
      for (let at = 0; at < report.sequences.length; at += BATCH_SIZE) {
        const batch = report.sequences.slice(at, at + BATCH_SIZE);
        expect(batch).toEqual(
          Array.from(
            { length: BATCH_SIZE },
            (_, i) => (batch[0] as number) + i,
          ),
        );
      }
    }
  }, 120_000);

  test("N processes appending the same ids store each id once, and every process learns the same sequence", async () => {
    const path = tempPath("same-ids.db");
    open(path);
    const reports = await runAppenders(path, WORKERS, {
      executionId: "same-ids",
      batches: 6,
      batchSize: 4,
      idPrefix: "shared",
    });
    for (const report of reports) expect(report.done).toBe(true);
    const unique = 6 * 4;
    const rows = storedRows(path, "same-ids");
    expect(rows).toHaveLength(unique);
    expect(dense(rows)).toBe(true);
    expect(new Set(rows.map((row) => row.id)).size).toBe(unique);
    // Every process reports the sequence the record was stored with.
    const byId = new Map(rows.map((row) => [row.id, row.sequence]));
    for (const report of reports) {
      report.sequences.forEach((sequence, position) => {
        const batch = Math.floor(position / 4);
        const id = `shared-b${batch}-r${position % 4}`;
        expect(sequence).toBe(byId.get(id) as number);
      });
    }
  }, 120_000);

  test("processes appending to different executions each keep their own sequence from 1", async () => {
    const path = tempPath("separate.db");
    open(path);
    const group = Array.from({ length: 4 }, (_, index) =>
      start("append", {
        path,
        index,
        startAt: Date.now() + 2000,
        executionId: `exec-${index}`,
        batches: 5,
        batchSize: 5,
      }),
    );
    for (const worker of group) {
      await worker.waitForLine((line) => line.includes('"done":true'), 60_000);
    }
    for (let index = 0; index < 4; index++) {
      const rows = storedRows(path, `exec-${index}`);
      expect(rows).toHaveLength(25);
      expect(dense(rows)).toBe(true);
    }
  }, 120_000);
});

describe("SqliteWorkflowEventExporter killed mid-append", () => {
  const BATCH_SIZE = 200;

  function batchesOf(rows: readonly StoredRow[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const batch = row.id.slice(0, row.id.lastIndexOf("-r"));
      counts.set(batch, (counts.get(batch) ?? 0) + 1);
    }
    return counts;
  }

  test("SIGKILL while batches are being appended leaves only whole batches and a sequence without gaps, in every round", async () => {
    const path = tempPath("kill.db");
    const exporter = open(path);
    let committedTotal = 0;
    for (let round = 0; round < 6; round++) {
      const worker = start("append-forever", {
        path,
        executionId: "killed",
        batchSize: BATCH_SIZE,
        padding: 1500,
        idPrefix: `round${round}`,
      });
      await worker.waitForLine((line) => line.includes("started"), 30_000);
      let lastCommitted = -1;
      // Wait for a few commits, then kill at once so the next batch is most
      // likely in flight; later rounds kill a little later.
      const target = 1 + (round % 3);
      await worker.waitForLine((line) => {
        if (!line.includes("committed")) return false;
        lastCommitted = (JSON.parse(line) as { committed: number }).committed;
        return lastCommitted >= target;
      }, 30_000);
      Bun.sleepSync(round * 3);
      worker.kill("SIGKILL");
      expect(await worker.exited).toBeNull();
      for (const line of worker.lines) {
        if (line.includes("committed")) {
          lastCommitted = Math.max(
            lastCommitted,
            (JSON.parse(line) as { committed: number }).committed,
          );
        }
      }

      const rows = storedRows(path, "killed");
      expect(dense(rows)).toBe(true);
      expect(rows.length % BATCH_SIZE).toBe(0);
      const counts = batchesOf(rows);
      for (const [batch, count] of counts) {
        expect(`${batch}: ${count}`).toBe(`${batch}: ${BATCH_SIZE}`);
      }
      // Every batch the worker reported as committed is stored.
      const mine = [...counts.keys()].filter((name) =>
        name.startsWith(`round${round}-`),
      );
      expect(mine.length).toBeGreaterThanOrEqual(lastCommitted + 1);
      committedTotal = rows.length;

      const summary = (await exporter.listExecutions()).items[0];
      expect(summary?.lastSequence).toBe(rows.length);
      expect(integrityOf(path)).toBe("ok");
    }
    // The next append continues the sequence where the killed ones stopped.
    const next = await exporter.append({
      executionId: "killed",
      records: [
        {
          id: "after-kills",
          executionId: "killed",
          kind: "step",
          type: "step_completed",
          timestamp: 5,
          payload: {},
        },
      ],
    });
    expect(next.records[0]?.sequence).toBe(committedTotal + 1);
    expect(next.lastSequence).toBe(committedTotal + 1);
  }, 120_000);

  test("a process killed while another keeps appending: the survivor's batches are all stored and the log has no gap", async () => {
    const path = tempPath("kill-with-survivor.db");
    open(path);
    const survivor = start("append", {
      path,
      index: 0,
      startAt: Date.now() + 1500,
      executionId: "mixed",
      batches: 20,
      batchSize: 25,
    });
    const victim = start("append-forever", {
      path,
      executionId: "mixed",
      batchSize: BATCH_SIZE,
      padding: 1000,
      idPrefix: "victim",
    });
    await victim.waitForLine((line) => line.includes('"committed":1'), 30_000);
    victim.kill("SIGKILL");
    await victim.exited;
    const line = await survivor.waitForLine(
      (text) => text.includes('"index"'),
      60_000,
    );
    expect((JSON.parse(line) as WorkerReport).done).toBe(true);
    const rows = storedRows(path, "mixed");
    expect(dense(rows)).toBe(true);
    expect(rows.filter((row) => row.id.startsWith("w0-"))).toHaveLength(500);
    const victims = rows.filter((row) => row.id.startsWith("victim-"));
    expect(victims.length % BATCH_SIZE).toBe(0);
    expect(integrityOf(path)).toBe("ok");
  }, 120_000);
});
