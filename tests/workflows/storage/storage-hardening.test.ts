import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowCheckpoint } from "../../../src/workflows/checkpoint/checkpoint.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { WorkflowStorageError } from "../../../src/workflows/storage/errors.js";
import {
  clipWorkflowEventRecord,
  WorkflowEventExportPipeline,
} from "../../../src/workflows/storage/event-export-pipeline.js";
import type {
  AppendWorkflowEventRecordsInput,
  WorkflowEventRecordInput,
} from "../../../src/workflows/storage/event-exporter.js";
import { FileSystemWorkflowCheckpointProvider } from "../../../src/workflows/storage/file-system-checkpoint-provider.js";
import { InMemoryWorkflowEventExporter } from "../../../src/workflows/storage/in-memory-event-exporter.js";
import { JsonlWorkflowEventExporter } from "../../../src/workflows/storage/jsonl-event-exporter.js";
import {
  getWorkflowCheckpointStoreFromUri,
  getWorkflowEventExporterFromUri,
} from "../../../src/workflows/storage/registry.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "storage-hardening-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const definition = defineWorkflow({
  id: "hardening-workflow",
  version: "1",
  handler: () => "done",
});

function checkpoint(executionId: string): Promise<WorkflowCheckpointV1> {
  return createWorkflowCheckpoint({
    definition,
    executionId,
    input: "input",
    now: 1,
  });
}

function record(id: string): WorkflowEventRecordInput {
  return {
    id,
    executionId: "exec-1",
    kind: "workflow",
    type: "custom",
    timestamp: 1,
    payload: { id },
  };
}

async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every text an error carries: message, details, cause and stack. */
function allText(error: unknown): string {
  const value = error as {
    message?: string;
    stack?: string;
    details?: unknown;
    cause?: unknown;
  };
  return [
    value?.message,
    value?.stack,
    JSON.stringify(value?.details ?? null),
    String(value?.cause ?? ""),
  ].join("\n");
}

async function storedIds(
  exporter: InMemoryWorkflowEventExporter,
): Promise<string[]> {
  const page = await exporter.read({ executionId: "exec-1" });
  return page.records
    .filter((stored) => stored.kind !== "warning")
    .map((stored) => stored.id);
}

const SECRET = "S3cr3tPw0rd";

describe("storage URIs", () => {
  test("a password holding '/', '?', '#' or '@' is not echoed in errors", async () => {
    for (const password of [
      `pa/${SECRET}`,
      `pa?${SECRET}`,
      `pa#${SECRET}`,
      `pa@${SECRET}`,
    ]) {
      const error = await caught(async () =>
        getWorkflowCheckpointStoreFromUri(
          `mongodb://admin:${password}@db.internal/x`,
        ),
      );
      expect(error).toBeInstanceOf(WorkflowStorageError);
      expect(allText(error).includes(SECRET)).toBe(false);
    }
  });

  test("secret-looking query parameters and the fragment are not echoed in errors", async () => {
    for (const key of [
      "api_key",
      "apikey",
      "access_token",
      "secret_access_key",
      "sslpassword",
      "auth_token",
    ]) {
      for (const uri of [
        `s3://bucket/prefix?${key}=${SECRET}`,
        `sqlite:///tmp/x.db?${key}=${SECRET}`,
        `s3://bucket/prefix#${SECRET}`,
      ]) {
        const error = await caught(() =>
          getWorkflowCheckpointStoreFromUri(uri),
        );
        expect(error).toBeInstanceOf(WorkflowStorageError);
        expect(allText(error).includes(SECRET)).toBe(false);
      }
    }
  });

  test("a __proto__ query parameter is rejected like any other unknown parameter", async () => {
    for (const uri of ["memory://?__proto__=x", "memory://?constructor=x"]) {
      const error = await caught(() => getWorkflowCheckpointStoreFromUri(uri));
      expect((error as WorkflowStorageError).code).toBe(
        "WORKFLOW_STORAGE_INVALID_URI",
      );
    }
  });

  test("percent-encoded dot segments and NUL bytes in paths are rejected and create nothing", async () => {
    const dir = tempDir();
    const base = join(dir, "tenants", "t1");
    mkdirSync(base, { recursive: true });
    const uris = [
      `sqlite://${base}/%2e%2e%2f%2e%2e%2fescaped.db`,
      `file://${base}/%2e%2e/%2e%2e/escaped-root`,
      `sqlite://${base}/a%00b.db`,
      `file://${base}/a%00b`,
    ];
    for (const get of [
      getWorkflowCheckpointStoreFromUri,
      getWorkflowEventExporterFromUri,
    ]) {
      for (const uri of uris) {
        const error = await caught(() => get(uri));
        expect((error as WorkflowStorageError).code).toBe(
          "WORKFLOW_STORAGE_INVALID_URI",
        );
      }
    }
    expect(readdirSync(dir)).toEqual(["tenants"]);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("event export pipeline", () => {
  test("an id offered twice before a flush costs no other record of its batch", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const warnings: string[] = [];
    const pipeline = new WorkflowEventExportPipeline({
      exporter,
      flushIntervalMs: 20,
      onWarning: (warning) => warnings.push(warning.code),
    });
    for (const id of ["a", "b", "a", "c"]) pipeline.offer(record(id));
    await pipeline.flush(3_000);
    await pipeline.close(500);
    expect(await storedIds(exporter)).toEqual(["a", "b", "c"]);
    expect(warnings).not.toContain("WORKFLOW_EVENT_EXPORT_DROPPED");
    expect(pipeline.stats.duplicates).toBe(1);
  });

  test("an append that outlives its timeout and lands late keeps the offer order and is not counted as dropped", async () => {
    class LateLanding extends InMemoryWorkflowEventExporter {
      calls = 0;
      override async append(input: AppendWorkflowEventRecordsInput) {
        this.calls += 1;
        if (this.calls === 1) await Bun.sleep(400);
        return super.append(input);
      }
    }
    const exporter = new LateLanding();
    const pipeline = new WorkflowEventExportPipeline({
      exporter,
      flushIntervalMs: 5,
      appendTimeoutMs: 60,
      retry: { maxAttempts: 1 },
      onWarning: () => undefined,
    });
    pipeline.offer(record("a1"));
    pipeline.offer(record("a2"));
    await Bun.sleep(150);
    pipeline.offer(record("b1"));
    pipeline.offer(record("b2"));
    await pipeline.flush(2_000);
    await pipeline.close(1_000);
    expect(await storedIds(exporter)).toEqual(["a1", "a2", "b1", "b2"]);
    expect(pipeline.stats.dropped).toBe(0);
    expect(pipeline.stats.exported).toBe(4);
  });

  test("clipping a 10 MB payload made of 600 long strings costs well under a second of CPU", () => {
    const big = {
      ...record("many-long"),
      payload: {
        items: Array.from(
          { length: 600 },
          (_, i) => `${i}:${"x".repeat(17 * 1024)}`,
        ),
      },
    };
    // CPU time of this process, not wall time: clipping is pure computation
    // (about 0.2 s here), and a wall clock also counts the time a busy host
    // keeps the process descheduled. A quadratic clip still costs far more.
    const before = process.cpuUsage();
    const { record: clipped } = clipWorkflowEventRecord(big, {
      maxRecordBytes: 256 * 1024,
    });
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(1_000);
    expect(Buffer.byteLength(JSON.stringify(clipped))).toBeLessThanOrEqual(
      256 * 1024,
    );
  });
});

describe("SQLite checkpoint store under a held lock", () => {
  test("a save honours operationTimeoutMs without freezing the event loop", async () => {
    const path = join(tempDir(), "c.db");
    const store = await getWorkflowCheckpointStoreFromUri(
      `sqlite://${path}?operationTimeoutMs=300`,
    );
    const first = await store.put({
      checkpoint: await checkpoint("e1"),
      expectedRevision: null,
    });
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = performance.now();
    const error = await caught(async () =>
      store.put({
        checkpoint: { ...(await checkpoint("e1")), updatedAt: 2 },
        expectedRevision: first.revision,
      }),
    );
    const elapsed = performance.now() - started;
    clearInterval(timer);
    holder.exec("ROLLBACK");
    holder.close();
    await store.close();
    expect(elapsed).toBeLessThan(2_500);
    expect([
      "WORKFLOW_STORAGE_TIMEOUT",
      "WORKFLOW_STORAGE_UNAVAILABLE",
    ]).toContain((error as WorkflowStorageError).code);
    expect(ticks).toBeGreaterThan(3);
  }, 20_000);
});

describe("JSONL writer lock", () => {
  test("a day-old lock whose pid belongs to an unrelated live process is taken over", async () => {
    const dir = join(tempDir(), "events");
    mkdirSync(dir, { mode: 0o700 });
    const lock = join(dir, ".writer.lock");
    // This test process is alive and is not the writer that left the lock.
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.ppid, token: "0123456789abcdef" }),
      { mode: 0o600 },
    );
    const dayAgo = new Date(Date.now() - 86_400_000);
    utimesSync(lock, dayAgo, dayAgo);
    const exporter = new JsonlWorkflowEventExporter({ directory: dir });
    const result = await exporter.append({
      executionId: "e1",
      records: [{ ...record("r1"), executionId: "e1" }],
    });
    expect(result.lastSequence).toBe(1);
    await exporter.close();
  });

  test("exporters racing to take over a stale lock: exactly one becomes the writer", async () => {
    for (let round = 0; round < 5; round += 1) {
      const dir = join(tempDir(), "events");
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(
        join(dir, ".writer.lock"),
        JSON.stringify({ pid: 2 ** 22 + 7, token: "deadbeefdeadbeef" }),
        { mode: 0o600 },
      );
      const exporters = Array.from(
        { length: 8 },
        () => new JsonlWorkflowEventExporter({ directory: dir }),
      );
      const outcomes = await Promise.allSettled(
        exporters.map((exporter, index) =>
          exporter.append({
            executionId: "e1",
            records: [{ ...record(`w${index}`), executionId: "e1" }],
          }),
        ),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          expect((outcome.reason as WorkflowStorageError).code).toBe(
            "WORKFLOW_STORAGE_UNAVAILABLE",
          );
        }
      }
      await Promise.all(exporters.map((exporter) => exporter.close()));
      expect(existsSync(join(dir, ".writer.lock.takeover"))).toBe(false);
    }
  });

  // Skipped on Windows: POSIX modes.
  test.skipIf(process.platform === "win32")(
    "a world-writable event directory is made owner-only before events are written",
    async () => {
      const dir = join(tempDir(), "events");
      mkdirSync(dir);
      chmodSync(dir, 0o777);
      const exporter = new JsonlWorkflowEventExporter({ directory: dir });
      await exporter.append({
        executionId: "e1",
        records: [{ ...record("r1"), executionId: "e1" }],
      });
      await exporter.close();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );
});

describe("file-system checkpoint provider", () => {
  test("a root that is a symbolic link is refused and nothing is written through it", async () => {
    const dir = tempDir();
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(elsewhere);
    const root = join(dir, "root");
    symlinkSync(elsewhere, root);
    const store = new FileSystemWorkflowCheckpointProvider({ root });
    const error = await caught(async () =>
      store.put({
        checkpoint: await checkpoint("e1"),
        expectedRevision: null,
      }),
    );
    expect((error as WorkflowStorageError).code).toBe(
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(readdirSync(elsewhere)).toEqual([]);
    await store.close();
  });
});
