import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkflowCheckpointStore } from "../../../../src/workflows/checkpoint/sqlite/index.js";
import { SqliteWorkflowEventExporter } from "../../../../src/workflows/events/sqlite/index.js";
import {
  nodeSqliteAvailable,
  openRawDatabase,
} from "../../../utils/fixtures/raw-sqlite.js";
import { buildCheckpoint } from "../sqlite-checkpoint/fixtures/checkpoint-worker.js";
import { buildRecord } from "./fixtures/event-worker.js";

// Load test of the SQLite providers on one shared file.
//
// By default it stores 1 000 checkpoints and 50 000 event records, with every
// budget scaled to that size. With ADK_LLM_BRIDGE_LOAD_TEST=full it stores
// 10 000 checkpoints and 1 000 000 event records against the full budgets.
// Both print the numbers they measured.
//
// Budgets at full size (the design's initial budgets):
//
// | Step                                       | Budget   | Measured |
// |--------------------------------------------|----------|----------|
// | 10 000 saves of 4 KiB                      | 60 s     | 1.89 s   |
// | list all checkpoints in pages of 500       | 5 s      | 0.04 s   |
// | 1 000 000 appends in batches of 500        | 180 s    | 6.34 s   |
// | read all records in pages of 1 000         | 60 s     | 0.85 s   |
// | resident memory growth over the whole run  | 300 MiB  | 10.4 MiB |
//
// A budget may be changed only together with the measurement that justifies
// it, written in the Measured column on the same line, with the machine and
// the date. Measured with the full run on an Apple Silicon (arm64) Mac, Bun
// 1.4.4, on 2026-11-10.

const FULL = process.env.ADK_LLM_BRIDGE_LOAD_TEST === "full";
const CHECKPOINTS = FULL ? 10_000 : 1_000;
const RECORDS = FULL ? 1_000_000 : 50_000;
const SCALE_CHECKPOINTS = CHECKPOINTS / 10_000;
const SCALE_RECORDS = RECORDS / 1_000_000;

const BUDGET = {
  saveSeconds: 60 * SCALE_CHECKPOINTS,
  listSeconds: 5 * SCALE_CHECKPOINTS,
  appendSeconds: 180 * SCALE_RECORDS,
  readSeconds: 60 * SCALE_RECORDS,
  // Memory does not shrink in proportion to the data: the default run keeps a
  // third of the full budget.
  rssGrowthMiB: FULL ? 300 : 100,
};

// The time budgets are about work, not about how busy the machine is. Before
// the run, a fixed reference workload on plain SQLite is timed in this same
// process; a machine that is slower right now than when the budgets were
// measured scales every time budget by the same ratio. The memory budget is not
// scaled. A store that becomes slower than SQLite itself still fails, because
// the reference does not include the store.
const REFERENCE_IDLE_MS = 100;
const REFERENCE_RUNS = 3;

function referenceMilliseconds(dir: string, run: number): number {
  const started = performance.now();
  const db = openRawDatabase(join(dir, `reference-${run}.db`));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)",
    );
    const insert = db.prepare("INSERT INTO t (body) VALUES (?)");
    const body = "x".repeat(CHECKPOINT_BYTES);
    for (let i = 0; i < 1_000; i++) insert.run(body);
    db.exec("BEGIN");
    for (let i = 0; i < 100_000; i++) insert.run("note");
    db.exec("COMMIT");
    let rows = 0;
    for (const _ of db.prepare("SELECT id, body FROM t").iterate()) rows++;
    if (rows !== 101_000) throw new Error("reference workload lost rows");
  } finally {
    db.close();
  }
  return performance.now() - started;
}

/** How many times slower than the budget measurements this machine is now. */
function slowdown(dir: string): number {
  const runs = Array.from({ length: REFERENCE_RUNS }, (_, run) =>
    referenceMilliseconds(dir, run),
  ).sort((a, b) => a - b);
  const median = runs[Math.floor(runs.length / 2)] as number;
  return Math.max(1, median / REFERENCE_IDLE_MS);
}

const APPEND_BATCH = 500;
const READ_PAGE = 1_000;
const LIST_PAGE = 500;
const EXECUTION_RECORDS = 10_000;
const CHECKPOINT_BYTES = 4 * 1024;

const directories: string[] = [];
afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const MiB = 1024 * 1024;

function collectGarbage(): void {
  (globalThis as { Bun?: { gc(sync: boolean): void } }).Bun?.gc(true);
}

function seconds(started: number): number {
  return (performance.now() - started) / 1000;
}

function report(line: string): void {
  console.log(`[sqlite load ${FULL ? "full" : "default"}] ${line}`);
}

// Needs the built-in `node:sqlite` for the reference database.
describe.skipIf(!nodeSqliteAvailable)(
  `SQLite storage load (${CHECKPOINTS} checkpoints, ${RECORDS} event records)`,
  () => {
    test("stays inside its time and memory budgets on one shared database file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "sqlite-load-"));
      directories.push(dir);
      const path = join(dir, "load.db");
      const factor = slowdown(dir);
      report(
        `machine slowdown against the reference workload: x${factor.toFixed(2)}`,
      );
      const checkpoints = new SqliteWorkflowCheckpointStore({
        path,
        busyTimeoutMs: 30_000,
      });
      const events = new SqliteWorkflowEventExporter({
        path,
        busyTimeoutMs: 30_000,
      });
      // Start from a collected heap: when the whole suite runs in one process,
      // garbage left by earlier test files would otherwise count as growth.
      collectGarbage();
      const rssStart = process.memoryUsage().rss;
      let rssPeak = rssStart;
      // Collect before each sample so the number is memory still held, not
      // garbage the collector has not freed yet (which varies with whatever
      // else ran in the process).
      const sampleRss = (): void => {
        collectGarbage();
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      };
      try {
        // 1. Checkpoint saves of about 4 KiB each.
        const prepared = await buildCheckpoint(
          "load-flow",
          "exec-0",
          1,
          CHECKPOINT_BYTES,
        );
        let started = performance.now();
        for (let i = 0; i < CHECKPOINTS; i++) {
          await checkpoints.put({
            checkpoint: { ...prepared, executionId: `exec-${i}` },
          });
          if (i % 200 === 0) sampleRss();
        }
        const saveSeconds = seconds(started);
        report(
          `saved ${CHECKPOINTS} checkpoints in ${saveSeconds.toFixed(2)} s (budget ${(BUDGET.saveSeconds * factor).toFixed(2)} s)`,
        );

        // 2. Listing every checkpoint in pages.
        started = performance.now();
        let listed = 0;
        let cursor: string | undefined;
        do {
          const page = await checkpoints.list({ cursor, limit: LIST_PAGE });
          listed += page.items.length;
          cursor = page.nextCursor;
          sampleRss();
        } while (cursor !== undefined);
        const listSeconds = seconds(started);
        report(
          `listed ${listed} checkpoints in pages of ${LIST_PAGE} in ${listSeconds.toFixed(2)} s (budget ${(BUDGET.listSeconds * factor).toFixed(2)} s)`,
        );
        expect(listed).toBe(CHECKPOINTS);

        // 3. Appending event records in batches, spread over executions.
        started = performance.now();
        let appended = 0;
        let batchNumber = 0;
        while (appended < RECORDS) {
          const size = Math.min(APPEND_BATCH, RECORDS - appended);
          const executionId = `load-exec-${Math.floor(appended / EXECUTION_RECORDS)}`;
          const base = appended % EXECUTION_RECORDS;
          await events.append({
            executionId,
            records: Array.from({ length: size }, (_, i) =>
              buildRecord(executionId, `r-${base + i}`, {
                timestamp: 1_000 + appended + i,
                kind: "step",
                type: "step_completed",
                payload: { index: base + i, note: "load" },
              }),
            ),
          });
          appended += size;
          if (++batchNumber % 20 === 0) sampleRss();
        }
        const appendSeconds = seconds(started);
        report(
          `appended ${appended} records in batches of ${APPEND_BATCH} in ${appendSeconds.toFixed(2)} s (budget ${(BUDGET.appendSeconds * factor).toFixed(2)} s)`,
        );
        expect(appended).toBe(RECORDS);

        // 4. Reading everything back in pages, checking order and counts.
        started = performance.now();
        let read = 0;
        const executions = Math.ceil(RECORDS / EXECUTION_RECORDS);
        for (let e = 0; e < executions; e++) {
          const executionId = `load-exec-${e}`;
          const expected = Math.min(
            EXECUTION_RECORDS,
            RECORDS - e * EXECUTION_RECORDS,
          );
          let after = 0;
          let seen = 0;
          for (;;) {
            const page = await events.read({
              executionId,
              afterSequence: after,
              limit: READ_PAGE,
            });
            for (const record of page.records) {
              seen++;
              if (record.sequence !== seen) {
                throw new Error(
                  `${executionId}: sequence ${record.sequence} where ${seen} was expected`,
                );
              }
            }
            after = page.nextAfterSequence;
            if (!page.hasMore) break;
          }
          expect(seen).toBe(expected);
          read += seen;
          sampleRss();
        }
        const readSeconds = seconds(started);
        report(
          `read ${read} records in pages of ${READ_PAGE} in ${readSeconds.toFixed(2)} s (budget ${(BUDGET.readSeconds * factor).toFixed(2)} s)`,
        );
        expect(read).toBe(RECORDS);

        const listedExecutions = await events.listExecutions({ limit: 5 });
        expect(listedExecutions.items.length).toBeGreaterThan(0);

        sampleRss();
        const rssGrowthMiB = (rssPeak - rssStart) / MiB;
        report(
          `resident memory grew ${rssGrowthMiB.toFixed(1)} MiB (budget ${BUDGET.rssGrowthMiB} MiB)`,
        );

        expect(saveSeconds).toBeLessThanOrEqual(BUDGET.saveSeconds * factor);
        expect(listSeconds).toBeLessThanOrEqual(BUDGET.listSeconds * factor);
        expect(appendSeconds).toBeLessThanOrEqual(
          BUDGET.appendSeconds * factor,
        );
        expect(readSeconds).toBeLessThanOrEqual(BUDGET.readSeconds * factor);
        expect(rssGrowthMiB).toBeLessThanOrEqual(BUDGET.rssGrowthMiB);
      } finally {
        await checkpoints.close().catch(() => undefined);
        await events.close().catch(() => undefined);
      }
    }, 1_800_000);
  },
);
