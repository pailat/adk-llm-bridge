import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineWorkflowStorageConformanceTests,
  type WorkflowStorageConformanceCase,
  workflowEventExporterConformanceCases,
} from "../../../../src/workflows/storage/conformance/index.js";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import type { WorkflowEventRecordInput } from "../../../../src/workflows/storage/event-exporter.js";
import {
  JsonlWorkflowEventExporter,
  WORKFLOW_EVENT_JSONL_FORMAT,
  WORKFLOW_EVENT_JSONL_FORMAT_VERSION,
} from "../../../../src/workflows/storage/jsonl-event-exporter.js";

const created: string[] = [];
const open: JsonlWorkflowEventExporter[] = [];

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jsonl-events-"));
  created.push(dir);
  return dir;
}

function exporterOver(
  directory: string,
  options: { sync?: "batch" | "none"; maxRecordBytes?: number } = {},
): JsonlWorkflowEventExporter {
  const exporter = new JsonlWorkflowEventExporter({ directory, ...options });
  open.push(exporter);
  return exporter;
}

afterEach(async () => {
  for (const exporter of open.splice(0)) await exporter.close().catch(() => {});
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

function fileFor(directory: string, executionId: string): string {
  const name = createHash("sha256").update(executionId).digest("hex");
  return join(directory, `${name}.jsonl`);
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

const directories = new Map<JsonlWorkflowEventExporter, string>();

function reopenOver(exporter: unknown): JsonlWorkflowEventExporter {
  const directory = directories.get(exporter as JsonlWorkflowEventExporter);
  if (!directory) throw new Error("unknown exporter");
  return exporterOver(directory);
}

// The stub throws while the suite is missing; an empty list keeps the file
// collectable so each test below reports its own failure.
const cases: WorkflowStorageConformanceCase[] =
  await workflowEventExporterConformanceCases({
    createExporter: async () => {
      const directory = await tempDirectory();
      const exporter = exporterOver(directory);
      directories.set(exporter, directory);
      return exporter;
    },
    reopenExporter: (exporter) => reopenOver(exporter),
    destroyExporter: async (exporter) => {
      const directory = directories.get(exporter as JsonlWorkflowEventExporter);
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  }).catch(() => []);

describe("workflowEventExporterConformanceCases over the JSONL exporter with reopen", () => {
  test("builds the cases and enables the reopen cases for a durable exporter", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    const reopen = cases.filter((c) => /reopen/i.test(c.name));
    expect(reopen.length).toBeGreaterThan(0);
    for (const reopenCase of reopen) expect(reopenCase.skip).toBeUndefined();
  });
  defineWorkflowStorageConformanceTests(cases, { test, skip: test.skip });
});

describe("JsonlWorkflowEventExporter construction and layout", () => {
  test("declares durable, single-process, listing and pruning", () => {
    const exporter = exporterOver("/tmp/does-not-matter");
    expect(exporter.providerName).toBe("jsonl");
    expect(exporter.capabilities).toEqual({
      durable: true,
      multiProcess: false,
      listing: true,
      pruning: true,
      maxRecordBytes: 256 * 1024,
    });
  });

  test("rejects a relative directory", () => {
    let error: unknown;
    try {
      new JsonlWorkflowEventExporter({ directory: "relative/dir" });
    } catch (caught) {
      error = caught;
    }
    expect(
      isWorkflowStorageError(error, "WORKFLOW_STORAGE_INVALID_OPTION"),
    ).toBe(true);
  });

  test("touches no file until the first call", async () => {
    const parent = await tempDirectory();
    const directory = join(parent, "events");
    exporterOver(directory);
    expect(await readdir(parent)).toEqual([]);
  });

  test("creates the directory with mode 0700 and one file per execution with mode 0600 named by SHA-256", async () => {
    const parent = await tempDirectory();
    const directory = join(parent, "events");
    const exporter = exporterOver(directory);
    await exporter.append({
      executionId: "exec-a",
      records: [record("exec-a", "1")],
    });
    await exporter.append({
      executionId: "exec-b",
      records: [record("exec-b", "1")],
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const files = (await readdir(directory))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    const expected = ["exec-a", "exec-b"]
      .map((id) => `${createHash("sha256").update(id).digest("hex")}.jsonl`)
      .sort();
    expect(files).toEqual(expected);
    for (const file of files) {
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    for (const file of await readdir(directory)) {
      expect((await stat(join(directory, file))).mode & 0o077).toBe(0);
    }
  });

  test("writes a header line with format, version and execution id, then one line per record", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a"), record("exec-1", "b")],
    });
    const lines = (await readFile(fileFor(directory, "exec-1"), "utf8"))
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0] as string);
    expect(header.format).toBe(WORKFLOW_EVENT_JSONL_FORMAT);
    expect(header.formatVersion).toBe(WORKFLOW_EVENT_JSONL_FORMAT_VERSION);
    expect(header.executionId).toBe("exec-1");
    expect(JSON.parse(lines[1] as string)).toMatchObject({
      id: "a",
      sequence: 1,
    });
    expect(JSON.parse(lines[2] as string)).toMatchObject({
      id: "b",
      sequence: 2,
    });
  });

  test("a stored id writes nothing: the file bytes are unchanged", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    const before = await readFile(fileFor(directory, "exec-1"));
    const again = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a", { payload: { other: 1 } })],
    });
    expect(again.records).toEqual([{ id: "a", sequence: 1, duplicate: true }]);
    expect(
      Buffer.compare(await readFile(fileFor(directory, "exec-1")), before),
    ).toBe(0);
  });

  test("a rejected batch leaves the file without any of its records", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory, { maxRecordBytes: 400 });
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    const before = await readFile(fileFor(directory, "exec-1"));
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [
          record("exec-1", "b"),
          record("exec-1", "c", { payload: { t: "x".repeat(600) } }),
        ],
      }),
      "WORKFLOW_STORAGE_PAYLOAD_TOO_LARGE",
    );
    expect(
      Buffer.compare(await readFile(fileFor(directory, "exec-1")), before),
    ).toBe(0);
  });

  test("sync none stores and reads records", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory, { sync: "none" });
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    expect(
      (await exporter.read({ executionId: "exec-1" })).records,
    ).toHaveLength(1);
  });

  test("keeps multi-byte payloads intact", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    const payload = { text: "héllo 世界 🙂 line\nbreak" };
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a", { payload })],
    });
    const page = await exporter.read({ executionId: "exec-1" });
    expect(page.records[0]?.payload).toEqual(payload);
    expect(
      (await readFile(fileFor(directory, "exec-1"), "utf8"))
        .trimEnd()
        .split("\n"),
    ).toHaveLength(2);
  });
});

describe("JsonlWorkflowEventExporter symbolic links", () => {
  test("refuses a directory that is a symbolic link", async () => {
    const parent = await tempDirectory();
    const real = join(parent, "real");
    await mkdir(real);
    const link = join(parent, "link");
    await symlink(real, link);
    const exporter = exporterOver(link);
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("exec-1", "a")],
      }),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(await readdir(real)).toEqual([]);
  });

  test("refuses an execution file that is a symbolic link and writes nothing through it", async () => {
    const directory = await tempDirectory();
    const outside = join(await tempDirectory(), "target.jsonl");
    await writeFile(outside, "untouched\n");
    await symlink(outside, fileFor(directory, "exec-1"));
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("exec-1", "a")],
      }),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    expect(await readFile(outside, "utf8")).toBe("untouched\n");
  });

  test("refuses a dangling symbolic link in place of the execution file", async () => {
    const directory = await tempDirectory();
    const outside = join(await tempDirectory(), "missing.jsonl");
    await symlink(outside, fileFor(directory, "exec-1"));
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("exec-1", "a")],
      }),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
    await expect(stat(outside)).rejects.toThrow();
  });

  test("reading through a symbolic link is refused too", async () => {
    const directory = await tempDirectory();
    const outside = join(await tempDirectory(), "target.jsonl");
    await writeFile(outside, "x\n");
    await symlink(outside, fileFor(directory, "exec-1"));
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_UNSAFE_PATH",
    );
  });
});

describe("JsonlWorkflowEventExporter recovery", () => {
  async function seed(directory: string, count: number) {
    const first = exporterOver(directory);
    await first.append({
      executionId: "exec-1",
      records: Array.from({ length: count }, (_, i) =>
        record("exec-1", `r${i + 1}`),
      ),
    });
    await first.close();
  }

  test("a last line cut short by a kill is removed and the sequence continues without a gap", async () => {
    const directory = await tempDirectory();
    await seed(directory, 3);
    const file = fileFor(directory, "exec-1");
    const intact = await readFile(file);
    await appendFile(
      file,
      '{"id":"torn","executionId":"exec-1","kind":"workflow","type":"cus',
    );

    const exporter = exporterOver(directory);
    const page = await exporter.read({ executionId: "exec-1" });
    expect(page.records.map((r) => r.sequence)).toEqual([1, 2, 3]);
    const next = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "r4")],
    });
    expect(next.records[0]?.sequence).toBe(4);
    const after = await readFile(file, "utf8");
    expect(after.startsWith(intact.toString("utf8"))).toBe(true);
    expect(after).not.toContain("torn");
    for (const line of after.trimEnd().split("\n")) JSON.parse(line);
  });

  test("a torn last line is removed when the exporter first appends, not only when it reads", async () => {
    const directory = await tempDirectory();
    await seed(directory, 2);
    const file = fileFor(directory, "exec-1");
    await appendFile(file, '{"id":"torn"');
    const exporter = exporterOver(directory);
    const result = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "r3")],
    });
    expect(result.records[0]?.sequence).toBe(3);
    expect(await readFile(file, "utf8")).not.toContain("torn");
  });

  test("a last line with no newline that is cut inside a multi-byte character is removed", async () => {
    const directory = await tempDirectory();
    await seed(directory, 1);
    const file = fileFor(directory, "exec-1");
    const full = Buffer.from('{"id":"torn","payload":{"t":"世界"}}');
    await appendFile(file, full.subarray(0, full.length - 8));
    const exporter = exporterOver(directory);
    const page = await exporter.read({ executionId: "exec-1" });
    expect(page.records).toHaveLength(1);
  });

  test("a file that holds only part of its header is removed and recreated", async () => {
    const directory = await tempDirectory();
    const file = fileFor(directory, "exec-1");
    await writeFile(file, '{"format":"adk-llm-b', { mode: 0o600 });
    const exporter = exporterOver(directory);
    const result = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    expect(result.records[0]?.sequence).toBe(1);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(JSON.parse(lines[0] as string).format).toBe(
      WORKFLOW_EVENT_JSONL_FORMAT,
    );
  });

  test("a stored id is still a duplicate after the exporter is reopened", async () => {
    const directory = await tempDirectory();
    await seed(directory, 2);
    const exporter = exporterOver(directory);
    const result = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "r2"), record("exec-1", "r3")],
    });
    expect(result.records).toEqual([
      { id: "r2", sequence: 2, duplicate: true },
      { id: "r3", sequence: 3, duplicate: false },
    ]);
  });

  test("a malformed line in the middle is WORKFLOW_STORAGE_CORRUPT for read and append", async () => {
    const directory = await tempDirectory();
    await seed(directory, 3);
    const file = fileFor(directory, "exec-1");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    lines[2] = '{"this is not json';
    await writeFile(file, `${lines.join("\n")}\n`);
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
    const second = exporterOver(directory);
    await expectCode(
      second.append({
        executionId: "exec-1",
        records: [record("exec-1", "z")],
      }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
    expect(await readFile(file, "utf8")).toContain('{"this is not json');
  });

  test("a malformed complete last line (ends with a newline) is corrupt, not torn", async () => {
    const directory = await tempDirectory();
    await seed(directory, 2);
    const file = fileFor(directory, "exec-1");
    await appendFile(file, "not json at all\n");
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("a sequence gap in the file is corrupt", async () => {
    const directory = await tempDirectory();
    await seed(directory, 3);
    const file = fileFor(directory, "exec-1");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    lines.splice(2, 1);
    await writeFile(file, `${lines.join("\n")}\n`);
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("a header with another format name is corrupt", async () => {
    const directory = await tempDirectory();
    await writeFile(
      fileFor(directory, "exec-1"),
      `${JSON.stringify({ format: "something-else", formatVersion: 1, executionId: "exec-1" })}\n`,
      { mode: 0o600 },
    );
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("a file with a newer format version is refused and never rewritten", async () => {
    const directory = await tempDirectory();
    const file = fileFor(directory, "exec-1");
    const content = `${JSON.stringify({
      format: WORKFLOW_EVENT_JSONL_FORMAT,
      formatVersion: WORKFLOW_EVENT_JSONL_FORMAT_VERSION + 1,
      executionId: "exec-1",
    })}\n`;
    await writeFile(file, content, { mode: 0o600 });
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
    );
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("exec-1", "a")],
      }),
      "WORKFLOW_STORAGE_SCHEMA_UNSUPPORTED",
    );
    expect(await readFile(file, "utf8")).toBe(content);
  });

  test("a file whose header names a different execution is corrupt", async () => {
    const directory = await tempDirectory();
    await writeFile(
      fileFor(directory, "exec-1"),
      `${JSON.stringify({
        format: WORKFLOW_EVENT_JSONL_FORMAT,
        formatVersion: 1,
        executionId: "someone-else",
      })}\n`,
      { mode: 0o600 },
    );
    const exporter = exporterOver(directory);
    await expectCode(
      exporter.read({ executionId: "exec-1" }),
      "WORKFLOW_STORAGE_CORRUPT",
    );
  });

  test("healthCheck is ok for an empty directory and names the provider", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    const health = await exporter.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("jsonl");
  });
});

describe("JsonlWorkflowEventExporter version-1 fixture", () => {
  // A version-1 file as an earlier build wrote it, committed as a file so a
  // later edit of this test cannot change it. The execution id is "legacy-exec".
  const fixture = () =>
    readFile(new URL("./fixtures/legacy-v1.jsonl", import.meta.url), "utf8");

  test("still reads, lists and continues the sequence", async () => {
    const directory = await tempDirectory();
    await writeFile(fileFor(directory, "legacy-exec"), await fixture(), {
      mode: 0o600,
    });
    const exporter = exporterOver(directory);
    const page = await exporter.read({ executionId: "legacy-exec" });
    expect(page.records.map((r) => [r.id, r.sequence])).toEqual([
      ["evt-1", 1],
      ["evt-2", 2],
      ["span:abc", 3],
    ]);
    expect(page.records[1]?.payload).toEqual({ text: "héllo 世界" });
    expect(page.records[1]?.stepId).toBe("s1");
    expect(page.records[2]?.clipped?.paths).toEqual(["/name"]);
    const list = await exporter.listExecutions();
    expect(list.items).toEqual([
      {
        executionId: "legacy-exec",
        lastSequence: 3,
        firstTimestamp: 1700000000000,
        lastTimestamp: 1700000000200,
      },
    ]);
    const next = await exporter.append({
      executionId: "legacy-exec",
      records: [record("legacy-exec", "evt-2"), record("legacy-exec", "evt-4")],
    });
    expect(next.records).toEqual([
      { id: "evt-2", sequence: 2, duplicate: true },
      { id: "evt-4", sequence: 4, duplicate: false },
    ]);
  });
});

describe("JsonlWorkflowEventExporter listing and pruning", () => {
  test("lists executions by id in pages and ignores files that are not event files", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    for (const id of ["c", "a", "b"]) {
      await exporter.append({
        executionId: id,
        records: [
          record(id, "1", { timestamp: 5 }),
          record(id, "2", { timestamp: 9 }),
        ],
      });
    }
    await writeFile(join(directory, "notes.txt"), "hello");
    await writeFile(join(directory, "zzz.jsonl"), "not an event file\n");
    const first = await exporter.listExecutions({ limit: 2 });
    expect(first.items.map((i) => i.executionId)).toEqual(["a", "b"]);
    expect(first.items[0]).toEqual({
      executionId: "a",
      lastSequence: 2,
      firstTimestamp: 5,
      lastTimestamp: 9,
    });
    const second = await exporter.listExecutions({
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.executionId)).toEqual(["c"]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("prune removes the execution's file and the next append starts at 1", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a"), record("exec-1", "b")],
    });
    const result = await exporter.prune({ executionId: "exec-1" });
    expect(result).toEqual({ executions: 1, records: 2, hasMore: false });
    await expect(stat(fileFor(directory, "exec-1"))).rejects.toThrow();
    const again = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    expect(again.records[0]).toEqual({
      id: "a",
      sequence: 1,
      duplicate: false,
    });
  });

  test("prune by age removes only old executions, honours the limit and reports hasMore", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    for (const [id, ts] of [
      ["old1", 5],
      ["old2", 6],
      ["new", 100],
    ] as const) {
      await exporter.append({
        executionId: id,
        records: [record(id, "1", { timestamp: ts })],
      });
    }
    const first = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
    expect(first.executions).toBe(1);
    expect(first.hasMore).toBe(true);
    const second = await exporter.prune({ lastRecordBefore: 50, limit: 1 });
    expect(second.hasMore).toBe(false);
    const left = await exporter.listExecutions();
    expect(left.items.map((i) => i.executionId)).toEqual(["new"]);
  });

  test("pruning an execution that does not exist deletes nothing", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    expect(await exporter.prune({ executionId: "none" })).toEqual({
      executions: 0,
      records: 0,
      hasMore: false,
    });
  });
});

describe("JsonlWorkflowEventExporter writer lock", () => {
  test("a lock with this process's pid and a token it does not hold is stale", async () => {
    const directory = await tempDirectory();
    await writeFile(
      join(directory, ".writer.lock"),
      JSON.stringify({ pid: process.pid, token: "left-by-an-earlier-run" }),
      { mode: 0o600 },
    );
    const exporter = exporterOver(directory);
    const result = await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    expect(result.records[0]?.sequence).toBe(1);
  });

  test("a health check does not take the writer lock", async () => {
    const directory = await tempDirectory();
    const monitor = exporterOver(directory);
    expect((await monitor.healthCheck()).ok).toBe(true);
    const writer = exporterOver(directory);
    const result = await writer.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    expect(result.records[0]?.sequence).toBe(1);
  });
});

describe("JsonlWorkflowEventExporter close", () => {
  test("close releases the directory so another exporter can write", async () => {
    const directory = await tempDirectory();
    const first = exporterOver(directory);
    await first.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    const second = exporterOver(directory);
    await expectCode(
      second.append({
        executionId: "exec-1",
        records: [record("exec-1", "b")],
      }),
      "WORKFLOW_STORAGE_UNAVAILABLE",
    );
    await first.close();
    const result = await second.append({
      executionId: "exec-1",
      records: [record("exec-1", "b")],
    });
    expect(result.records[0]?.sequence).toBe(2);
  });

  test("operations after close reject with CLOSED", async () => {
    const directory = await tempDirectory();
    const exporter = exporterOver(directory);
    await exporter.append({
      executionId: "exec-1",
      records: [record("exec-1", "a")],
    });
    await exporter.close();
    await expectCode(
      exporter.append({
        executionId: "exec-1",
        records: [record("exec-1", "b")],
      }),
      "WORKFLOW_STORAGE_CLOSED",
    );
  });
});
