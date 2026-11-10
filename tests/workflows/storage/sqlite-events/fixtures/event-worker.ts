/**
 * Worker process of the SQLite event exporter tests.
 *
 * Run as `bun event-worker.ts <mode> '<json arguments>'`. Each mode opens its
 * own `SqliteWorkflowEventExporter` on the given database file, so the tests
 * exercise real processes, real file locks and a real `SIGKILL`. A mode
 * reports through stdout, one JSON object per line.
 *
 * Modes: `append` (a fixed number of batches, then a report), `append-forever`
 * (batches until it is killed, one line per committed batch), `open`,
 * `hold-lock`, `pragmas` and `generate-v1`.
 *
 * `generate-v1` writes `events-v1.db`, a database made by the first release
 * of the exporter (schema version 1):
 *
 *     bun tests/workflows/storage/sqlite-events/fixtures/event-worker.ts generate-v1 '{"output":"<path>"}'
 *
 * Without `output` it replaces `events-v1.db` next to this script. Run it
 * once, while the exporter is still at schema version 1. Do not run it after
 * the schema moves past version 1: the committed file must stay a version 1
 * database so the migration path keeps being tested.
 *
 * The module also exports the helpers the tests share: the record builder
 * and `spawnWorker`.
 */

import { rmSync } from "node:fs";
import { openSqliteDatabase } from "../../../../../src/utils/sqlite-database.js";
import { SqliteWorkflowEventExporter } from "../../../../../src/workflows/events/sqlite/index.js";
import type {
  WorkflowEventRecordInput,
  WorkflowEventRecordKind,
} from "../../../../../src/workflows/storage/event-exporter.js";

const WORKER_PATH = new URL(import.meta.url).pathname;

/** Options of {@link buildRecord}. */
export interface BuildRecordOptions {
  kind?: WorkflowEventRecordKind;
  type?: string;
  timestamp?: number;
  /** Characters of padding in the payload. */
  padding?: number;
  payload?: Record<string, string | number | boolean | null>;
}

/** Builds one record of an execution with a stable id. */
export function buildRecord(
  executionId: string,
  id: string,
  options: BuildRecordOptions = {},
): WorkflowEventRecordInput {
  return {
    id,
    executionId,
    kind: options.kind ?? "step",
    type: options.type ?? "step_completed",
    timestamp: options.timestamp ?? 1_000,
    workflowId: "worker-flow",
    payload: {
      ...(options.payload ?? {}),
      ...(options.padding ? { padding: "x".repeat(options.padding) } : {}),
    },
  };
}

/** A running worker process. */
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

/** Starts this file as a worker process in the given mode. */
export function spawnWorker(
  mode: string,
  args: Record<string, unknown>,
): SpawnedWorker {
  const child = Bun.spawn(
    [process.execPath, WORKER_PATH, mode, JSON.stringify(args)],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  let errorText = "";
  const wakeAll = (): void => {
    for (const wake of waiters.splice(0)) wake();
  };
  const pumping = (async () => {
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
      wakeAll();
    }
    if (pending) lines.push(pending);
    wakeAll();
  })().catch(() => undefined);
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
    wakeAll();
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
    message?: string;
  };
  return {
    name: e?.name,
    code: e?.code,
    retryable: e?.retryable,
    message: String(e?.message ?? error).slice(0, 300),
  };
}

function waitUntil(epochMs: number): void {
  for (;;) {
    const remaining = epochMs - Date.now();
    if (remaining <= 0) return;
    if (remaining > 20) Bun.sleepSync(remaining - 10);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: the arguments differ per mode and the tests build them.
type Args = Record<string, any>;

function openExporter(args: Args): SqliteWorkflowEventExporter {
  return new SqliteWorkflowEventExporter({
    path: args.path,
    busyTimeoutMs: args.busyTimeoutMs ?? 20_000,
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const args = JSON.parse(process.argv[3] ?? "{}") as Args;
  switch (mode) {
    case "append": {
      // Appends `batches` batches of `batchSize` new records to one execution
      // and reports the sequence of every record it stored.
      const exporter = openExporter(args);
      const sequences: number[] = [];
      waitUntil(args.startAt ?? 0);
      try {
        for (let batch = 0; batch < args.batches; batch++) {
          const records = Array.from({ length: args.batchSize }, (_, i) =>
            buildRecord(
              args.executionId,
              `${args.idPrefix ?? `w${args.index}`}-b${batch}-r${i}`,
              { timestamp: 1_000 + batch, padding: args.padding ?? 0 },
            ),
          );
          const result = await exporter.append({
            executionId: args.executionId,
            records,
          });
          for (const stored of result.records) sequences.push(stored.sequence);
        }
        emit({ done: true, index: args.index, sequences });
      } catch (error) {
        emit({ done: false, index: args.index, ...describeError(error) });
      }
      await exporter.close();
      return;
    }
    case "append-forever": {
      // Appends batches of `batchSize` records until it is killed. A batch is
      // reported only after its append resolved, so every reported batch must
      // be stored whole; a batch in flight at the kill must be stored whole
      // or not at all.
      const exporter = openExporter(args);
      emit({ started: true });
      for (let batch = 0; ; batch++) {
        const records = Array.from({ length: args.batchSize }, (_, i) =>
          buildRecord(
            args.executionId,
            `${args.idPrefix ?? "k"}-b${batch}-r${i}`,
            { padding: args.padding ?? 0 },
          ),
        );
        await exporter.append({ executionId: args.executionId, records });
        emit({ committed: batch });
      }
    }
    case "open": {
      // Opens an exporter on a path that may be unsafe. Run in its own
      // process so an exporter that blocks on the path cannot stall the
      // test runner.
      try {
        const exporter = new SqliteWorkflowEventExporter({ path: args.path });
        emit({ opened: true });
        await exporter.close();
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
      // Reports the settings of the connection the exporter opens, by
      // wrapping the shared helper in this process only.
      const { mock } = await import("bun:test");
      const real = {
        ...(await import("../../../../../src/utils/sqlite-database.js")),
      };
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
      const moduleUrl = new URL(
        "../../../../../src/workflows/events/sqlite/index.js?pragmas",
        import.meta.url,
      ).href;
      const mod = (await import(
        moduleUrl
      )) as typeof import("../../../../../src/workflows/events/sqlite/index.js");
      const exporter = new mod.SqliteWorkflowEventExporter({
        path: args.path,
        ...(args.busyTimeoutMs === undefined
          ? {}
          : { busyTimeoutMs: args.busyTimeoutMs }),
        ...(args.synchronous === undefined
          ? {}
          : { synchronous: args.synchronous }),
      });
      await exporter.append({
        executionId: "pragma-exec",
        records: [buildRecord("pragma-exec", "pragma-record")],
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
      await exporter.close();
      return;
    }
    case "generate-v1": {
      const output =
        args.output ?? new URL("events-v1.db", import.meta.url).pathname;
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(output + suffix, { force: true });
      }
      const exporter = new SqliteWorkflowEventExporter({ path: output });
      try {
        await exporter.append({
          executionId: "exec-1",
          records: [
            buildRecord("exec-1", "e1-start", {
              kind: "workflow",
              type: "workflow_started",
              timestamp: 1_000,
              payload: { note: "first" },
            }),
            buildRecord("exec-1", "e1-step", {
              kind: "step",
              type: "step_completed",
              timestamp: 1_100,
              payload: { step: "a" },
            }),
            buildRecord("exec-1", "e1-span", {
              kind: "span",
              type: "span_ended",
              timestamp: 1_200,
            }),
            buildRecord("exec-1", "e1-end", {
              kind: "workflow",
              type: "workflow_completed",
              timestamp: 1_300,
            }),
          ],
        });
        await exporter.append({
          executionId: "exec-2",
          records: [
            buildRecord("exec-2", "e2-start", {
              kind: "workflow",
              type: "workflow_started",
              timestamp: 5_000,
            }),
          ],
        });
      } finally {
        await exporter.close();
      }
      emit({ wrote: output });
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
