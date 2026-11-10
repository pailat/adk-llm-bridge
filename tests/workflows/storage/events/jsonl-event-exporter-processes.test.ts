import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import { JsonlWorkflowEventExporter } from "../../../../src/workflows/storage/jsonl-event-exporter.js";

const child = join(import.meta.dir, "fixtures", "jsonl-writer-child.ts");
const directories: string[] = [];
const processes: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  for (const proc of processes.splice(0)) {
    try {
      proc.kill(9);
    } catch {
      // Already gone.
    }
    await proc.exited;
  }
  for (const dir of directories.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jsonl-events-proc-"));
  directories.push(dir);
  return dir;
}

function spawnChild(mode: string, directory: string, executionId: string) {
  const proc = Bun.spawn(
    [process.execPath, child, mode, directory, executionId],
    { stdout: "pipe", stderr: "pipe", stdin: "pipe" },
  );
  processes.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines: string[] = [];
  async function nextLine(timeoutMs = 20_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        return line;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining),
        ),
      ]);
      if (result === null) return undefined;
      if (result.done) return undefined;
      buffer += decoder.decode(result.value);
    }
  }
  return { proc, nextLine, lines };
}

async function stderrOf(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  return await new Response(proc.stderr as ReadableStream).text();
}

describe("JsonlWorkflowEventExporter across processes", () => {
  test("after SIGKILL during appends, recovery leaves a contiguous sequence that holds every acknowledged record", async () => {
    const directory = await tempDirectory();
    const { proc, nextLine } = spawnChild("loop", directory, "exec-kill");
    let acked = 0;
    while (acked < 40) {
      const line = await nextLine();
      if (line === undefined) {
        throw new Error(`child stopped early: ${await stderrOf(proc)}`);
      }
      const match = /^acked (\d+)$/.exec(line);
      if (match) acked = Number(match[1]);
    }
    proc.kill(9);
    await proc.exited;

    const exporter = new JsonlWorkflowEventExporter({ directory });
    try {
      const sequences: number[] = [];
      let after = 0;
      for (;;) {
        const page = await exporter.read({
          executionId: "exec-kill",
          afterSequence: after,
          limit: 1000,
        });
        sequences.push(...page.records.map((r) => r.sequence));
        after = page.nextAfterSequence;
        if (!page.hasMore) break;
      }
      expect(sequences.length).toBeGreaterThanOrEqual(acked);
      expect(sequences).toEqual(sequences.map((_, i) => i + 1));

      const next = await exporter.append({
        executionId: "exec-kill",
        records: [
          {
            id: "after-kill",
            executionId: "exec-kill",
            kind: "workflow",
            type: "custom",
            timestamp: 1,
            payload: {},
          },
        ],
      });
      expect(next.records[0]?.sequence).toBe(sequences.length + 1);
    } finally {
      await exporter.close();
    }

    // The file ends with a complete line and every line parses.
    const files = (await readdir(directory)).filter((f) =>
      f.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const text = await readFile(join(directory, files[0] as string), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.trimEnd().split("\n")) JSON.parse(line);
  }, 60_000);

  test("a second process writing the same directory is refused while the first holds it", async () => {
    const directory = await tempDirectory();
    const first = new JsonlWorkflowEventExporter({ directory });
    await first.append({
      executionId: "exec-lock",
      records: [
        {
          id: "a",
          executionId: "exec-lock",
          kind: "workflow",
          type: "custom",
          timestamp: 1,
          payload: {},
        },
      ],
    });
    const second = spawnChild("once", directory, "exec-lock");
    expect(await second.nextLine()).toBe(
      "refused WORKFLOW_STORAGE_UNAVAILABLE",
    );
    await second.proc.exited;

    const page = await first.read({ executionId: "exec-lock" });
    expect(page.records).toHaveLength(1);

    await first.close();
    const third = spawnChild("once", directory, "exec-lock");
    expect(await third.nextLine()).toBe("ok 2");
    await third.proc.exited;
  }, 60_000);

  test("a parent writer is refused while a child process holds the directory, and works after the child is killed", async () => {
    const directory = await tempDirectory();
    const holder = spawnChild("hold", directory, "exec-hold");
    expect(await holder.nextLine()).toBe("holding");

    const blocked = new JsonlWorkflowEventExporter({ directory });
    let error: unknown;
    try {
      await blocked.append({
        executionId: "exec-hold",
        records: [
          {
            id: "p",
            executionId: "exec-hold",
            kind: "workflow",
            type: "custom",
            timestamp: 1,
            payload: {},
          },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(isWorkflowStorageError(error, "WORKFLOW_STORAGE_UNAVAILABLE")).toBe(
      true,
    );
    await blocked.close();

    holder.proc.kill(9);
    await holder.proc.exited;

    // The dead process left its lock file behind; a new writer takes over.
    const after = new JsonlWorkflowEventExporter({ directory });
    try {
      const result = await after.append({
        executionId: "exec-hold",
        records: [
          {
            id: "q",
            executionId: "exec-hold",
            kind: "workflow",
            type: "custom",
            timestamp: 1,
            payload: {},
          },
        ],
      });
      expect(result.records[0]?.sequence).toBe(2);
    } finally {
      await after.close();
    }
  }, 60_000);

  test("two child processes started together: exactly one writes", async () => {
    const directory = await tempDirectory();
    const a = spawnChild("hold", directory, "exec-race");
    const b = spawnChild("hold", directory, "exec-race");
    const [lineA, lineB] = await Promise.all([a.nextLine(), b.nextLine()]);
    const results = [lineA, lineB].sort();
    expect(results).toEqual([
      "holding",
      "refused WORKFLOW_STORAGE_UNAVAILABLE",
    ]);
  }, 60_000);
});
