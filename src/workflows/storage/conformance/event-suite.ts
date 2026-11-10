import { isWorkflowStorageError } from "../errors.js";
import type {
  BaseWorkflowEventExporter,
  BaseWorkflowEventExporterOptions,
  WorkflowEventRecordInput,
} from "../event-exporter.js";
import type { WorkflowStorageOperationMetric } from "../support.js";
import {
  type WorkflowStorageConformanceCase,
  WorkflowStorageConformanceFailure,
} from "./harness.js";

/**
 * Options of {@link workflowEventExporterConformanceCases}.
 *
 * @experimental
 */
export interface WorkflowEventExporterConformanceOptions {
  /** Creates an exporter over new, empty storage. Called once per case. */
  createExporter: () =>
    | BaseWorkflowEventExporter
    | Promise<BaseWorkflowEventExporter>;
  /**
   * Creates a second exporter instance over the storage of `exporter`.
   * Needed for the durability and multi-writer cases; without it they are
   * skipped. When `multiProcess` is `false` the suite closes the first
   * instance before it reopens.
   */
  reopenExporter?: (
    exporter: BaseWorkflowEventExporter,
  ) => BaseWorkflowEventExporter | Promise<BaseWorkflowEventExporter>;
  /**
   * Removes the storage of an exporter after its case. The suite closes the
   * exporter first.
   */
  destroyExporter?: (
    exporter: BaseWorkflowEventExporter,
  ) => void | Promise<void>;
  /**
   * Number of concurrent writers in the sequence cases.
   *
   * @defaultValue 8
   */
  workers?: number;
}

/**
 * Builds the conformance cases of the event exporter contract, version
 * `WORKFLOW_EVENT_EXPORTER_CONTRACT_VERSION`.
 *
 * @remarks
 * The cases cover: sequences that start at 1 and grow by one; a batch stored
 * in input order; a repeated id that stores nothing and reports
 * `duplicate: true`; a retried batch that is partly stored; N concurrent
 * writers on one execution leaving a sequence without gaps or repeats;
 * independent sequences per execution; a batch with an invalid or oversized
 * record storing nothing; payloads returned deep-equal; cursor reads that
 * visit every record once in ascending order, with kind and type filters;
 * listing and pruning when their flags are `true`, and
 * `WORKFLOW_STORAGE_UNSUPPORTED` when they are `false`; survival of a reopen
 * with the sequence continuing when `durable` is `true`; the health check;
 * `WORKFLOW_STORAGE_CLOSED` after `close`; and one metric per operation
 * without ids or payloads.
 *
 * @param options - How to create, reopen and destroy the exporter.
 * @returns The cases, with `skip` set on those the flags exclude.
 *
 * @experimental
 */
export async function workflowEventExporterConformanceCases(
  options: WorkflowEventExporterConformanceOptions,
): Promise<WorkflowStorageConformanceCase[]> {
  const workers = options.workers ?? 8;
  const probe = await options.createExporter();
  const { durable, multiProcess, listing, pruning, maxRecordBytes } =
    probe.capabilities;
  await probe.close().catch(() => undefined);
  await options.destroyExporter?.(probe);

  const reopen = options.reopenExporter;
  const skipReopen =
    reopen === undefined
      ? "reopenExporter was not given"
      : durable
        ? undefined
        : "capabilities.durable is false";
  const skipMultiWriter =
    reopen === undefined
      ? "reopenExporter was not given"
      : multiProcess
        ? undefined
        : "capabilities.multiProcess is false";
  const skipListing = listing ? undefined : "capabilities.listing is false";
  const skipNoListing = listing ? "capabilities.listing is true" : undefined;
  const skipPruning = pruning ? undefined : "capabilities.pruning is false";
  const skipNoPruning = pruning ? "capabilities.pruning is true" : undefined;

  /** Runs a body over a fresh exporter and always closes and destroys it. */
  const scenario = (
    body: (context: Context) => Promise<void>,
    skip?: string,
  ): Pick<WorkflowStorageConformanceCase, "run" | "skip"> => ({
    ...(skip === undefined ? {} : { skip }),
    async run() {
      const exporter = await options.createExporter();
      const opened: BaseWorkflowEventExporter[] = [exporter];
      const context: Context = {
        exporter,
        async reopen(previous) {
          if (!reopen) throw new Error("reopenExporter was not given");
          if (!multiProcess) await previous.close();
          const next = await reopen(previous);
          opened.push(next);
          return next;
        },
      };
      try {
        await body(context);
      } finally {
        for (const instance of opened.reverse()) {
          await instance.close().catch(() => undefined);
        }
        await options.destroyExporter?.(exporter);
      }
    },
  });

  const cases: WorkflowStorageConformanceCase[] = [
    {
      name: "sequences start at 1 and grow by one across batches",
      ...scenario(async ({ exporter }) => {
        const first = await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const second = await exporter.append({
          executionId: "e1",
          records: [record("e1", "c")],
        });
        same(
          first.records.map((r) => r.sequence),
          [1, 2],
          "sequences of the first batch",
        );
        same(
          second.records.map((r) => r.sequence),
          [3],
          "sequence of the second batch",
        );
        same(second.lastSequence, 3, "lastSequence after two batches");
        same(
          first.records.every((r) => !r.duplicate),
          true,
          "new records are not duplicates",
        );
      }),
    },
    {
      name: "a batch is stored in input order",
      ...scenario(async ({ exporter }) => {
        const ids = ["z", "m", "a", "q"];
        await exporter.append({
          executionId: "e1",
          records: ids.map((id) => record("e1", id)),
        });
        const page = await exporter.read({ executionId: "e1" });
        same(
          page.records.map((r) => [r.id, r.sequence]),
          ids.map((id, index) => [id, index + 1]),
          "stored order",
        );
      }),
    },
    {
      name: "an empty batch stores nothing and reports the last sequence",
      ...scenario(async ({ exporter }) => {
        const before = await exporter.append({
          executionId: "e1",
          records: [record("e1", "a")],
        });
        const empty = await exporter.append({ executionId: "e1", records: [] });
        same(empty.records.length, 0, "records of an empty batch");
        same(empty.lastSequence, before.lastSequence, "lastSequence");
      }),
    },
    {
      name: "a repeated id stores nothing and reports the stored sequence with duplicate true",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const again = await exporter.append({
          executionId: "e1",
          records: [record("e1", "b", { payload: { changed: true } })],
        });
        same(
          again.records,
          [{ id: "b", sequence: 2, duplicate: true }],
          "result",
        );
        same(again.lastSequence, 2, "lastSequence");
        const page = await exporter.read({ executionId: "e1" });
        same(page.records.length, 2, "stored record count");
        same(page.records[1]?.payload, { id: "b" }, "first stored payload");
      }),
    },
    {
      name: "a retried batch that was partly stored adds only the new records",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const retry = await exporter.append({
          executionId: "e1",
          records: ["a", "b", "c", "d"].map((id) => record("e1", id)),
        });
        same(
          retry.records.map((r) => [r.id, r.sequence, r.duplicate]),
          [
            ["a", 1, true],
            ["b", 2, true],
            ["c", 3, false],
            ["d", 4, false],
          ],
          "retry result",
        );
      }),
    },
    {
      name: "concurrent writers on one execution leave a sequence without gaps or repeats",
      ...scenario(async ({ exporter }) => {
        const results = await Promise.all(
          Array.from({ length: workers }, (_, worker) =>
            exporter.append({
              executionId: "e1",
              records: [0, 1, 2].map((i) => record("e1", `w${worker}-${i}`)),
            }),
          ),
        );
        const page = await exporter.read({ executionId: "e1", limit: 1000 });
        same(
          page.records.map((r) => r.sequence),
          Array.from({ length: workers * 3 }, (_, i) => i + 1),
          "stored sequences",
        );
        for (const result of results) {
          const sequences = result.records.map((r) => r.sequence);
          same(
            sequences.every(
              (n, i) => i === 0 || n === (sequences[i - 1] ?? 0) + 1,
            ),
            true,
            "a batch stays contiguous and in order",
          );
        }
      }),
    },
    {
      name: "concurrent writers that repeat an id store it once",
      ...scenario(async ({ exporter }) => {
        await Promise.all(
          Array.from({ length: workers }, () =>
            exporter.append({
              executionId: "e1",
              records: [record("e1", "same-id")],
            }),
          ),
        );
        const page = await exporter.read({ executionId: "e1" });
        same(page.records.length, 1, "stored records");
      }),
    },
    {
      name: "writers in two instances keep one dense sequence",
      ...scenario(async ({ exporter, reopen: open }) => {
        const second = await open(exporter);
        await Promise.all(
          [exporter, second].flatMap((writer, w) =>
            Array.from({ length: workers }, (_, i) =>
              writer.append({
                executionId: "e1",
                records: [
                  record("e1", `i${w}-${i}-a`),
                  record("e1", `i${w}-${i}-b`),
                ],
              }),
            ),
          ),
        );
        const page = await second.read({ executionId: "e1", limit: 1000 });
        same(
          page.records.map((r) => r.sequence),
          Array.from({ length: workers * 4 }, (_, i) => i + 1),
          "stored sequences",
        );
      }, skipMultiWriter),
    },
    {
      name: "sequences of different executions are independent",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const other = await exporter.append({
          executionId: "e2",
          records: [record("e2", "a")],
        });
        same(
          other.records[0]?.sequence,
          1,
          "first sequence of the other execution",
        );
        same(
          other.records[0]?.duplicate,
          false,
          "same id in another execution",
        );
      }),
    },
    {
      name: "a batch with an invalid record stores nothing and leaves no sequence gap",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a")],
        });
        const bad: WorkflowEventRecordInput[] = [
          record("e1", "bad-fn", { payload: { f: () => 1 } as never }),
          record("e1", "bad-nan", { payload: { n: Number.NaN } }),
          record("e1", "bad-exec", { executionId: "someone-else" }),
          record("e1", "", {}),
          record("e1", "bad-kind", { kind: "nope" as never }),
        ];
        for (const invalid of bad) {
          await rejects(
            exporter.append({
              executionId: "e1",
              records: [record("e1", "ok"), invalid],
            }),
            "WORKFLOW_STORAGE_INVALID_RECORD",
          );
        }
        const next = await exporter.append({
          executionId: "e1",
          records: [record("e1", "b")],
        });
        same(next.records[0]?.sequence, 2, "next sequence");
        const page = await exporter.read({ executionId: "e1" });
        same(
          page.records.map((r) => r.id),
          ["a", "b"],
          "stored ids",
        );
      }),
    },
    {
      name: "a batch with an oversized record stores nothing and leaves no sequence gap",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a")],
        });
        await rejects(
          exporter.append({
            executionId: "e1",
            records: [
              record("e1", "small"),
              record("e1", "big", {
                payload: { text: "x".repeat(maxRecordBytes + 16) },
              }),
            ],
          }),
          "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
        );
        const next = await exporter.append({
          executionId: "e1",
          records: [record("e1", "b")],
        });
        same(next.records[0]?.sequence, 2, "next sequence");
      }),
    },
    {
      name: "payloads and envelope fields are returned deep-equal",
      ...scenario(async ({ exporter }) => {
        const full = record("e1", "full", {
          kind: "step",
          type: "step_completed",
          timestamp: 1_700_000_000_123,
          workflowId: "wf",
          stepId: "s1",
          attempt: 2,
          agentName: "agent",
          invocationId: "inv",
          traceId: "t",
          spanId: "sp",
          parentSpanId: "ps",
          payload: {
            text: 'héllo 世界 🙂\nline "quoted"',
            nested: { list: [1, 2.5, null, true, { deep: "x" }] },
            empty: {},
          },
          clipped: {
            originalBytes: 999,
            sha256: "ab",
            paths: ["/text"],
            payloadDropped: false,
            reference: { store: "adk-artifact", key: "k", version: 1 },
          },
        });
        await exporter.append({ executionId: "e1", records: [full] });
        const page = await exporter.read({ executionId: "e1" });
        same(page.records[0], { ...full, sequence: 1 }, "stored record");
      }),
    },
    {
      name: "cursor reads visit every record once in ascending order",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: Array.from({ length: 10 }, (_, i) => record("e1", `r${i}`)),
        });
        const seen: number[] = [];
        let after = 0;
        for (let pages = 0; pages < 20; pages += 1) {
          const page = await exporter.read({
            executionId: "e1",
            afterSequence: after,
            limit: 3,
          });
          seen.push(...page.records.map((r) => r.sequence));
          after = page.nextAfterSequence;
          if (!page.hasMore) break;
        }
        same(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "sequences visited");
        const empty = await exporter.read({
          executionId: "e1",
          afterSequence: 10,
        });
        same(empty.records.length, 0, "records past the end");
        same(empty.hasMore, false, "hasMore past the end");
      }),
    },
    {
      name: "kind and type filters keep ascending order and the cursor",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [
            record("e1", "a", { kind: "workflow", type: "workflow_started" }),
            record("e1", "b", { kind: "step", type: "step_started" }),
            record("e1", "c", { kind: "step", type: "step_completed" }),
            record("e1", "d", { kind: "agent_run", type: "output" }),
            record("e1", "e", { kind: "step", type: "step_started" }),
          ],
        });
        const steps = await exporter.read({
          executionId: "e1",
          kinds: ["step"],
          limit: 2,
        });
        same(
          steps.records.map((r) => r.id),
          ["b", "c"],
          "first page of steps",
        );
        same(steps.hasMore, true, "hasMore of the first page");
        const rest = await exporter.read({
          executionId: "e1",
          kinds: ["step"],
          afterSequence: steps.nextAfterSequence,
        });
        same(
          rest.records.map((r) => r.id),
          ["e"],
          "rest of the steps",
        );
        const started = await exporter.read({
          executionId: "e1",
          types: ["step_started", "output"],
        });
        same(
          started.records.map((r) => r.id),
          ["b", "d", "e"],
          "type filter",
        );
      }),
    },
    {
      name: "reading an execution without records gives an empty page",
      ...scenario(async ({ exporter }) => {
        const page = await exporter.read({ executionId: "missing" });
        same(page.records.length, 0, "records");
        same(page.hasMore, false, "hasMore");
        same(page.nextAfterSequence, 0, "cursor");
      }),
    },
    {
      name: "list orders executions by id with pages and summaries",
      ...scenario(async ({ exporter }) => {
        for (const id of ["c", "a", "b"]) {
          await exporter.append({
            executionId: id,
            records: [
              record(id, "1", { timestamp: 10 }),
              record(id, "2", { timestamp: 20 }),
            ],
          });
        }
        const first = await exporter.listExecutions({ limit: 2 });
        same(
          first.items.map((i) => i.executionId),
          ["a", "b"],
          "first page",
        );
        same(
          first.items[0],
          {
            executionId: "a",
            lastSequence: 2,
            firstTimestamp: 10,
            lastTimestamp: 20,
          },
          "summary",
        );
        const second = await exporter.listExecutions({
          limit: 2,
          cursor: first.nextCursor,
        });
        same(
          second.items.map((i) => i.executionId),
          ["c"],
          "second page",
        );
        same(second.nextCursor, undefined, "cursor of the last page");
      }, skipListing),
    },
    {
      name: "list rejects with UNSUPPORTED when listing is false",
      ...scenario(async ({ exporter }) => {
        await rejects(
          exporter.listExecutions(),
          "WORKFLOW_STORAGE_UNSUPPORTED",
        );
      }, skipNoListing),
    },
    {
      name: "prune removes one execution and a later append restarts at 1",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        await exporter.append({
          executionId: "e2",
          records: [record("e2", "a")],
        });
        const result = await exporter.prune({ executionId: "e1" });
        same(
          result,
          { executions: 1, records: 2, hasMore: false },
          "prune result",
        );
        same(
          (await exporter.read({ executionId: "e1" })).records.length,
          0,
          "records after prune",
        );
        same(
          (await exporter.read({ executionId: "e2" })).records.length,
          1,
          "records of another execution",
        );
        const again = await exporter.append({
          executionId: "e1",
          records: [record("e1", "a")],
        });
        same(
          again.records[0],
          { id: "a", sequence: 1, duplicate: false },
          "append after prune",
        );
      }, skipPruning),
    },
    {
      name: "prune by age removes only old executions, honours the limit and reports hasMore",
      ...scenario(async ({ exporter }) => {
        for (const [id, timestamp] of [
          ["old1", 5],
          ["old2", 6],
          ["new", 100],
        ] as const) {
          await exporter.append({
            executionId: id,
            records: [record(id, "1", { timestamp })],
          });
        }
        const first = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
        same(first.executions, 1, "executions of the first call");
        same(first.hasMore, true, "hasMore of the first call");
        const second = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
        same(second.hasMore, false, "hasMore of the second call");
        const left = await exporter.listExecutions?.().catch(() => undefined);
        if (left) {
          same(
            left.items.map((i) => i.executionId),
            ["new"],
            "left after prune",
          );
        }
        same(
          (await exporter.read({ executionId: "new" })).records.length,
          1,
          "records of the new execution",
        );
      }, skipPruning),
    },
    {
      name: "prune rejects with UNSUPPORTED when pruning is false",
      ...scenario(async ({ exporter }) => {
        await rejects(
          exporter.prune({ executionId: "e1" }),
          "WORKFLOW_STORAGE_UNSUPPORTED",
        );
      }, skipNoPruning),
    },
    {
      name: "records and the sequence survive a reopen",
      ...scenario(async ({ exporter, reopen: open }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const reopened = await open(exporter);
        const page = await reopened.read({ executionId: "e1" });
        same(
          page.records.map((r) => [r.id, r.sequence]),
          [
            ["a", 1],
            ["b", 2],
          ],
          "records",
        );
        const next = await reopened.append({
          executionId: "e1",
          records: [record("e1", "c")],
        });
        same(next.records[0]?.sequence, 3, "sequence after reopen");
      }, skipReopen),
    },
    {
      name: "a stored id is still a duplicate after a reopen",
      ...scenario(async ({ exporter, reopen: open }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a"), record("e1", "b")],
        });
        const reopened = await open(exporter);
        const again = await reopened.append({
          executionId: "e1",
          records: [record("e1", "b"), record("e1", "c")],
        });
        same(
          again.records,
          [
            { id: "b", sequence: 2, duplicate: true },
            { id: "c", sequence: 3, duplicate: false },
          ],
          "result after reopen",
        );
      }, skipReopen),
    },
    {
      name: "the health check is ok on usable storage and never throws",
      ...scenario(async ({ exporter }) => {
        const health = await exporter.healthCheck();
        same(health.ok, true, "health ok");
        same(health.provider, exporter.providerName, "health provider");
        same(health.latencyMs >= 0, true, "health latency");
      }),
    },
    {
      name: "every operation after close rejects with CLOSED and closing twice is harmless",
      ...scenario(async ({ exporter }) => {
        await exporter.append({
          executionId: "e1",
          records: [record("e1", "a")],
        });
        await exporter.close();
        await exporter.close();
        await rejects(
          exporter.append({ executionId: "e1", records: [record("e1", "b")] }),
          "WORKFLOW_STORAGE_CLOSED",
        );
        await rejects(
          exporter.read({ executionId: "e1" }),
          "WORKFLOW_STORAGE_CLOSED",
        );
        await rejects(exporter.flush(), "WORKFLOW_STORAGE_CLOSED");
        const health = await exporter.healthCheck();
        same(health.ok, false, "health after close");
      }),
    },
    {
      name: "each operation reports one metric without ids or payloads",
      ...scenario(async ({ exporter }) => {
        const metrics: WorkflowStorageOperationMetric[] = [];
        const shared = (
          exporter as unknown as {
            baseOptions: BaseWorkflowEventExporterOptions;
          }
        ).baseOptions;
        try {
          shared.onOperation = (metric) => metrics.push(metric);
        } catch {
          throw new WorkflowStorageConformanceFailure(
            "the exporter keeps its options frozen, so metrics cannot be observed",
          );
        }
        const id = "conformance-secret-execution";
        await exporter.append({
          executionId: id,
          records: [
            record(id, "conformance-secret-record", {
              payload: { text: "conformance-secret-text" },
            }),
          ],
        });
        await exporter.read({ executionId: id });
        await exporter.healthCheck();
        await exporter.flush();
        same(
          metrics.map((m) => m.operation),
          ["append", "read", "healthCheck", "flush"],
          "operations reported",
        );
        for (const metric of metrics) {
          same(metric.capability, "events", "metric capability");
          same(metric.provider, exporter.providerName, "metric provider");
          same(metric.outcome, "ok", "metric outcome");
          same(
            JSON.stringify(metric).includes("conformance-secret"),
            false,
            "metric content",
          );
        }
        await rejects(
          exporter.append({
            executionId: id,
            records: [record(id, "x", { executionId: "other" })],
          }),
          "WORKFLOW_STORAGE_INVALID_RECORD",
        );
        const last = metrics[metrics.length - 1];
        same(last?.outcome, "error", "outcome of a rejected append");
        same(
          last?.errorCode,
          "WORKFLOW_STORAGE_INVALID_RECORD",
          "error code of the metric",
        );
      }),
    },
  ];
  return cases;
}

interface Context {
  exporter: BaseWorkflowEventExporter;
  reopen(
    exporter: BaseWorkflowEventExporter,
  ): Promise<BaseWorkflowEventExporter>;
}

function record(
  executionId: string,
  id: string,
  overrides: Partial<WorkflowEventRecordInput> = {},
): WorkflowEventRecordInput {
  return {
    id,
    executionId,
    kind: "workflow",
    type: "custom",
    timestamp: 1,
    payload: { id },
    ...overrides,
  };
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new WorkflowStorageConformanceFailure(
      `${what}: expected ${e}, the exporter gave ${a}`,
    );
  }
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (isWorkflowStorageError(error) && error.code === code) return;
    throw new WorkflowStorageConformanceFailure(
      `expected a rejection with ${code}, the exporter rejected with ${
        isWorkflowStorageError(error) ? error.code : String(error)
      }`,
    );
  }
  throw new WorkflowStorageConformanceFailure(
    `expected a rejection with ${code}, the call resolved`,
  );
}
