import { describe, expect, test } from "bun:test";
import {
  isWorkflowStorageError,
  WorkflowStorageError,
} from "../../../../src/workflows/storage/errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type BaseWorkflowEventExporterOptions,
  type ListWorkflowEventExecutionsInput,
  type ListWorkflowEventExecutionsResult,
  MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH,
  type PruneWorkflowEventRecordsInput,
  type PruneWorkflowEventRecordsResult,
  type ReadWorkflowEventRecordsInput,
  type ReadWorkflowEventRecordsResult,
  type WorkflowEventExporterCapabilities,
  type WorkflowEventRecordInput,
} from "../../../../src/workflows/storage/event-exporter.js";
import type { WorkflowStorageOperationMetric } from "../../../../src/workflows/storage/support.js";

/** Minimal exporter that records every primitive call. */
class ProbeExporter extends BaseWorkflowEventExporter {
  readonly providerName = "probe";
  readonly capabilities: WorkflowEventExporterCapabilities;
  readonly calls: string[] = [];
  appended: Array<{
    executionId: string;
    records: readonly WorkflowEventRecordInput[];
  }> = [];
  lastRead?: ReadWorkflowEventRecordsInput;
  lastList?: ListWorkflowEventExecutionsInput;
  failure?: unknown;
  listing: boolean;

  constructor(
    options: BaseWorkflowEventExporterOptions & { listing?: boolean } = {},
  ) {
    super(options);
    this.listing = options.listing ?? true;
    this.capabilities = {
      durable: false,
      multiProcess: false,
      listing: this.listing,
      pruning: true,
      maxRecordBytes: options.maxRecordBytes ?? 256 * 1024,
    };
  }

  protected async appendRecords(
    executionId: string,
    records: readonly WorkflowEventRecordInput[],
  ): Promise<AppendWorkflowEventRecordsResult> {
    this.calls.push("appendRecords");
    if (this.failure) throw this.failure;
    this.appended.push({ executionId, records });
    return {
      records: records.map((record, index) => ({
        id: record.id,
        sequence: index + 1,
        duplicate: false,
      })),
      lastSequence: records.length,
    };
  }

  protected async readRecords(
    input: ReadWorkflowEventRecordsInput & {
      afterSequence: number;
      limit: number;
    },
  ): Promise<ReadWorkflowEventRecordsResult> {
    this.calls.push("readRecords");
    this.lastRead = input;
    return {
      records: [],
      nextAfterSequence: input.afterSequence,
      hasMore: false,
    };
  }

  protected override async listExportedExecutions(
    input: ListWorkflowEventExecutionsInput & { limit: number },
  ): Promise<ListWorkflowEventExecutionsResult> {
    this.calls.push("listExportedExecutions");
    this.lastList = input;
    return { items: [] };
  }

  protected override async pruneRecords(
    input: PruneWorkflowEventRecordsInput,
  ): Promise<PruneWorkflowEventRecordsResult> {
    this.calls.push("pruneRecords");
    void input;
    return { executions: 0, records: 0, hasMore: false };
  }

  protected override async checkHealth(): Promise<number | undefined> {
    this.calls.push("checkHealth");
    if (this.failure) throw this.failure;
    return 3;
  }

  protected override async flushExporter(): Promise<void> {
    this.calls.push("flushExporter");
  }

  protected override async closeExporter(): Promise<void> {
    this.calls.push("closeExporter");
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
    payload: { n: 1 },
    ...overrides,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await rejection(promise);
  expect(isWorkflowStorageError(error, code as never)).toBe(true);
}

describe("BaseWorkflowEventExporter construction", () => {
  test("reports contract version 1", () => {
    expect(new ProbeExporter().contractVersion).toBe(1);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects maxRecordBytes %p as an invalid option",
    (maxRecordBytes) => {
      let error: unknown;
      try {
        new ProbeExporter({ maxRecordBytes });
      } catch (caught) {
        error = caught;
      }
      expect(
        isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
      ).toBe(true);
    },
  );
});

describe("BaseWorkflowEventExporter.append validation", () => {
  test("delegates a valid batch to the primitive with the same records", async () => {
    const exporter = new ProbeExporter();
    const batch = [record("a"), record("b")];
    const result = await exporter.append({
      executionId: "exec-1",
      records: batch,
    });
    expect(exporter.appended).toHaveLength(1);
    expect(exporter.appended[0]?.executionId).toBe("exec-1");
    expect(exporter.appended[0]?.records.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.records.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("rejects a record that names another execution and never reaches storage", async () => {
    const exporter = new ProbeExporter();
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("a"), record("b", { executionId: "exec-2" })],
      }),
      "WORKFLOW_STORAGE_INVALID_RECORD",
    );
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("rejects a payload that is not JSON-safe", async () => {
    const exporter = new ProbeExporter();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad: unknown[] = [
      { payload: { f: () => 1 } },
      { payload: { u: undefined } },
      { payload: { n: Number.NaN } },
      { payload: { i: Number.POSITIVE_INFINITY } },
      { payload: { b: 10n } },
      { payload: { d: new Date(0) } },
      { payload: circular },
    ];
    for (const overrides of bad) {
      await expectCode(
        exporter.append({
          executionId: "exec-1",
          records: [record("ok"), record("bad", overrides as never)],
        }),
        "WORKFLOW_STORAGE_INVALID_RECORD",
      );
    }
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("rejects a record with a missing or mistyped field", async () => {
    const exporter = new ProbeExporter();
    const bad: unknown[] = [
      { id: "" },
      { id: 5 },
      { kind: "other" },
      { type: "" },
      { timestamp: "now" },
      { timestamp: Number.NaN },
      { payload: null },
      { payload: [] },
      { attempt: "1" },
      { stepId: 1 },
    ];
    for (const overrides of bad) {
      await expectCode(
        exporter.append({
          executionId: "exec-1",
          records: [record("x", overrides as never)],
        }),
        "WORKFLOW_STORAGE_INVALID_RECORD",
      );
    }
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("rejects identifiers longer than the limit and accepts the limit itself", async () => {
    const exporter = new ProbeExporter();
    const tooLong = "x".repeat(MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH + 1);
    const exact = "y".repeat(MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH);
    await expectCode(
      exporter.append({ executionId: "exec-1", records: [record(tooLong)] }),
      "WORKFLOW_STORAGE_INVALID_RECORD",
    );
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("a", { type: tooLong })],
      }),
      "WORKFLOW_STORAGE_INVALID_RECORD",
    );
    await expectCode(
      exporter.append({
        executionId: tooLong,
        records: [record("a", { executionId: tooLong })],
      }),
      "WORKFLOW_STORAGE_INVALID_RECORD",
    );
    expect(exporter.calls).not.toContain("appendRecords");
    await exporter.append({
      executionId: exact,
      records: [record(exact, { executionId: exact, type: exact })],
    });
    expect(exporter.calls).toContain("appendRecords");
  });

  test("rejects an unknown envelope field, a long optional identifier and a value that cannot be serialized", async () => {
    const exporter = new ProbeExporter();
    for (const overrides of [
      { extra: 1 },
      { traceId: "t".repeat(MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH + 1) },
      { spanId: 10n },
    ]) {
      await expectCode(
        exporter.append({
          executionId: "exec-1",
          records: [record("x", overrides as never)],
        }),
        "WORKFLOW_STORAGE_INVALID_RECORD",
      );
    }
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("counts identifier length in characters, not bytes", async () => {
    const exporter = new ProbeExporter();
    const id = "é".repeat(MAX_WORKFLOW_EVENT_IDENTIFIER_LENGTH);
    await exporter.append({ executionId: "exec-1", records: [record(id)] });
    expect(exporter.appended).toHaveLength(1);
  });

  test("rejects an oversized record with PAYLOAD_TOO_LARGE and stores nothing of the batch", async () => {
    const exporter = new ProbeExporter({ maxRecordBytes: 512 });
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [
          record("small"),
          record("big", { payload: { text: "x".repeat(600) } }),
        ],
      }),
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
    );
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("measures the size in UTF-8 bytes", async () => {
    const exporter = new ProbeExporter({ maxRecordBytes: 400 });
    // 150 characters, 450 bytes.
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("big", { payload: { text: "€".repeat(150) } })],
      }),
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
    );
  });

  test("rejects a batch above the append limit", async () => {
    const exporter = new ProbeExporter();
    const records = Array.from({ length: 1001 }, (_, i) => record(`r${i}`));
    const error = await rejection(
      exporter.append({ executionId: "exec-1", records }),
    );
    expect(error).toBeInstanceOf(WorkflowStorageError);
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("accepts a batch of exactly the append limit", async () => {
    const exporter = new ProbeExporter();
    const records = Array.from({ length: 1000 }, (_, i) => record(`r${i}`));
    await exporter.append({ executionId: "exec-1", records });
    expect(exporter.appended[0]?.records).toHaveLength(1000);
  });

  test("rejects two records with the same id in one batch", async () => {
    const exporter = new ProbeExporter();
    const error = await rejection(
      exporter.append({
        executionId: "exec-1",
        records: [record("a"), record("a")],
      }),
    );
    expect(error).toBeInstanceOf(WorkflowStorageError);
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("propagates a storage error from the primitive unchanged", async () => {
    const exporter = new ProbeExporter();
    const failure = new WorkflowStorageError(
      "WORKFLOW_STORAGE_UNAVAILABLE",
      "down",
    );
    exporter.failure = failure;
    expect(
      await rejection(
        exporter.append({ executionId: "exec-1", records: [record("a")] }),
      ),
    ).toBe(failure);
  });

  test("wraps a plain error from the primitive as a storage error", async () => {
    const exporter = new ProbeExporter();
    exporter.failure = new Error("boom");
    const error = await rejection(
      exporter.append({ executionId: "exec-1", records: [record("a")] }),
    );
    expect(error).toBeInstanceOf(WorkflowStorageError);
  });
});

describe("BaseWorkflowEventExporter.read validation", () => {
  test("passes concrete defaults to the primitive", async () => {
    const exporter = new ProbeExporter();
    await exporter.read({ executionId: "exec-1" });
    expect(exporter.lastRead?.afterSequence).toBe(0);
    expect(exporter.lastRead?.limit).toBe(100);
  });

  test("passes explicit cursor, limit and filters through", async () => {
    const exporter = new ProbeExporter();
    await exporter.read({
      executionId: "exec-1",
      afterSequence: 7,
      limit: 1000,
      kinds: ["step"],
      types: ["step_started"],
    });
    expect(exporter.lastRead?.afterSequence).toBe(7);
    expect(exporter.lastRead?.limit).toBe(1000);
    expect(exporter.lastRead?.kinds).toEqual(["step"]);
    expect(exporter.lastRead?.types).toEqual(["step_started"]);
  });

  test.each([0, -1, 1001, 1.5, Number.NaN])(
    "rejects limit %p",
    async (limit) => {
      const exporter = new ProbeExporter();
      await expectCode(
        exporter.read({ executionId: "exec-1", limit }),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
      expect(exporter.calls).not.toContain("readRecords");
    },
  );

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects afterSequence %p",
    async (afterSequence) => {
      const exporter = new ProbeExporter();
      await expectCode(
        exporter.read({ executionId: "exec-1", afterSequence }),
        "WORKFLOW_STORAGE_INVALID_OPTION",
      );
      expect(exporter.calls).not.toContain("readRecords");
    },
  );

  test("rejects an unknown kind filter", async () => {
    const exporter = new ProbeExporter();
    await expectCode(
      exporter.read({ executionId: "exec-1", kinds: ["nope" as never] }),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
  });

  test("rejects an empty execution id", async () => {
    const exporter = new ProbeExporter();
    const error = await rejection(exporter.read({ executionId: "" }));
    expect(error).toBeInstanceOf(WorkflowStorageError);
  });
});

describe("BaseWorkflowEventExporter.listExecutions and prune", () => {
  test("passes the default page size of 50", async () => {
    const exporter = new ProbeExporter();
    await exporter.listExecutions();
    expect(exporter.lastList?.limit).toBe(50);
  });

  test.each([0, 501, -3, 2.5])("rejects list limit %p", async (limit) => {
    const exporter = new ProbeExporter();
    await expectCode(
      exporter.listExecutions({ limit }),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expect(exporter.calls).not.toContain("listExportedExecutions");
  });

  test("rejects a cursor that is not a string", async () => {
    const exporter = new ProbeExporter();
    await expectCode(
      exporter.listExecutions({ cursor: 5 as never }),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
  });

  test("the default primitives reject with UNSUPPORTED", async () => {
    class Bare extends BaseWorkflowEventExporter {
      readonly providerName = "bare";
      readonly capabilities = {
        durable: false,
        multiProcess: false,
        listing: false,
        pruning: false,
        maxRecordBytes: 1024,
      };
      protected async appendRecords(): Promise<AppendWorkflowEventRecordsResult> {
        return { records: [], lastSequence: 0 };
      }
      protected async readRecords(): Promise<ReadWorkflowEventRecordsResult> {
        return { records: [], nextAfterSequence: 0, hasMore: false };
      }
    }
    const bare = new Bare();
    await expectCode(bare.listExecutions(), "WORKFLOW_STORAGE_UNSUPPORTED");
    await expectCode(
      bare.prune({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_UNSUPPORTED",
    );
  });

  test("prune validates its input before delegating", async () => {
    const exporter = new ProbeExporter();
    await expectCode(
      exporter.prune({ lastRecordBefore: Number.NaN }),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    await expectCode(
      exporter.prune({ lastRecordBefore: 10, limit: 0 }),
      "WORKFLOW_STORAGE_INVALID_OPTION",
    );
    expect(exporter.calls).not.toContain("pruneRecords");
    await exporter.prune({ executionId: "exec-1" });
    expect(exporter.calls).toContain("pruneRecords");
  });
});

describe("BaseWorkflowEventExporter.healthCheck, flush and close", () => {
  test("healthCheck reports ok with provider, latency and schema version", async () => {
    const exporter = new ProbeExporter();
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("probe");
    expect(health.schemaVersion).toBe(3);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("healthCheck never throws: a storage error becomes ok false with its code", async () => {
    const exporter = new ProbeExporter();
    exporter.failure = new WorkflowStorageError(
      "WORKFLOW_STORAGE_CORRUPT",
      "bad",
    );
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.code).toBe("WORKFLOW_STORAGE_CORRUPT");
  });

  test("healthCheck never throws: a plain error becomes ok false", async () => {
    const exporter = new ProbeExporter();
    exporter.failure = new Error("boom");
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(false);
    expect(typeof health.code).toBe("string");
  });

  test("flush delegates to the primitive", async () => {
    const exporter = new ProbeExporter();
    await exporter.flush();
    expect(exporter.calls).toContain("flushExporter");
  });

  test("close releases once and every later operation rejects with CLOSED", async () => {
    const exporter = new ProbeExporter();
    await exporter.close();
    await exporter.close();
    expect(exporter.calls.filter((c) => c === "closeExporter")).toHaveLength(1);
    await expectCode(
      exporter.append({ executionId: "exec-1", records: [record("a")] }),
      "WORKFLOW_STORAGE_CLOSED",
    );
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CLOSED",
    );
    await expectCode(exporter.listExecutions(), "WORKFLOW_STORAGE_CLOSED");
    await expectCode(
      exporter.prune({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CLOSED",
    );
    expect(exporter.calls).not.toContain("appendRecords");
  });

  test("close flushes before it releases", async () => {
    const exporter = new ProbeExporter();
    await exporter.close();
    const flushAt = exporter.calls.indexOf("flushExporter");
    const closeAt = exporter.calls.indexOf("closeExporter");
    expect(flushAt).toBeGreaterThanOrEqual(0);
    expect(flushAt).toBeLessThan(closeAt);
  });

  test("healthCheck after close does not throw", async () => {
    const exporter = new ProbeExporter();
    await exporter.close();
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(false);
  });
});

describe("BaseWorkflowEventExporter metrics", () => {
  test("reports exactly one metric per operation, without ids or payload text", async () => {
    const metrics: WorkflowStorageOperationMetric[] = [];
    const exporter = new ProbeExporter({ onOperation: (m) => metrics.push(m) });
    const secretId = "secret-execution-id";
    await exporter.append({
      executionId: secretId,
      records: [
        record("secret-record-id", {
          executionId: secretId,
          payload: { text: "secret-payload-text" },
        }),
      ],
    });
    await exporter.read({ executionId: secretId });
    await exporter.listExecutions();
    await exporter.prune({ executionId: secretId });
    await exporter.healthCheck();
    await exporter.flush();
    expect(metrics.map((m) => m.operation)).toEqual([
      "append",
      "read",
      "listExecutions",
      "prune",
      "healthCheck",
      "flush",
    ]);
    for (const metric of metrics) {
      expect(metric.capability).toBe("events");
      expect(metric.provider).toBe("probe");
      expect(metric.outcome).toBe("ok");
      expect(metric.durationMs).toBeGreaterThanOrEqual(0);
      const text = JSON.stringify(metric);
      expect(text).not.toContain("secret");
    }
    expect(metrics[0]?.records).toBe(1);
    expect(metrics[0]?.bytes).toBeGreaterThan(0);
  });

  test("reports an error metric with the code for a rejected append", async () => {
    const metrics: WorkflowStorageOperationMetric[] = [];
    const exporter = new ProbeExporter({ onOperation: (m) => metrics.push(m) });
    await rejection(
      exporter.append({
        executionId: "exec-1",
        records: [record("a", { executionId: "other" })],
      }),
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.outcome).toBe("error");
    expect(metrics[0]?.errorCode).toBe("WORKFLOW_STORAGE_INVALID_RECORD");
  });

  test("a throwing observer does not fail the operation", async () => {
    const exporter = new ProbeExporter({
      onOperation: () => {
        throw new Error("observer");
      },
    });
    await exporter.append({ executionId: "exec-1", records: [record("a")] });
  });

  test("close reports one metric", async () => {
    const metrics: WorkflowStorageOperationMetric[] = [];
    const exporter = new ProbeExporter({ onOperation: (m) => metrics.push(m) });
    await exporter.close();
    expect(metrics.filter((m) => m.operation === "close")).toHaveLength(1);
  });
});
