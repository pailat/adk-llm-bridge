import { describe, expect, test } from "bun:test";
import {
  defineWorkflowStorageConformanceTests,
  type WorkflowStorageConformanceCase,
  workflowEventExporterConformanceCases,
} from "../../../../src/workflows/storage/conformance/index.js";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import {
  type AppendWorkflowEventRecordsResult,
  BaseWorkflowEventExporter,
  type WorkflowEventRecordInput,
} from "../../../../src/workflows/storage/event-exporter.js";
import { InMemoryWorkflowEventExporter } from "../../../../src/workflows/storage/in-memory-event-exporter.js";

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

// The stub throws while the suite is missing; an empty list keeps the file
// collectable so each test below reports its own failure.
const cases: WorkflowStorageConformanceCase[] =
  await workflowEventExporterConformanceCases({
    createExporter: () => new InMemoryWorkflowEventExporter(),
  }).catch(() => []);

describe("workflowEventExporterConformanceCases over the in-memory exporter", () => {
  defineWorkflowStorageConformanceTests(cases, { test, skip: test.skip });

  test("builds cases with names and a run function", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    for (const conformanceCase of cases) {
      expect(conformanceCase.name.length).toBeGreaterThan(0);
      expect(typeof conformanceCase.run).toBe("function");
    }
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });

  test("covers every guarantee its documentation lists", () => {
    const names = cases.map((c) => c.name.toLowerCase()).join("\n");
    for (const topic of [
      "sequence",
      "duplicate",
      "concurrent",
      "invalid",
      "oversized",
      "filter",
      "list",
      "prune",
      "health",
      "closed",
      "metric",
    ]) {
      expect(names).toContain(topic);
    }
  });

  test("skips the reopen cases for a non-durable exporter that gives no reopen", () => {
    const reopenCases = cases.filter((c) => /reopen/i.test(c.name));
    expect(reopenCases.length).toBeGreaterThan(0);
    for (const reopenCase of reopenCases) expect(reopenCase.skip).toBeDefined();
  });

  test("skips the listing cases when the exporter cannot list", async () => {
    class NoListing extends InMemoryWorkflowEventExporter {
      override readonly capabilities = Object.freeze({
        durable: false,
        multiProcess: false,
        listing: false,
        pruning: false,
        maxRecordBytes: 256 * 1024,
      });
    }
    const limited = await workflowEventExporterConformanceCases({
      createExporter: () => new NoListing(),
    });
    const listingCase = limited.find((c) => /list/i.test(c.name));
    expect(listingCase).toBeDefined();
    expect(
      limited.some((c) => c.skip !== undefined && /listing/i.test(c.skip)),
    ).toBe(true);
  });

  test("the suite imports no test runner", async () => {
    const source = await Bun.file(
      new URL(
        "../../../../src/workflows/storage/conformance/event-suite.ts",
        import.meta.url,
      ),
    ).text();
    expect(source).not.toMatch(
      /from\s+["'](bun:test|vitest|jest|node:test|@jest)/,
    );
  });
});

describe("the conformance suite rejects a broken exporter", () => {
  /** Assigns sequences that restart at every batch: breaks the no-repeat rule. */
  class RepeatingSequence extends InMemoryWorkflowEventExporter {
    protected override async appendRecords(
      executionId: string,
      records: readonly WorkflowEventRecordInput[],
    ): Promise<AppendWorkflowEventRecordsResult> {
      const result = await super.appendRecords(executionId, records);
      return {
        records: result.records.map((r) => ({ ...r, sequence: 1 })),
        lastSequence: 1,
      };
    }
  }

  test("a sequence that repeats fails at least one case", async () => {
    const broken = await workflowEventExporterConformanceCases({
      createExporter: () => new RepeatingSequence(),
    });
    let failures = 0;
    for (const conformanceCase of broken) {
      if (conformanceCase.skip !== undefined) continue;
      try {
        await conformanceCase.run();
      } catch {
        failures += 1;
      }
    }
    expect(failures).toBeGreaterThan(0);
  });

  test("a failing case rejects with WorkflowStorageConformanceFailure", async () => {
    const broken = await workflowEventExporterConformanceCases({
      createExporter: () => new RepeatingSequence(),
    });
    const errors: unknown[] = [];
    for (const conformanceCase of broken as WorkflowStorageConformanceCase[]) {
      if (conformanceCase.skip !== undefined) continue;
      try {
        await conformanceCase.run();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some(
        (e) =>
          e instanceof Error && e.name === "WorkflowStorageConformanceFailure",
      ),
    ).toBe(true);
  });
});

describe("InMemoryWorkflowEventExporter", () => {
  test("declares its capabilities", () => {
    const exporter = new InMemoryWorkflowEventExporter();
    expect(exporter).toBeInstanceOf(BaseWorkflowEventExporter);
    expect(exporter.providerName).toBe("memory");
    expect(exporter.capabilities).toEqual({
      durable: false,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxRecordBytes: 256 * 1024,
    });
  });

  test("sequences start at 1 and grow by one across batches", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const first = await exporter.append({
      executionId: "exec-1",
      records: [record("a"), record("b")],
    });
    const second = await exporter.append({
      executionId: "exec-1",
      records: [record("c")],
    });
    expect(first.records.map((r) => r.sequence)).toEqual([1, 2]);
    expect(second.records.map((r) => r.sequence)).toEqual([3]);
    expect(second.lastSequence).toBe(3);
  });

  test("appending a stored id writes nothing and returns the stored sequence", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await exporter.append({
      executionId: "exec-1",
      records: [record("a"), record("b")],
    });
    const again = await exporter.append({
      executionId: "exec-1",
      records: [record("a", { payload: { changed: true } }), record("c")],
    });
    expect(again.records).toEqual([
      { id: "a", sequence: 1, duplicate: true },
      { id: "c", sequence: 3, duplicate: false },
    ]);
    const page = await exporter.read({ executionId: "exec-1" });
    expect(page.records.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(page.records[0]?.payload).toEqual({ id: "a" });
  });

  test("a batch with one invalid record stores nothing", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const error = await rejection(
      exporter.append({
        executionId: "exec-1",
        records: [
          record("a"),
          record("b", { payload: { f: () => 1 } as never }),
        ],
      }),
    );
    expect(
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_RECORD"),
    ).toBe(true);
    expect(
      (await exporter.read({ executionId: "exec-1" })).records,
    ).toHaveLength(0);
    const next = await exporter.append({
      executionId: "exec-1",
      records: [record("c")],
    });
    expect(next.records[0]?.sequence).toBe(1);
  });

  test("a batch with one oversized record stores nothing and leaves no sequence gap", async () => {
    const exporter = new InMemoryWorkflowEventExporter({ maxRecordBytes: 400 });
    const error = await rejection(
      exporter.append({
        executionId: "exec-1",
        records: [
          record("a"),
          record("b", { payload: { t: "x".repeat(500) } }),
        ],
      }),
    );
    expect(
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE"),
    ).toBe(true);
    const next = await exporter.append({
      executionId: "exec-1",
      records: [record("z")],
    });
    expect(next.records[0]?.sequence).toBe(1);
  });

  test("concurrent appends to one execution leave a dense sequence", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await Promise.all(
      Array.from({ length: 16 }, (_, w) =>
        exporter.append({
          executionId: "exec-1",
          records: [record(`w${w}-a`), record(`w${w}-b`), record(`w${w}-c`)],
        }),
      ),
    );
    const page = await exporter.read({ executionId: "exec-1", limit: 1000 });
    expect(page.records.map((r) => r.sequence)).toEqual(
      Array.from({ length: 48 }, (_, i) => i + 1),
    );
  });

  test("sequences of different executions are independent", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await exporter.append({
      executionId: "a",
      records: [record("1", { executionId: "a" })],
    });
    const b = await exporter.append({
      executionId: "b",
      records: [record("1", { executionId: "b" })],
    });
    expect(b.records[0]?.sequence).toBe(1);
  });

  test("stored records are copies: mutating the input or output changes nothing", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const input = record("a", { payload: { nested: { v: 1 } } });
    await exporter.append({ executionId: "exec-1", records: [input] });
    (input.payload as { nested: { v: number } }).nested.v = 99;
    const first = await exporter.read({ executionId: "exec-1" });
    const stored = first.records[0] as unknown as {
      payload: { nested: { v: number } };
    };
    stored.payload.nested.v = 77;
    const second = await exporter.read({ executionId: "exec-1" });
    expect(second.records[0]?.payload).toEqual({ nested: { v: 1 } });
  });

  test("reads pages by cursor and reports hasMore", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await exporter.append({
      executionId: "exec-1",
      records: Array.from({ length: 5 }, (_, i) => record(`r${i}`)),
    });
    const first = await exporter.read({ executionId: "exec-1", limit: 2 });
    expect(first.records.map((r) => r.sequence)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    expect(first.nextAfterSequence).toBe(2);
    const last = await exporter.read({
      executionId: "exec-1",
      afterSequence: 4,
      limit: 2,
    });
    expect(last.records.map((r) => r.sequence)).toEqual([5]);
    expect(last.hasMore).toBe(false);
  });

  test("filters by kind and type without losing the cursor", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await exporter.append({
      executionId: "exec-1",
      records: [
        record("a", { kind: "workflow", type: "workflow_started" }),
        record("b", { kind: "step", type: "step_started" }),
        record("c", { kind: "step", type: "step_completed" }),
        record("d", { kind: "agent_run", type: "output" }),
        record("e", { kind: "step", type: "step_started" }),
      ],
    });
    const steps = await exporter.read({
      executionId: "exec-1",
      kinds: ["step"],
      limit: 2,
    });
    expect(steps.records.map((r) => r.id)).toEqual(["b", "c"]);
    expect(steps.hasMore).toBe(true);
    const rest = await exporter.read({
      executionId: "exec-1",
      kinds: ["step"],
      afterSequence: steps.nextAfterSequence,
    });
    expect(rest.records.map((r) => r.id)).toEqual(["e"]);
    const started = await exporter.read({
      executionId: "exec-1",
      types: ["step_started"],
    });
    expect(started.records.map((r) => r.id)).toEqual(["b", "e"]);
  });

  test("reading an unknown execution gives an empty page", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    const page = await exporter.read({ executionId: "missing" });
    expect(page).toEqual({ records: [], nextAfterSequence: 0, hasMore: false });
  });

  test("lists executions ordered by id with a cursor, with summaries", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    for (const id of ["c", "a", "b"]) {
      await exporter.append({
        executionId: id,
        records: [
          record("1", { executionId: id, timestamp: 10 }),
          record("2", { executionId: id, timestamp: 20 }),
        ],
      });
    }
    const first = await exporter.listExecutions({ limit: 2 });
    expect(first.items.map((i) => i.executionId)).toEqual(["a", "b"]);
    expect(first.items[0]).toEqual({
      executionId: "a",
      lastSequence: 2,
      firstTimestamp: 10,
      lastTimestamp: 20,
    });
    expect(first.nextCursor).toBeDefined();
    const second = await exporter.listExecutions({
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.executionId)).toEqual(["c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("prunes one execution and a later append restarts at 1", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    await exporter.append({
      executionId: "exec-1",
      records: [record("a"), record("b")],
    });
    const result = await exporter.prune({ executionId: "exec-1" });
    expect(result).toEqual({ executions: 1, records: 2, hasMore: false });
    expect(
      (await exporter.read({ executionId: "exec-1" })).records,
    ).toHaveLength(0);
    const again = await exporter.append({
      executionId: "exec-1",
      records: [record("a")],
    });
    expect(again.records[0]).toEqual({
      id: "a",
      sequence: 1,
      duplicate: false,
    });
  });

  test("prunes by age, honours the limit and reports hasMore", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    for (const [id, ts] of [
      ["old1", 5],
      ["old2", 6],
      ["new", 100],
    ] as const) {
      await exporter.append({
        executionId: id,
        records: [record("1", { executionId: id, timestamp: ts })],
      });
    }
    const first = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
    expect(first.executions).toBe(1);
    expect(first.hasMore).toBe(true);
    const second = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
    expect(second).toEqual({ executions: 1, records: 1, hasMore: false });
    const left = await exporter.listExecutions();
    expect(left.items.map((i) => i.executionId)).toEqual(["new"]);
  });

  test("an append past maxRecords rejects with a non-retryable UNAVAILABLE and evicts nothing", async () => {
    const exporter = new InMemoryWorkflowEventExporter({ maxRecords: 3 });
    await exporter.append({
      executionId: "exec-1",
      records: [record("a"), record("b")],
    });
    const error = await rejection(
      exporter.append({
        executionId: "exec-1",
        records: [record("c"), record("d")],
      }),
    );
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE")).toBe(
      true,
    );
    expect((error as { retryable: boolean }).retryable).toBe(false);
    const page = await exporter.read({ executionId: "exec-1" });
    expect(page.records.map((r) => r.id)).toEqual(["a", "b"]);
    const dup = await exporter.append({
      executionId: "exec-1",
      records: [record("a")],
    });
    expect(dup.records[0]?.duplicate).toBe(true);
  });

  test.each([0, -1, 1.5])("rejects maxRecords %p", (maxRecords) => {
    let error: unknown;
    try {
      new InMemoryWorkflowEventExporter({ maxRecords });
    } catch (caught) {
      error = caught;
    }
    expect(
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
    ).toBe(true);
  });

  test("healthCheck is ok and close makes later calls reject with CLOSED", async () => {
    const exporter = new InMemoryWorkflowEventExporter();
    expect((await exporter.healthCheck()).ok).toBe(true);
    await exporter.close();
    const error = await rejection(exporter.read({ executionId: "exec-1" }));
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_CLOSED")).toBe(true);
  });
});
