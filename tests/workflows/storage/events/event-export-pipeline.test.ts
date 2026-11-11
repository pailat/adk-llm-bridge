import { afterEach, describe, expect, test } from "bun:test";
import {
  createEvent,
  InMemoryArtifactService,
  type LogLevel,
  resetLogger,
  setLogger,
} from "@google/adk";
import {
  isWorkflowStorageError,
  WorkflowStorageError,
} from "../../../../src/workflows/storage/errors.js";
import {
  createArtifactOverflowHandler,
  WorkflowEventExportPipeline,
  type WorkflowEventExportPipelineOptions,
  type WorkflowEventExportWarning,
} from "../../../../src/workflows/storage/event-export-pipeline.js";
import {
  type AppendWorkflowEventRecordsInput,
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type ReadWorkflowEventRecordsResult,
  type WorkflowEventRecord,
  type WorkflowEventRecordInput,
} from "../../../../src/workflows/storage/event-exporter.js";

type Behavior = "ok" | "hang" | "store-then-fail" | Error;

/**
 * Exporter with its own dense, idempotent storage and scripted failures. It
 * overrides `append` so these tests do not depend on the base class.
 */
class FaultyExporter extends BaseWorkflowEventExporter {
  readonly providerName = "faulty";
  readonly capabilities = {
    durable: false,
    multiProcess: false,
    listing: false,
    pruning: false,
    maxRecordBytes: 256 * 1024,
  };
  readonly stored = new Map<string, WorkflowEventRecord[]>();
  readonly calls: Array<{ executionId: string; ids: string[]; at: number }> =
    [];
  /** Behavior per call number (1-based); `defaultBehavior` after the script. */
  script: Behavior[] = [];
  defaultBehavior: Behavior = "ok";
  delayMs = 0;
  inFlight = new Map<string, number>();
  maxInFlight = new Map<string, number>();
  closed = false;
  /** Fails only while it returns true. */
  failWhile?: () => boolean;

  constructor(maxRecordBytes?: number) {
    super();
    if (maxRecordBytes !== undefined) {
      this.capabilities = { ...this.capabilities, maxRecordBytes };
    }
  }

  override async append(
    input: AppendWorkflowEventRecordsInput,
  ): Promise<AppendWorkflowEventRecordsResult> {
    const call = this.calls.length + 1;
    this.calls.push({
      executionId: input.executionId,
      ids: input.records.map((r) => r.id),
      at: Date.now(),
    });
    const now = (this.inFlight.get(input.executionId) ?? 0) + 1;
    this.inFlight.set(input.executionId, now);
    this.maxInFlight.set(
      input.executionId,
      Math.max(this.maxInFlight.get(input.executionId) ?? 0, now),
    );
    try {
      const behavior =
        this.failWhile?.() === true
          ? new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down")
          : (this.script[call - 1] ?? this.defaultBehavior);
      if (this.delayMs > 0)
        await new Promise((r) => setTimeout(r, this.delayMs));
      if (behavior === "hang") return await new Promise<never>(() => {});
      if (behavior instanceof Error) throw behavior;
      const result = this.store(input);
      if (behavior === "store-then-fail") {
        throw new WorkflowStorageError("WORKFLOW_STORAGE_TIMEOUT", "late");
      }
      return result;
    } finally {
      this.inFlight.set(
        input.executionId,
        (this.inFlight.get(input.executionId) ?? 1) - 1,
      );
    }
  }

  private store(
    input: AppendWorkflowEventRecordsInput,
  ): AppendWorkflowEventRecordsResult {
    const list = this.stored.get(input.executionId) ?? [];
    this.stored.set(input.executionId, list);
    const records = input.records.map((record) => {
      const existing = list.find((r) => r.id === record.id);
      if (existing)
        return { id: record.id, sequence: existing.sequence, duplicate: true };
      const sequence = list.length + 1;
      list.push({ ...record, sequence });
      return { id: record.id, sequence, duplicate: false };
    });
    return { records, lastSequence: list.length };
  }

  protected async appendRecords(): Promise<AppendWorkflowEventRecordsResult> {
    throw new Error("unused");
  }
  protected async readRecords(): Promise<ReadWorkflowEventRecordsResult> {
    throw new Error("unused");
  }
  override async close(): Promise<void> {
    this.closed = true;
  }

  ids(executionId = "exec-1"): string[] {
    return (this.stored.get(executionId) ?? []).map((r) => r.id);
  }
}

function record(
  id: string,
  overrides: Partial<WorkflowEventRecordInput> = {},
): WorkflowEventRecordInput {
  return {
    id,
    executionId: "exec-1",
    kind: "workflow",
    type: "custom",
    timestamp: 1,
    payload: { id },
    ...overrides,
  };
}

const FAST: Partial<WorkflowEventExportPipelineOptions> = {
  flushIntervalMs: 2,
  appendTimeoutMs: 40,
  retry: { maxAttempts: 3, initialDelayMs: 3, maxDelayMs: 10, jitter: 0 },
};

const pipelines: WorkflowEventExportPipeline[] = [];

function makePipeline(
  exporter: FaultyExporter,
  options: Partial<WorkflowEventExportPipelineOptions> = {},
) {
  const warnings: WorkflowEventExportWarning[] = [];
  const pipeline = new WorkflowEventExportPipeline({
    exporter,
    ...FAST,
    onWarning: (w) => warnings.push(w),
    ...options,
  });
  pipelines.push(pipeline);
  return { pipeline, warnings };
}

afterEach(async () => {
  resetLogger();
  for (const pipeline of pipelines.splice(0)) {
    await pipeline.close(20).catch(() => {});
  }
});

function codes(warnings: WorkflowEventExportWarning[]): string[] {
  return warnings.map((w) => w.code);
}

describe("WorkflowEventExportPipeline: offer", () => {
  test("offer is synchronous, returns true, and never calls the exporter before it returns", () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    const queued = pipeline.offer(record("a"));
    expect(queued).toBe(true);
    expect(exporter.calls).toHaveLength(0);
    expect(pipeline.stats.offered).toBe(1);
    expect(pipeline.stats.buffered).toBe(1);
  });

  test("offer returns at once when the exporter never resolves", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline } = makePipeline(exporter, { appendTimeoutMs: 5_000 });
    const started = Date.now();
    for (let i = 0; i < 50; i += 1) pipeline.offer(record(`r${i}`));
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("offer never throws: a record that is not JSON-safe is dropped and reported", () => {
    const exporter = new FaultyExporter();
    const { pipeline, warnings } = makePipeline(exporter);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const payload of [circular, { f: () => 1 }, { n: 10n }]) {
      expect(() =>
        pipeline.offer(record("bad", { payload: payload as never })),
      ).not.toThrow();
    }
    expect(pipeline.stats.dropped).toBe(3);
    expect(warnings.some((w) => w.reason === "invalid_record")).toBe(true);
    expect(
      warnings.every((w) => w.code === "WORKFLOW_EVENT_EXPORT_DROPPED"),
    ).toBe(true);
  });

  test("offer never throws when onWarning throws or the exporter throws synchronously", async () => {
    const exporter = new FaultyExporter();
    exporter.append = (() => {
      throw new Error("sync failure");
    }) as never;
    const { pipeline } = makePipeline(exporter, {
      retry: { maxAttempts: 1 },
      onWarning: () => {
        throw new Error("callback");
      },
    });
    expect(() => pipeline.offer(record("a"))).not.toThrow();
    await pipeline.flush(500);
    expect(pipeline.stats.dropped).toBe(1);
    expect(pipeline.stats.buffered).toBe(0);
  });

  test("a flush or close limit above the timer range waits for the export instead of returning at once", async () => {
    for (const method of ["flush", "close"] as const) {
      const exporter = new FaultyExporter();
      exporter.delayMs = 25;
      const { pipeline } = makePipeline(exporter);
      for (let i = 0; i < 5; i += 1) pipeline.offer(record(`r${i}`));
      const started = Date.now();
      await pipeline[method](2 ** 31);
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
      expect(exporter.ids()).toHaveLength(5);
      expect(pipeline.stats.buffered).toBe(0);
      expect(pipeline.stats.dropped).toBe(0);
    }
  });

  test("records of one execution are stored in offer order, in batches of at most maxBatchRecords", async () => {
    const exporter = new FaultyExporter();
    exporter.delayMs = 3;
    const { pipeline } = makePipeline(exporter, { maxBatchRecords: 3 });
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    for (const id of ids) pipeline.offer(record(id));
    expect(await pipeline.flush(2_000)).toBe(0);
    expect(exporter.ids()).toEqual(ids);
    expect(exporter.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of exporter.calls)
      expect(call.ids.length).toBeLessThanOrEqual(3);
    expect(pipeline.stats.exported).toBe(10);
    expect(pipeline.stats.offered).toBe(10);
  });

  test("at most one batch per execution is in flight, in offer order", async () => {
    const exporter = new FaultyExporter();
    exporter.delayMs = 5;
    const { pipeline } = makePipeline(exporter, {
      maxBatchRecords: 1,
      flushIntervalMs: 1,
    });
    for (let i = 0; i < 8; i += 1) {
      pipeline.offer(record(`a${i}`));
      pipeline.offer(record(`b${i}`, { executionId: "exec-2" }));
    }
    await pipeline.flush(3_000);
    expect(exporter.maxInFlight.get("exec-1")).toBe(1);
    expect(exporter.maxInFlight.get("exec-2")).toBe(1);
    expect(exporter.ids("exec-1")).toEqual(
      Array.from({ length: 8 }, (_, i) => `a${i}`),
    );
    expect(exporter.ids("exec-2")).toEqual(
      Array.from({ length: 8 }, (_, i) => `b${i}`),
    );
  });

  test("a batch only contains records of one execution", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    pipeline.offer(record("b", { executionId: "exec-2" }));
    pipeline.offer(record("c"));
    await pipeline.flush(1_000);
    for (const call of exporter.calls) {
      const owners = new Set(
        call.ids.map((id) => (id === "b" ? "exec-2" : "exec-1")),
      );
      expect(owners.size).toBe(1);
    }
    expect(exporter.ids("exec-1")).toEqual(["a", "c"]);
  });
});

describe("WorkflowEventExportPipeline: retry and failure policy", () => {
  test("a failing append is retried with backoff and the record is stored once", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down"),
      new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down"),
      "ok",
    ];
    const { pipeline, warnings } = makePipeline(exporter, {
      retry: { maxAttempts: 5, initialDelayMs: 20, maxDelayMs: 40, jitter: 0 },
    });
    pipeline.offer(record("a"));
    expect(await pipeline.flush(3_000)).toBe(0);
    expect(exporter.calls).toHaveLength(3);
    expect(exporter.ids()).toEqual(["a"]);
    expect(pipeline.stats.retries).toBe(2);
    expect(pipeline.stats.exported).toBe(1);
    expect(pipeline.stats.dropped).toBe(0);
    // Backoff: the gaps grow and respect the initial delay.
    const gaps = exporter.calls
      .slice(1)
      .map((c, i) => c.at - (exporter.calls[i]?.at ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0] ? gaps[0] : 0);
    expect(codes(warnings)).toEqual([
      "WORKFLOW_EVENT_EXPORT_DEGRADED",
      "WORKFLOW_EVENT_EXPORT_RECOVERED",
    ]);
  });

  test("DEGRADED is raised once at the first failure, not once per retry", async () => {
    const exporter = new FaultyExporter();
    exporter.script = Array.from(
      { length: 2 },
      () => new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down"),
    );
    const { pipeline, warnings } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await pipeline.flush(2_000);
    expect(
      codes(warnings).filter((c) => c === "WORKFLOW_EVENT_EXPORT_DEGRADED"),
    ).toHaveLength(1);
    const degraded = warnings.find(
      (w) => w.code === "WORKFLOW_EVENT_EXPORT_DEGRADED",
    );
    expect(degraded?.executionId).toBe("exec-1");
    expect(degraded?.errorCode).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
    expect(typeof degraded?.timestamp).toBe("number");
  });

  test("a try that exceeds appendTimeoutMs counts as a failure and is retried", async () => {
    const exporter = new FaultyExporter();
    exporter.script = ["hang", "ok"];
    const { pipeline, warnings } = makePipeline(exporter, {
      appendTimeoutMs: 30,
    });
    pipeline.offer(record("a"));
    expect(await pipeline.flush(2_000)).toBe(0);
    expect(exporter.calls).toHaveLength(2);
    expect(exporter.ids()).toEqual(["a"]);
    expect(codes(warnings)).toContain("WORKFLOW_EVENT_EXPORT_DEGRADED");
    expect(codes(warnings)).toContain("WORKFLOW_EVENT_EXPORT_RECOVERED");
  });

  test("an append that stores and then fails is retried without a duplicate", async () => {
    const exporter = new FaultyExporter();
    exporter.script = ["store-then-fail", "ok"];
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    await pipeline.flush(2_000);
    expect(exporter.ids()).toEqual(["a", "b"]);
    expect(
      (exporter.stored.get("exec-1") ?? []).map((r) => r.sequence),
    ).toEqual([1, 2]);
    expect(pipeline.stats.duplicates).toBe(2);
    expect(pipeline.stats.exported).toBe(0);
    expect(pipeline.stats.dropped).toBe(0);
  });

  test("when the retries are used up the batch is dropped and DROPPED is raised", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      "down",
    );
    const { pipeline, warnings } = makePipeline(exporter);
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    expect(await pipeline.flush(3_000)).toBe(0);
    expect(exporter.calls).toHaveLength(3);
    const dropped = warnings.find(
      (w) => w.code === "WORKFLOW_EVENT_EXPORT_DROPPED",
    );
    expect(dropped).toBeDefined();
    expect(dropped?.reason).toBe("retries_exhausted");
    expect(dropped?.droppedRecords).toBe(2);
    expect(dropped?.attempts).toBe(3);
    expect(dropped?.errorCode).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
    expect(dropped?.executionId).toBe("exec-1");
    expect(pipeline.stats.dropped).toBe(2);
    expect(pipeline.stats.buffered).toBe(0);
    expect(codes(warnings)[0]).toBe("WORKFLOW_EVENT_EXPORT_DEGRADED");
  });

  test("a non-retryable error is not retried: one try, then DROPPED", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad",
    );
    const { pipeline, warnings } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await pipeline.flush(2_000);
    expect(exporter.calls).toHaveLength(1);
    const dropped = warnings.find(
      (w) => w.code === "WORKFLOW_EVENT_EXPORT_DROPPED",
    );
    expect(dropped?.reason).toBe("non_retryable");
    expect(dropped?.errorCode).toBe("WORKFLOW_STORAGE_CORRUPT");
    expect(dropped?.droppedRecords).toBe(1);
    expect(pipeline.stats.retries).toBe(0);
  });

  test("a plain Error is not retried", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new Error("plain");
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await pipeline.flush(2_000);
    expect(exporter.calls).toHaveLength(1);
    expect(pipeline.stats.dropped).toBe(1);
  });

  test("an exporter that never resolves: each try ends at the time limit, the batch is dropped, nothing hangs", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline, warnings } = makePipeline(exporter, {
      appendTimeoutMs: 20,
    });
    const started = Date.now();
    pipeline.offer(record("a"));
    expect(await pipeline.flush(3_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exporter.calls).toHaveLength(3);
    expect(
      warnings.find((w) => w.code === "WORKFLOW_EVENT_EXPORT_DROPPED")?.reason,
    ).toBe("retries_exhausted");
  });

  test("the batch after a dropped batch still goes out and the stored log has no gap", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad"),
    ];
    const { pipeline } = makePipeline(exporter, { maxBatchRecords: 1 });
    pipeline.offer(record("lost"));
    pipeline.offer(record("kept1"));
    pipeline.offer(record("kept2"));
    await pipeline.flush(2_000);
    const stored = exporter.stored.get("exec-1") ?? [];
    expect(stored.map((r) => r.sequence)).toEqual(stored.map((_, i) => i + 1));
    expect(stored.map((r) => r.id)).toContain("kept1");
    expect(stored.map((r) => r.id)).toContain("kept2");
    expect(stored.map((r) => r.id)).not.toContain("lost");
  });

  test("a failing batch blocks the next batch of the same execution until it succeeds", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down"),
    ];
    const { pipeline } = makePipeline(exporter, { maxBatchRecords: 1 });
    pipeline.offer(record("r1"));
    pipeline.offer(record("r2"));
    pipeline.offer(record("r3"));
    await pipeline.flush(2_000);
    expect(exporter.ids()).toEqual(["r1", "r2", "r3"]);
    expect(exporter.calls[0]?.ids).toEqual(["r1"]);
    expect(exporter.calls[1]?.ids).toEqual(["r1"]);
  });

  test("a failing exporter never blocks other executions' accounting: stats add up", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad",
    );
    const { pipeline } = makePipeline(exporter);
    for (let i = 0; i < 6; i += 1) pipeline.offer(record(`r${i}`));
    await pipeline.flush(2_000);
    const { offered, exported, dropped, duplicates, buffered } = pipeline.stats;
    expect(offered).toBe(6);
    expect(exported + dropped + buffered).toBe(offered);
    expect(duplicates).toBe(0);
  });
});

describe("WorkflowEventExportPipeline: bounded buffer", () => {
  test("a full buffer drops the newest records, counts them and raises one DROPPED per burst", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline, warnings } = makePipeline(exporter, {
      maxBufferedRecords: 3,
      appendTimeoutMs: 5_000,
    });
    const results = [1, 2, 3, 4, 5].map((n) => pipeline.offer(record(`r${n}`)));
    expect(results).toEqual([true, true, true, false, false]);
    expect(pipeline.stats.dropped).toBe(2);
    expect(pipeline.stats.buffered).toBe(3);
    const full = warnings.filter((w) => w.reason === "buffer_full");
    expect(full).toHaveLength(1);
    expect(full[0]?.code).toBe("WORKFLOW_EVENT_EXPORT_DROPPED");
    expect(full[0]?.droppedRecords).toBeGreaterThanOrEqual(1);
  });

  test("the records that were kept are the oldest ones", async () => {
    const exporter = new FaultyExporter();
    exporter.delayMs = 20;
    const { pipeline } = makePipeline(exporter, { maxBufferedRecords: 3 });
    for (let n = 1; n <= 6; n += 1) pipeline.offer(record(`r${n}`));
    await pipeline.flush(2_000);
    expect(exporter.ids()).toEqual(["r1", "r2", "r3"]);
  });

  test("a full buffer by bytes drops the newest record", () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline } = makePipeline(exporter, {
      maxBufferedBytes: 900,
      appendTimeoutMs: 5_000,
    });
    const big = (id: string) =>
      record(id, { payload: { text: "x".repeat(300) } });
    expect(pipeline.offer(big("a"))).toBe(true);
    expect(pipeline.offer(big("b"))).toBe(true);
    expect(pipeline.offer(big("c"))).toBe(false);
    expect(pipeline.stats.dropped).toBe(1);
  });

  test("space is available again after records are exported", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter, { maxBufferedRecords: 2 });
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    await pipeline.flush(1_000);
    expect(pipeline.offer(record("c"))).toBe(true);
    await pipeline.flush(1_000);
    expect(exporter.ids()).toEqual(["a", "b", "c"]);
  });

  test("a second burst after recovery raises a second DROPPED", async () => {
    const exporter = new FaultyExporter();
    exporter.delayMs = 5;
    const { pipeline, warnings } = makePipeline(exporter, {
      maxBufferedRecords: 1,
    });
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    await pipeline.flush(1_000);
    pipeline.offer(record("c"));
    pipeline.offer(record("d"));
    await pipeline.flush(1_000);
    expect(warnings.filter((w) => w.reason === "buffer_full")).toHaveLength(2);
  });

  test.each([
    { maxBufferedRecords: 0 },
    { maxBufferedBytes: -1 },
    { maxBatchRecords: 1.5 },
    { flushIntervalMs: 0 },
    { appendTimeoutMs: Number.NaN },
  ])("rejects the option %p", (options) => {
    let error: unknown;
    try {
      new WorkflowEventExportPipeline({
        exporter: new FaultyExporter(),
        ...options,
      });
    } catch (caught) {
      error = caught;
    }
    expect(
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
    ).toBe(true);
  });
});

describe("WorkflowEventExportPipeline: warning record in the log", () => {
  function warningRecords(exporter: FaultyExporter) {
    return (exporter.stored.get("exec-1") ?? []).filter(
      (r) => r.kind === "warning",
    );
  }

  test("dropped records are reported by a warning record that takes the next sequence", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad"),
    ];
    const { pipeline } = makePipeline(exporter, { maxBatchRecords: 2 });
    pipeline.offer(record("lost1"));
    pipeline.offer(record("lost2"));
    await pipeline.flush(1_000);
    expect(exporter.ids()).toEqual([]);
    pipeline.offer(record("kept"));
    await pipeline.flush(1_000);
    const stored = exporter.stored.get("exec-1") ?? [];
    expect(stored.map((r) => r.sequence)).toEqual(stored.map((_, i) => i + 1));
    const warnings = warningRecords(exporter);
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.type).toBe("WORKFLOW_EVENT_EXPORT_DROPPED");
    expect(warning?.executionId).toBe("exec-1");
    const payload = JSON.stringify(warning?.payload);
    expect(payload).toContain("2");
    expect(payload).toContain("non_retryable");
    expect(stored.map((r) => r.id)).toContain("kept");
    expect(stored).toHaveLength(2);
  });

  test("buffer-full drops are reported in the log once the exporter works again", async () => {
    const exporter = new FaultyExporter();
    exporter.delayMs = 10;
    const { pipeline } = makePipeline(exporter, { maxBufferedRecords: 2 });
    for (let n = 1; n <= 5; n += 1) pipeline.offer(record(`r${n}`));
    await pipeline.flush(2_000);
    pipeline.offer(record("later"));
    await pipeline.flush(2_000);
    const warnings = warningRecords(exporter);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0]?.payload)).toContain("buffer_full");
    const stored = exporter.stored.get("exec-1") ?? [];
    expect(stored.map((r) => r.sequence)).toEqual(stored.map((_, i) => i + 1));
  });

  test("the warning record is not duplicated when its append is retried", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad"),
    ];
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("lost"));
    await pipeline.flush(1_000);
    exporter.script = [...exporter.script, "store-then-fail"];
    pipeline.offer(record("kept"));
    await pipeline.flush(2_000);
    expect(warningRecords(exporter)).toHaveLength(1);
  });

  test("no warning record is written when nothing was dropped", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await pipeline.flush(1_000);
    expect(warningRecords(exporter)).toHaveLength(0);
  });
});

describe("WorkflowEventExportPipeline: warnings reach the host", () => {
  test("warnings are written to ADK's logger with the code", async () => {
    const lines: string[] = [];
    const sink = (...args: unknown[]) =>
      lines.push(args.map((a) => String(a)).join(" "));
    setLogger({
      log: (_level: LogLevel, ...args: unknown[]) => sink(...args),
      debug: sink,
      info: sink,
      warn: sink,
      error: sink,
      setLogLevel: () => {},
    });
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad",
    );
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await pipeline.flush(1_000);
    const text = lines.join("\n");
    expect(text).toContain("WORKFLOW_EVENT_EXPORT_DROPPED");
  });

  test("a throwing onWarning does not stop the pipeline", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_UNAVAILABLE", "down"),
      "ok",
    ];
    const { pipeline } = makePipeline(exporter, {
      onWarning: () => {
        throw new Error("callback");
      },
    });
    pipeline.offer(record("a"));
    expect(await pipeline.flush(1_000)).toBe(0);
    expect(exporter.ids()).toEqual(["a"]);
  });

  test("no onWarning callback is required", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad",
    );
    const pipeline = new WorkflowEventExportPipeline({ exporter, ...FAST });
    pipelines.push(pipeline);
    pipeline.offer(record("a"));
    expect(await pipeline.flush(1_000)).toBe(0);
  });
});

describe("WorkflowEventExportPipeline: flush and close are bounded and never reject", () => {
  test("flush returns the number still buffered when the time limit passes", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline } = makePipeline(exporter, { appendTimeoutMs: 5_000 });
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    const started = Date.now();
    const left = await pipeline.flush(60);
    expect(Date.now() - started).toBeLessThan(500);
    expect(left).toBe(2);
  });

  test("flush with nothing buffered returns 0 at once", async () => {
    const { pipeline } = makePipeline(new FaultyExporter());
    const started = Date.now();
    expect(await pipeline.flush(5_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("flush does not reject when the exporter throws", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new Error("boom");
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await expect(pipeline.flush(1_000)).resolves.toBe(0);
  });

  test("flush with a zero time limit returns without waiting and does not reject", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline } = makePipeline(exporter, { appendTimeoutMs: 5_000 });
    pipeline.offer(record("a"));
    await expect(pipeline.flush(0)).resolves.toBe(1);
  });

  test("close exports what it can, drops the rest with reason closed, and returns within its limit", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline, warnings } = makePipeline(exporter, {
      appendTimeoutMs: 5_000,
    });
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    const started = Date.now();
    await pipeline.close(60);
    expect(Date.now() - started).toBeLessThan(500);
    const closed = warnings.find((w) => w.reason === "closed");
    expect(closed?.code).toBe("WORKFLOW_EVENT_EXPORT_DROPPED");
    expect(closed?.droppedRecords).toBe(2);
    expect(pipeline.stats.buffered).toBe(0);
    expect(pipeline.stats.dropped).toBe(2);
  });

  test("close exports buffered records when the exporter is healthy", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter, { flushIntervalMs: 5_000 });
    pipeline.offer(record("a"));
    pipeline.offer(record("b"));
    await pipeline.close(1_000);
    expect(exporter.ids()).toEqual(["a", "b"]);
  });

  test("after close offers are dropped, close twice is harmless and the exporter stays open", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    await pipeline.close(100);
    await pipeline.close(100);
    expect(pipeline.offer(record("late"))).toBe(false);
    expect(pipeline.stats.dropped).toBe(1);
    expect(exporter.closed).toBe(false);
    expect(exporter.calls).toHaveLength(0);
  });

  test("close does not reject when the exporter throws", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = new Error("boom");
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    await expect(pipeline.close(500)).resolves.toBeUndefined();
  });
});

describe("WorkflowEventExportPipeline: clipping and overflow", () => {
  test("a record over the exporter's limit is clipped before it is stored and counted", async () => {
    const exporter = new FaultyExporter(2_000);
    const { pipeline } = makePipeline(exporter, { maxStringBytes: 100 });
    pipeline.offer(record("a", { payload: { text: "x".repeat(10_000) } }));
    await pipeline.flush(1_000);
    const [stored] = exporter.stored.get("exec-1") ?? [];
    expect(stored?.clipped?.paths).toEqual(["/text"]);
    expect(stored?.id).toBe("a");
    expect(stored?.executionId).toBe("exec-1");
    expect(
      new TextEncoder().encode(JSON.stringify(stored)).length,
    ).toBeLessThanOrEqual(2_100);
    expect(pipeline.stats.clipped).toBe(1);
  });

  test("the maxRecordBytes option overrides the exporter's limit", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter, {
      maxRecordBytes: 800,
      maxStringBytes: 50,
    });
    pipeline.offer(record("a", { payload: { text: "x".repeat(5_000) } }));
    await pipeline.flush(1_000);
    expect((exporter.stored.get("exec-1") ?? [])[0]?.clipped).toBeDefined();
  });

  test("the overflow handler receives the full payload and its reference is stored on the record", async () => {
    const exporter = new FaultyExporter(2_000);
    const seen: Array<{
      executionId: string;
      recordId: string;
      serialized: string;
      sha256: string;
    }> = [];
    const { pipeline } = makePipeline(exporter, {
      maxStringBytes: 100,
      overflow: async (overflow) => {
        seen.push(overflow);
        return { store: "test", key: "k1", version: 2 };
      },
    });
    const payload = { text: "x".repeat(10_000) };
    pipeline.offer(record("a", { payload }));
    await pipeline.flush(1_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.serialized).toBe(JSON.stringify(payload));
    expect(seen[0]?.recordId).toBe("a");
    expect(seen[0]?.executionId).toBe("exec-1");
    expect(
      (exporter.stored.get("exec-1") ?? [])[0]?.clipped?.reference,
    ).toEqual({
      store: "test",
      key: "k1",
      version: 2,
    });
  });

  test("the overflow handler is not called for a record that fits", async () => {
    const exporter = new FaultyExporter();
    let calls = 0;
    const { pipeline } = makePipeline(exporter, {
      overflow: async () => {
        calls += 1;
        return { store: "t", key: "k" };
      },
    });
    pipeline.offer(record("a"));
    await pipeline.flush(1_000);
    expect(calls).toBe(0);
  });

  test("a throwing overflow handler still exports the clipped record without a reference", async () => {
    const exporter = new FaultyExporter(2_000);
    const { pipeline } = makePipeline(exporter, {
      maxStringBytes: 100,
      overflow: async () => {
        throw new Error("artifact store down");
      },
    });
    pipeline.offer(record("a", { payload: { text: "x".repeat(10_000) } }));
    await pipeline.flush(1_000);
    const [stored] = exporter.stored.get("exec-1") ?? [];
    expect(stored?.clipped).toBeDefined();
    expect(stored?.clipped?.reference).toBeUndefined();
  });

  test("an overflow handler that never resolves delays the record by at most the append time limit", async () => {
    const exporter = new FaultyExporter(2_000);
    const { pipeline } = makePipeline(exporter, {
      maxStringBytes: 100,
      appendTimeoutMs: 50,
      overflow: () => new Promise(() => {}),
    });
    const started = Date.now();
    pipeline.offer(record("a", { payload: { text: "x".repeat(10_000) } }));
    expect(await pipeline.flush(2_000)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_500);
    const [stored] = exporter.stored.get("exec-1") ?? [];
    expect(stored?.id).toBe("a");
    expect(stored?.clipped?.reference).toBeUndefined();
  });

  test("order is kept when an earlier record waits for its overflow handler", async () => {
    const exporter = new FaultyExporter(2_000);
    const { pipeline } = makePipeline(exporter, {
      maxStringBytes: 100,
      overflow: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { store: "t", key: "k" };
      },
    });
    pipeline.offer(record("big", { payload: { text: "x".repeat(10_000) } }));
    pipeline.offer(record("small"));
    await pipeline.flush(2_000);
    expect(exporter.ids()).toEqual(["big", "small"]);
  });
});

describe("createArtifactOverflowHandler", () => {
  test("saves the full payload through the artifact service and returns an adk-artifact reference", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const service = new InMemoryArtifactService();
    const original = service.saveArtifact.bind(service);
    service.saveArtifact = async (request) => {
      saved.push(request as unknown as Record<string, unknown>);
      return await original(request);
    };
    const handler = createArtifactOverflowHandler(service, {
      appName: "app",
      userId: "user",
    });
    const serialized = JSON.stringify({ text: "héllo 世界".repeat(100) });
    const reference = await handler({
      executionId: "exec-1",
      recordId: "rec-1",
      serialized,
      sha256: "abc",
    });
    expect(reference.store).toBe("adk-artifact");
    expect(typeof reference.key).toBe("string");
    expect(reference.key.length).toBeGreaterThan(0);
    expect(typeof reference.version).toBe("number");
    expect(saved).toHaveLength(1);
    const [request] = saved;
    expect(request?.appName).toBe("app");
    expect(request?.userId).toBe("user");
    expect(request?.filename).toBe(reference.key);
    expect(typeof request?.sessionId).toBe("string");
    const part = request?.artifact as {
      text?: string;
      inlineData?: { data?: string };
    };
    const content =
      part.text ??
      Buffer.from(part.inlineData?.data ?? "", "base64").toString("utf8");
    expect(content).toBe(serialized);
    const loaded = await service.loadArtifact({
      appName: "app",
      userId: "user",
      sessionId: request?.sessionId as string,
      filename: reference.key,
    });
    expect(loaded).toBeDefined();
  });

  test("derives different sessions for different executions and different files for different records", async () => {
    const sessions = new Set<string>();
    const files = new Set<string>();
    const service = new InMemoryArtifactService();
    const original = service.saveArtifact.bind(service);
    service.saveArtifact = async (request) => {
      sessions.add(request.sessionId);
      files.add(request.filename);
      return await original(request);
    };
    const handler = createArtifactOverflowHandler(service, {
      appName: "app",
      userId: "u",
    });
    for (const [executionId, recordId] of [
      ["e1", "r1"],
      ["e2", "r1"],
      ["e1", "r2"],
    ] as const) {
      await handler({ executionId, recordId, serialized: "{}", sha256: "x" });
    }
    expect(sessions.size).toBe(2);
    expect(files.size).toBeGreaterThanOrEqual(2);
  });

  test("an artifact failure rejects the handler, which the pipeline tolerates", async () => {
    const service = new InMemoryArtifactService();
    service.saveArtifact = async () => {
      throw new Error("no space");
    };
    const handler = createArtifactOverflowHandler(service, {
      appName: "app",
      userId: "u",
    });
    await expect(
      handler({
        executionId: "e",
        recordId: "r",
        serialized: "{}",
        sha256: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("WorkflowEventExportPipeline: offerAdkEvent", () => {
  test("queues the mapped record and returns how many were queued", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    const queued = pipeline.offerAdkEvent(
      createEvent({
        id: "e1",
        invocationId: "inv-1",
        author: "agent",
        content: { role: "model", parts: [{ text: "hi" }] },
      }),
    );
    expect(queued).toBe(1);
    await pipeline.flush(1_000);
    expect(exporter.ids("invocation:inv-1")).toEqual(["e1"]);
  });

  test("a partial event queues nothing", () => {
    const { pipeline } = makePipeline(new FaultyExporter());
    expect(
      pipeline.offerAdkEvent(
        createEvent({ id: "p", invocationId: "i", author: "a", partial: true }),
      ),
    ).toBe(0);
    expect(pipeline.stats.offered).toBe(0);
  });

  test("events of an invocation follow the execution of its last workflow event", async () => {
    const exporter = new FaultyExporter();
    const { pipeline } = makePipeline(exporter);
    pipeline.offerAdkEvent(
      createEvent({
        id: "wf1",
        invocationId: "inv-1",
        author: "wf",
        customMetadata: {
          workflowEvent: {
            type: "workflow_started",
            workflowId: "wf",
            workflowVersion: "1",
            executionId: "exec-1",
            timestamp: 1,
          },
        },
      }),
    );
    pipeline.offerAdkEvent(
      createEvent({
        id: "plain1",
        invocationId: "inv-1",
        author: "agent",
        content: { role: "model", parts: [{ text: "hi" }] },
      }),
    );
    await pipeline.flush(1_000);
    expect(exporter.ids("exec-1")).toEqual(["wf1", "plain1"]);
  });

  test("never throws for a malformed event", () => {
    const { pipeline } = makePipeline(new FaultyExporter());
    expect(() => pipeline.offerAdkEvent({} as never)).not.toThrow();
    expect(() => pipeline.offerAdkEvent(null as never)).not.toThrow();
  });
});

describe("WorkflowEventExportPipeline: timers do not keep the process alive", () => {
  const pipelineModule = new URL(
    "../../../../src/workflows/storage/event-export-pipeline.ts",
    import.meta.url,
  ).pathname;
  const exporterModule = new URL(
    "../../../../src/workflows/storage/event-exporter.ts",
    import.meta.url,
  ).pathname;

  async function runScript(
    body: string,
  ): Promise<{ code: number; ms: number }> {
    const script = `
      const { WorkflowEventExportPipeline } = await import(${JSON.stringify(pipelineModule)});
      const { BaseWorkflowEventExporter } = await import(${JSON.stringify(exporterModule)});
      class Hanging extends BaseWorkflowEventExporter {
        providerName = "hanging";
        capabilities = { durable: false, multiProcess: false, listing: false, pruning: false, maxRecordBytes: 262144 };
        async append() { return await new Promise(() => {}); }
        async appendRecords() { return await new Promise(() => {}); }
        async readRecords() { return { records: [], nextAfterSequence: 0, hasMore: false }; }
      }
      const record = { id: "a", executionId: "e", kind: "workflow", type: "custom", timestamp: 1, payload: {} };
      ${body}
    `;
    const started = Date.now();
    const proc = Bun.spawn([process.execPath, "-e", script], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(9), 15_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return { code, ms: Date.now() - started };
  }

  test("a pending flush timer does not keep the process alive", async () => {
    const result = await runScript(`
      const p = new WorkflowEventExportPipeline({ exporter: new Hanging(), flushIntervalMs: 60000, appendTimeoutMs: 60000 });
      p.offer(record);
    `);
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  }, 30_000);

  test("a pending append timeout and backoff timer do not keep the process alive", async () => {
    const result = await runScript(`
      const p = new WorkflowEventExportPipeline({
        exporter: new Hanging(), flushIntervalMs: 1, appendTimeoutMs: 60000,
        retry: { maxAttempts: 5, initialDelayMs: 60000, maxDelayMs: 60000 },
      });
      p.offer(record);
      await new Promise((r) => setTimeout(r, 100));
    `);
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  }, 30_000);

  test("a pending flush keeps the process alive until its time limit, then lets it exit", async () => {
    const result = await runScript(`
      const p = new WorkflowEventExportPipeline({ exporter: new Hanging(), flushIntervalMs: 1, appendTimeoutMs: 60000 });
      p.offer(record);
      p.flush(1500);
      await new Promise((r) => setTimeout(r, 50));
    `);
    expect(result.code).toBe(0);
    expect(result.ms).toBeGreaterThanOrEqual(1500);
    expect(result.ms).toBeLessThan(10_000);
  }, 30_000);
});

describe("WorkflowEventExportPipeline: review follow-ups", () => {
  test("offer does not throw when reading the record throws", () => {
    const { pipeline } = makePipeline(new FaultyExporter());
    const hostile = {
      get executionId(): string {
        throw new Error("getter");
      },
    };
    let result: boolean | undefined;
    expect(() => {
      result = pipeline.offer(hostile as never);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  test("flush does not reject when a timer cannot be created", async () => {
    const exporter = new FaultyExporter();
    exporter.defaultBehavior = "hang";
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("a"));
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (() => {
      throw new Error("no timers");
    }) as never;
    try {
      await expect(pipeline.flush(50)).resolves.toBe(1);
    } finally {
      globalThis.setTimeout = original;
    }
  });

  test("the warning record comes before the records that were still queued behind a dropped batch", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad"),
    ];
    const { pipeline } = makePipeline(exporter, { maxBatchRecords: 1 });
    pipeline.offer(record("lost"));
    pipeline.offer(record("kept1"));
    pipeline.offer(record("kept2"));
    await pipeline.flush(2_000);
    const stored = exporter.stored.get("exec-1") ?? [];
    expect(stored.map((r) => r.kind)).toEqual([
      "warning",
      "workflow",
      "workflow",
    ]);
    expect(stored.slice(1).map((r) => r.id)).toEqual(["kept1", "kept2"]);
  });

  test("close writes the warning record of a drop that no later record reported", async () => {
    const exporter = new FaultyExporter();
    exporter.script = [
      new WorkflowStorageError("WORKFLOW_STORAGE_CORRUPT", "bad"),
    ];
    const { pipeline } = makePipeline(exporter);
    pipeline.offer(record("lost"));
    await pipeline.flush(1_000);
    expect(exporter.ids()).toEqual([]);
    await pipeline.close(1_000);
    const stored = exporter.stored.get("exec-1") ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.kind).toBe("warning");
    expect(stored[0]?.sequence).toBe(1);
  });

  test("the pipeline limit is capped at the exporter's limit", async () => {
    const exporter = new FaultyExporter(2_000);
    const { pipeline } = makePipeline(exporter, {
      maxRecordBytes: 1_000_000,
      maxStringBytes: 100,
    });
    pipeline.offer(record("a", { payload: { text: "x".repeat(10_000) } }));
    await pipeline.flush(1_000);
    expect(exporter.ids()).toEqual(["a"]);
    expect(pipeline.stats.dropped).toBe(0);
  });
});
