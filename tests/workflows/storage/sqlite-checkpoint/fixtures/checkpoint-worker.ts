/**
 * Worker process of the SQLite checkpoint provider tests.
 *
 * Run as `bun checkpoint-worker.ts <mode> '<json arguments>'`. Each mode opens
 * its own `SqliteWorkflowCheckpointStore` on the given database file, so the
 * tests exercise real processes, real file locks and a real `SIGKILL`. A mode
 * reports through stdout, one JSON object per line.
 *
 * The module also exports the helpers the tests share: the checkpoint builder
 * and `spawnWorker`.
 */

import { openSqliteDatabase } from "../../../../../src/utils/sqlite-database.js";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../../../src/workflows/checkpoint/schema.js";
import { SqliteWorkflowCheckpointStore } from "../../../../../src/workflows/checkpoint/sqlite/index.js";
import { workflowCheckpointRevision } from "../../../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../../../src/workflows/definition.js";

const WORKER_PATH = new URL(import.meta.url).pathname;

const definitions = new Map<string, ReturnType<typeof defineWorkflow>>();

/**
 * Builds the checkpoint of a numbered step of an execution. Step `0` is the
 * running checkpoint a test seeds; later steps are completed checkpoints that
 * carry `bytes` of padding, so every step has its own revision and size.
 */
export async function buildCheckpoint(
  workflowId: string,
  executionId: string,
  step: number,
  bytes = 16,
): Promise<WorkflowCheckpointV1> {
  let definition = definitions.get(workflowId);
  if (!definition) {
    definition = defineWorkflow({
      id: workflowId,
      version: "1",
      handler: () => "done",
    });
    definitions.set(workflowId, definition);
  }
  const base = await createWorkflowCheckpoint({
    definition,
    executionId,
    input: "input",
    now: 1,
  });
  if (step === 0) return base;
  return withWorkflowCompleted(
    base,
    `step-${step}-${"x".repeat(bytes)}`,
    step + 1,
  );
}

/** A worker the test started. */
export interface SpawnedWorker {
  readonly pid: number;
  /** Every stdout line received so far. */
  readonly lines: string[];
  /** Resolves with the first line that satisfies `match`, or rejects on timeout. */
  waitForLine(
    match: (line: string) => boolean,
    timeoutMs?: number,
  ): Promise<string>;
  /** Sends a signal. */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves with the exit code (`null` after a signal) once the process ends. */
  exited: Promise<number | null>;
  /** Everything the worker wrote to stderr. */
  stderr(): string;
}

/** Starts a worker process and collects its output. */
export function spawnWorker(
  mode: string,
  args: Record<string, unknown>,
): SpawnedWorker {
  const child = Bun.spawn(
    [process.execPath, WORKER_PATH, mode, JSON.stringify(args)],
    {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let errorText = "";
  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        lines.push(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      for (const wake of waiters.splice(0)) wake();
    }
    if (pending) lines.push(pending);
    for (const wake of waiters.splice(0)) wake();
  };
  const pumping = pump().catch(() => undefined);
  const pumpingErrors = (async () => {
    try {
      for await (const chunk of child.stderr)
        errorText += new TextDecoder().decode(chunk);
    } catch {
      // The pipe closed with the process.
    }
  })();
  let finished = false;
  const exited = child.exited.then(async (code) => {
    await pumping;
    await pumpingErrors;
    finished = true;
    for (const wake of waiters.splice(0)) wake();
    return child.signalCode ? null : code;
  });
  return {
    pid: child.pid,
    lines,
    kill: (signal = "SIGKILL") => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    },
    exited,
    stderr: () => errorText,
    async waitForLine(match, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      let seen = 0;
      for (;;) {
        for (; seen < lines.length; seen++) {
          const line = lines[seen] as string;
          if (match(line)) return line;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || (finished && seen >= lines.length)) {
          throw new Error(
            `worker ${mode} printed no matching line in ${timeoutMs} ms; stderr: ${errorText.slice(0, 500)}; stdout: ${lines.join(" | ").slice(0, 500)}`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(remaining, 50));
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

function emit(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function describeError(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: string;
    code?: string;
    retryable?: boolean;
    conflict?: { reason?: string };
    message?: string;
  };
  return {
    name: e?.name,
    code: e?.code,
    retryable: e?.retryable,
    reason: e?.conflict?.reason,
    message: String(e?.message ?? error).slice(0, 300),
  };
}

/** Blocks the thread until `epochMs`, spinning for the last milliseconds. */
function waitUntil(epochMs: number): void {
  for (;;) {
    const remaining = epochMs - Date.now();
    if (remaining <= 0) return;
    if (remaining > 20) Bun.sleepSync(remaining - 10);
  }
}

interface CommonArgs {
  path: string;
  workflowId: string;
  executionPrefix?: string;
  executionId?: string;
  busyTimeoutMs?: number;
}

function openStore(args: CommonArgs): SqliteWorkflowCheckpointStore {
  return new SqliteWorkflowCheckpointStore({
    path: args.path,
    busyTimeoutMs: args.busyTimeoutMs ?? 20_000,
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  // biome-ignore lint/suspicious/noExplicitAny: the arguments differ per mode and the tests build them.
  const args = JSON.parse(process.argv[3] ?? "{}") as Record<string, any>;
  switch (mode) {
    case "cas": {
      // Every worker tries to replace the seeded checkpoint of each round's
      // execution with its own, expecting the seeded revision.
      const store = openStore(args as CommonArgs);
      const results: Array<Record<string, unknown>> = [];
      for (let round = 0; round < args.rounds; round++) {
        const executionId = `${args.executionPrefix}-${round}`;
        const expectedRevision = await workflowCheckpointRevision(
          await buildCheckpoint(args.workflowId, executionId, 0),
        );
        const mine = await buildCheckpoint(
          args.workflowId,
          executionId,
          1000 + args.index,
        );
        waitUntil(args.startAt + round * args.gapMs);
        try {
          const put = await store.put({ checkpoint: mine, expectedRevision });
          results.push({ round, ok: true, revision: put.revision });
        } catch (error) {
          results.push({ round, ok: false, ...describeError(error) });
        }
      }
      emit({ done: true, index: args.index, results });
      await store.close();
      return;
    }
    case "lease": {
      const store = openStore(args as CommonArgs);
      const results: Array<Record<string, unknown>> = [];
      for (let round = 0; round < args.rounds; round++) {
        const executionId = `${args.executionPrefix}-${round}`;
        waitUntil(args.startAt + round * args.gapMs);
        try {
          const lease = await store.acquireLease({
            workflowId: args.workflowId,
            executionId,
            ownerId: `worker-${args.index}`,
            ttlMs: args.ttlMs,
          });
          results.push({
            round,
            ok: true,
            token: lease.fencingToken,
            expiresAt: lease.expiresAt,
          });
        } catch (error) {
          results.push({ round, ok: false, ...describeError(error) });
        }
      }
      emit({ done: true, index: args.index, results });
      await store.close();
      return;
    }
    case "fenced-loop": {
      // Takes the lease, then saves under its token until the store refuses.
      const store = openStore(args as CommonArgs);
      const lease = await store.acquireLease({
        workflowId: args.workflowId,
        executionId: args.executionId,
        ownerId: "old-holder",
        ttlMs: args.ttlMs,
      });
      emit({ leased: lease.fencingToken });
      const deadline = Date.now() + 30_000;
      for (let step = 1; Date.now() < deadline; step++) {
        const checkpoint = await buildCheckpoint(
          args.workflowId,
          args.executionId,
          step,
          64,
        );
        try {
          const put = await store.put({
            checkpoint,
            fencingToken: lease.fencingToken,
          });
          emit({ saved: step, revision: put.revision });
        } catch (error) {
          emit({ failed: step, ...describeError(error) });
          break;
        }
        Bun.sleepSync(2);
      }
      await store.close();
      return;
    }
    case "fenced-save": {
      // One save under a stale token, from a process that is not the holder.
      const store = openStore(args as CommonArgs);
      try {
        const checkpoint = await buildCheckpoint(
          args.workflowId,
          args.executionId,
          args.step,
          16,
        );
        const put = await store.put({
          checkpoint,
          fencingToken: args.fencingToken,
        });
        emit({ ok: true, revision: put.revision });
      } catch (error) {
        emit({ ok: false, ...describeError(error) });
      }
      await store.close();
      return;
    }
    case "save-loop": {
      // Saves numbered steps for as long as it lives; the test kills it.
      const store = openStore(args as CommonArgs);
      emit({ ready: true });
      for (let step = 1; step < 1_000_000; step++) {
        const checkpoint = await buildCheckpoint(
          args.workflowId,
          args.executionId,
          step,
          args.bytes,
        );
        const put = await store.put({ checkpoint });
        emit({ committed: step, revision: put.revision });
      }
      return;
    }
    case "read-loop": {
      // Reads one execution as fast as it can for `durationMs` and reports
      // every failure, so a test can tell whether a save was ever visible
      // half done.
      const store = openStore(args as CommonArgs);
      emit({ ready: true });
      const until = Date.now() + args.durationMs;
      let reads = 0;
      let found = 0;
      const failures: Array<Record<string, unknown>> = [];
      while (Date.now() < until) {
        try {
          const stored = await store.get({
            workflowId: args.workflowId,
            executionId: args.executionId,
          });
          reads++;
          if (stored) found++;
        } catch (error) {
          failures.push(describeError(error));
        }
      }
      emit({ done: true, reads, found, failures: failures.slice(0, 5) });
      await store.close();
      return;
    }
    case "load-then-save": {
      // A new process after a crash: load, then advance from what it found.
      const store = openStore(args as CommonArgs);
      const loaded = await store.get({
        workflowId: args.workflowId,
        executionId: args.executionId,
      });
      emit({
        loaded: loaded?.revision ?? null,
        checkpoint: loaded?.checkpoint ?? null,
      });
      if (loaded) {
        const next = await buildCheckpoint(
          args.workflowId,
          args.executionId,
          5_000_000,
          16,
        );
        try {
          const put = await store.put({
            checkpoint: next,
            expectedRevision: loaded.revision,
          });
          const again = await store.get({
            workflowId: args.workflowId,
            executionId: args.executionId,
          });
          emit({ saved: put.revision, reloaded: again?.revision ?? null });
        } catch (error) {
          emit({ saveFailed: true, ...describeError(error) });
        }
      }
      await store.close();
      return;
    }
    case "open": {
      // Opens a store on a path that may be unsafe. Run in its own process so
      // a provider that blocks on the path cannot stall the test runner.
      try {
        const store = new SqliteWorkflowCheckpointStore({ path: args.path });
        emit({ opened: true });
        await store.close();
      } catch (error) {
        emit({ opened: false, ...describeError(error) });
      }
      return;
    }
    case "hold-lock": {
      // Holds the write lock of the database file for `holdMs`.
      const db = openSqliteDatabase({
        path: args.path,
        fail: (failure, message) => new Error(`${failure}: ${message}`),
      });
      db.exec("BEGIN IMMEDIATE");
      emit({ locked: true });
      Bun.sleepSync(args.holdMs);
      db.exec("ROLLBACK");
      db.close();
      emit({ released: true });
      return;
    }
    case "pragmas": {
      // Reports the settings of the connection the store opens, by wrapping
      // the shared helper in this process only.
      const { mock } = await import("bun:test");
      const real = {
        ...(await import("../../../../../src/utils/sqlite-database.js")),
      };
      // Copied before the mock exists, so the wrapper calls the real helper.
      const realOpen = real.openSqliteDatabase;
      const opened: Array<{
        options: Record<string, unknown>;
        handle: ReturnType<typeof real.openSqliteDatabase>;
      }> = [];
      mock.module("../../../../../src/utils/sqlite-database.js", () => ({
        ...real,
        openSqliteDatabase: (
          options: Parameters<typeof real.openSqliteDatabase>[0],
        ) => {
          const handle = realOpen(options);
          opened.push({
            options: options as unknown as Record<string, unknown>,
            handle,
          });
          return handle;
        },
      }));
      const freshStoreModule = new URL(
        "../../../../../src/workflows/checkpoint/sqlite/index.js?pragmas",
        import.meta.url,
      ).href;
      const mod = (await import(
        freshStoreModule
      )) as typeof import("../../../../../src/workflows/checkpoint/sqlite/index.js");
      const store = new mod.SqliteWorkflowCheckpointStore({
        path: args.path,
        ...(args.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: args.busyTimeoutMs }),
        ...(args.synchronous === undefined
          ? {}
          : { synchronous: args.synchronous }),
      });
      await store.put({
        checkpoint: await buildCheckpoint("pragma-flow", "pragma-exec", 0),
      });
      const first = opened[0];
      const read = (pragma: string): unknown => {
        const row = first?.handle.prepare(`PRAGMA ${pragma}`).get();
        return row ? Object.values(row)[0] : undefined;
      };
      emit({
        openCalls: opened.length,
        symlinks: first?.options.symlinks ?? "reject",
        journalMode: read("journal_mode"),
        busyTimeout: read("busy_timeout"),
        synchronous: read("synchronous"),
      });
      await store.close();
      return;
    }
    default:
      console.error(`unknown mode ${String(mode)}`);
      process.exit(2);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
}
