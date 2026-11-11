import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteDatabase } from "../../../../src/utils/sqlite-database.js";
import { SqliteWorkflowCheckpointStore } from "../../../../src/workflows/checkpoint/sqlite/index.js";
import { workflowCheckpointRevision } from "../../../../src/workflows/checkpoint/store.js";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import {
  buildCheckpoint,
  type SpawnedWorker,
  spawnWorker,
} from "./fixtures/checkpoint-worker.js";

// These tests start real processes that share one database file: they race
// compare-and-set and leases, and kill a writer with SIGKILL.

const WORKFLOW = "wf-processes";
const WORKERS = 8;
const ROUNDS = 6;

const directories: string[] = [];
const spawned: SpawnedWorker[] = [];
const stores: SqliteWorkflowCheckpointStore[] = [];

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-checkpoint-proc-"));
  directories.push(dir);
  return join(dir, name);
}

function start(mode: string, args: Record<string, unknown>): SpawnedWorker {
  const worker = spawnWorker(mode, args);
  spawned.push(worker);
  return worker;
}

function open(path: string): SqliteWorkflowCheckpointStore {
  const store = new SqliteWorkflowCheckpointStore({
    path,
    busyTimeoutMs: 20_000,
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  for (const worker of spawned.splice(0)) {
    worker.kill("SIGKILL");
    await worker.exited.catch(() => undefined);
  }
  for (const store of stores.splice(0)) {
    await store.close().catch(() => undefined);
  }
});

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

interface RoundResult {
  round: number;
  ok: boolean;
  revision?: string;
  token?: number;
  code?: string;
  reason?: string;
}

async function runRace(
  mode: "cas" | "lease",
  path: string,
  extra: Record<string, unknown>,
): Promise<RoundResult[][]> {
  const startAt = Date.now() + 3000;
  const workers = Array.from({ length: WORKERS }, (_, index) =>
    start(mode, {
      path,
      workflowId: WORKFLOW,
      executionPrefix: "race",
      index,
      rounds: ROUNDS,
      gapMs: 150,
      startAt,
      ...extra,
    }),
  );
  const perWorker: RoundResult[][] = [];
  for (const worker of workers) {
    const line = await worker.waitForLine(
      (text) => text.includes('"done"'),
      60_000,
    );
    expect(await worker.exited).toBe(0);
    perWorker.push((JSON.parse(line) as { results: RoundResult[] }).results);
  }
  return perWorker;
}

describe("SqliteWorkflowCheckpointStore across processes", () => {
  test("exactly one of N worker processes wins a compare-and-set on one execution, in every round", async () => {
    const path = tempPath("cas.db");
    const store = open(path);
    for (let round = 0; round < ROUNDS; round++) {
      await store.put({
        checkpoint: await buildCheckpoint(WORKFLOW, `race-${round}`, 0),
        expectedRevision: null,
      });
    }
    const perWorker = await runRace("cas", path, {});
    for (let round = 0; round < ROUNDS; round++) {
      const results = perWorker.map(
        (worker) =>
          worker.find((entry) => entry.round === round) as RoundResult,
      );
      const winners = results.filter((entry) => entry.ok);
      expect(winners).toHaveLength(1);
      for (const loser of results.filter((entry) => !entry.ok)) {
        expect(loser.reason).toBe("checkpoint_revision_conflict");
      }
      const winnerIndex = results.findIndex((entry) => entry.ok);
      const stored = await store.get({
        workflowId: WORKFLOW,
        executionId: `race-${round}`,
      });
      expect(stored?.revision).toBe(winners[0]?.revision);
      const expected = await buildCheckpoint(
        WORKFLOW,
        `race-${round}`,
        1000 + winnerIndex,
      );
      expect(stored?.checkpoint).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(stored?.revision).toBe(await workflowCheckpointRevision(expected));
    }
  }, 90_000);

  test("exactly one of N processes holds an unexpired lease on one execution, in every round", async () => {
    const path = tempPath("lease.db");
    const store = open(path);
    for (let round = 0; round < ROUNDS; round++) {
      await store.put({
        checkpoint: await buildCheckpoint(WORKFLOW, `race-${round}`, 0),
        expectedRevision: null,
      });
    }
    const perWorker = await runRace("lease", path, { ttlMs: 60_000 });
    for (let round = 0; round < ROUNDS; round++) {
      const results = perWorker.map(
        (worker) =>
          worker.find((entry) => entry.round === round) as RoundResult,
      );
      const holders = results.filter((entry) => entry.ok);
      expect(holders).toHaveLength(1);
      expect(holders[0]?.token).toBe(1);
      for (const loser of results.filter((entry) => !entry.ok)) {
        expect(loser.code).toBe("WORKFLOW_STORAGE_LEASE_HELD");
      }
    }
  }, 90_000);

  test("a fenced save from a process that no longer holds the lease writes nothing", async () => {
    const path = tempPath("fenced-process.db");
    const store = open(path);
    const locator = { workflowId: WORKFLOW, executionId: "exec-stale" };
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
    const before = await store.get(locator);
    const worker = start("fenced-save", {
      path,
      ...locator,
      step: 3,
      fencingToken: old.fencingToken,
    });
    const result = JSON.parse(
      await worker.waitForLine((line) => line.startsWith("{")),
    ) as { ok: boolean; code?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe("WORKFLOW_STORAGE_LEASE_LOST");
    const after = await store.get(locator);
    expect(after?.revision).toBe(before?.revision);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(current.fencingToken).toBe(old.fencingToken + 1);
  }, 30_000);

  test("saves of a worker that lost its lease stop landing the moment the new holder has its token", async () => {
    const path = tempPath("fenced-loop.db");
    const store = open(path);
    const locator = { workflowId: WORKFLOW, executionId: "exec-takeover" };
    const worker = start("fenced-loop", { path, ...locator, ttlMs: 100 });
    const leased = JSON.parse(
      await worker.waitForLine((line) => line.includes('"leased"')),
    ) as { leased: number };
    await worker.waitForLine((line) => line.includes('"saved":3'));
    let lease: Awaited<ReturnType<typeof store.acquireLease>> | undefined;
    const deadline = Date.now() + 10_000;
    while (lease === undefined && Date.now() < deadline) {
      try {
        lease = await store.acquireLease({
          ...locator,
          ownerId: "new-holder",
          ttlMs: 60_000,
        });
      } catch (error) {
        if (
          !isWorkflowStorageError(error) ||
          error.code !== "WORKFLOW_STORAGE_LEASE_HELD"
        ) {
          throw error;
        }
        await Bun.sleep(20);
      }
    }
    expect(lease?.fencingToken).toBe(leased.leased + 1);
    const own = await store.put({
      checkpoint: await buildCheckpoint(WORKFLOW, locator.executionId, 999_999),
      fencingToken: lease?.fencingToken as number,
    });
    expect(await worker.exited).toBe(0);
    const failed = worker.lines
      .filter((line) => line.includes('"failed"'))
      .map((line) => JSON.parse(line) as { failed: number; code?: string });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.code).toBe("WORKFLOW_STORAGE_LEASE_LOST");
    const stored = await store.get(locator);
    expect(stored?.revision).toBe(own.revision);
  }, 60_000);

  for (const killAfterCommits of [3, 25]) {
    test(`a writer killed with SIGKILL after ${killAfterCommits} saves leaves a loadable committed checkpoint, and a new process can load and save again`, async () => {
      const path = tempPath(`kill-${killAfterCommits}.db`);
      const locator = { workflowId: WORKFLOW, executionId: "exec-kill" };
      const bytes = 256 * 1024;
      const writer = start("save-loop", { path, ...locator, bytes });
      await writer.waitForLine((line) => line.includes('"ready"'));
      await writer.waitForLine((line) => {
        if (!line.includes('"committed"')) return false;
        return (
          (JSON.parse(line) as { committed: number }).committed >=
          killAfterCommits
        );
      }, 60_000);
      writer.kill("SIGKILL");
      expect(await writer.exited).toBeNull();

      const committed = writer.lines
        .filter((line) => line.includes('"committed"'))
        .map(
          (line) => JSON.parse(line) as { committed: number; revision: string },
        );
      expect(committed.length).toBeGreaterThanOrEqual(killAfterCommits);
      // The save in flight when the process died may have committed before it
      // could print, so one step past the last printed one is allowed.
      const lastPrinted = committed[committed.length - 1]?.committed as number;
      const candidates = new Map<string, number>();
      for (let step = 1; step <= lastPrinted + 1; step++) {
        const checkpoint = await buildCheckpoint(
          WORKFLOW,
          locator.executionId,
          step,
          bytes,
        );
        candidates.set(await workflowCheckpointRevision(checkpoint), step);
      }

      const raw = openSqliteDatabase({
        path,
        fail: (failure, message) => new Error(`${failure}: ${message}`),
      });
      try {
        expect(
          raw.prepare("PRAGMA integrity_check").get()?.integrity_check,
        ).toBe("ok");
      } finally {
        raw.close();
      }

      const next = start("load-then-save", { path, ...locator });
      expect(await next.exited).toBe(0);
      const loaded = JSON.parse(
        next.lines.find((line) => line.includes('"loaded"')) as string,
      ) as { loaded: string | null; checkpoint: unknown };
      expect(loaded.loaded).not.toBeNull();
      const step = candidates.get(loaded.loaded as string);
      expect(step).toBeDefined();
      const expected = await buildCheckpoint(
        WORKFLOW,
        locator.executionId,
        step as number,
        bytes,
      );
      expect(loaded.checkpoint).toEqual(JSON.parse(JSON.stringify(expected)));
      const saved = JSON.parse(
        next.lines.find((line) => line.includes('"saved"')) as string,
      ) as { saved: string; reloaded: string };
      expect(saved.reloaded).toBe(saved.saved);
      expect(saved.saved).not.toBe(loaded.loaded);
    }, 120_000);
  }

  test("a reader never sees a half-written save, and a writer killed at random moments inside a save loop leaves a loadable checkpoint", async () => {
    const rounds = 12;
    const bytes = 16;
    for (let round = 0; round < rounds; round++) {
      const path = tempPath(`torn-${round}.db`);
      const locator = { workflowId: WORKFLOW, executionId: "exec-torn" };
      const writer = start("save-loop", { path, ...locator, bytes });
      await writer.waitForLine((line) => line.includes('"ready"'));
      const readers = [0, 1].map(() =>
        start("read-loop", { path, ...locator, durationMs: 900 }),
      );
      await writer.waitForLine((line) => line.includes('"committed"'), 30_000);
      // Random delay, so over the rounds the kill lands at different points
      // of the save, including inside the commit.
      await Bun.sleep(20 + Math.floor(Math.random() * 400));
      writer.kill("SIGKILL");
      expect(await writer.exited).toBeNull();
      for (const reader of readers) {
        const done = JSON.parse(
          await reader.waitForLine((line) => line.includes('"done"'), 30_000),
        ) as { reads: number; found: number; failures: unknown[] };
        expect(done.failures).toEqual([]);
        expect(done.reads).toBeGreaterThan(0);
      }

      const lastPrinted = Math.max(
        ...writer.lines
          .filter((line) => line.includes('"committed"'))
          .map((line) => (JSON.parse(line) as { committed: number }).committed),
      );
      const revisions = new Set<string>();
      for (let step = 1; step <= lastPrinted + 1; step++) {
        revisions.add(
          await workflowCheckpointRevision(
            await buildCheckpoint(WORKFLOW, locator.executionId, step, bytes),
          ),
        );
      }
      const store = open(path);
      const loaded = await store.get(locator);
      expect(loaded).toBeDefined();
      expect(revisions.has(loaded?.revision as string)).toBe(true);
      const again = await store.put({
        checkpoint: await buildCheckpoint(
          WORKFLOW,
          locator.executionId,
          7_000_000,
          bytes,
        ),
        expectedRevision: loaded?.revision as string,
      });
      expect((await store.get(locator))?.revision).toBe(again.revision);
      await store.close();
    }
  }, 180_000);
});
