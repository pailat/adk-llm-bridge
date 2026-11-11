import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWorkflowStorageError } from "../../../../src/workflows/storage/errors.js";
import { JsonlWorkflowEventExporter } from "../../../../src/workflows/storage/jsonl-event-exporter.js";
import { isBun } from "../../../utils/fixtures/runtime.js";

const child = join(import.meta.dir, "fixtures", "jsonl-writer-child.ts");
const takeoverChild = join(
  import.meta.dir,
  "fixtures",
  "jsonl-takeover-child.ts",
);
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

function spawnChild(
  mode: string,
  directory: string,
  executionId: string,
  ...extra: string[]
) {
  return spawnScript(child, mode, directory, executionId, ...extra);
}

function spawnScript(script: string, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });
  processes.push(proc);
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const lines: string[] = [];
  let pendingRead: Promise<Awaited<ReturnType<typeof reader.read>>> | undefined;
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
      // A read that lost the race is kept for the next call, so that the
      // chunk it brings is not dropped.
      pendingRead ??= reader.read();
      const result = await Promise.race([
        pendingRead,
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), remaining),
        ),
      ]);
      if (result === null) return undefined;
      pendingRead = undefined;
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

  // Skipped under Node: the child replaces `node:fs` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "a process that judged a crashed takeover stale cannot remove the claim of the process that replaced it",
    async () => {
      const deadPid = await crashedPid();
      const directory = await tempDirectory();
      await seedCrashedTakeover(directory, deadPid, "dead-writer");

      // The first process reads the claim the crashed process left and stops
      // before it acts on what it read.
      const first = spawnScript(
        takeoverChild,
        "claim",
        directory,
        "exec-claim",
      );
      expect(await first.nextLine()).toBe("paused");
      // The second process replaces that claim with its own, reads the stale
      // lock and stops before it removes it.
      const second = spawnScript(
        takeoverChild,
        "lock",
        directory,
        "exec-claim",
      );
      expect(await second.nextLine()).toBe("paused");

      send(first.proc, "go");
      const firstEarly = await first.nextLine(1_000);
      send(second.proc, "go");
      const secondResult = await second.nextLine();
      const firstResult = firstEarly ?? (await first.nextLine());
      expect([firstResult, secondResult].sort()).toEqual([
        "holding",
        "refused WORKFLOW_STORAGE_UNAVAILABLE",
      ]);
      // The first process could not act while the second held the claim.
      expect(firstEarly).toBeUndefined();
    },
    60_000,
  );

  // Skipped under Node: the child replaces `node:fs` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "a process whose view of a dead lock is outdated does not remove the lock of the writer that took over",
    async () => {
      const deadPid = await crashedPid();
      const directory = await tempDirectory();
      await seedCrashedTakeover(directory, deadPid, "dead-writer");

      // The first process reads the dead lock and stops there.
      const late = spawnScript(takeoverChild, "holder", directory, "exec-late");
      expect(await late.nextLine()).toBe("paused");
      // Another process takes the directory over completely meanwhile.
      const writer = spawnChild("hold", directory, "exec-late");
      expect(await writer.nextLine()).toBe("holding");

      send(late.proc, "go");
      expect(await late.nextLine()).toBe(
        "refused WORKFLOW_STORAGE_UNAVAILABLE",
      );
    },
    60_000,
  );

  test("a long chain of abandoned takeover claims does not lock the directory for good", async () => {
    const deadPid = await crashedPid();
    const directory = await tempDirectory();
    await seedCrashedTakeover(directory, deadPid, "dead-writer");
    // Each claim was taken over by a process that died too: 40 in a row.
    let replacedToken = "dead-writer-claimer";
    const claimTime = new Date(Date.now() - 20_000);
    for (let i = 0; i < 40; i += 1) {
      const key = createHash("sha256")
        .update(replacedToken)
        .digest("hex")
        .slice(0, 32);
      const path = join(directory, `.writer.lock.takeover-${key}`);
      replacedToken = `chain-${i}`;
      await writeFile(
        path,
        JSON.stringify({ pid: deadPid, token: replacedToken }),
        { mode: 0o600 },
      );
      await utimes(path, claimTime, claimTime);
    }

    const writer = spawnChild("once", directory, "exec-chain");
    expect(await writer.nextLine()).toMatch(/^ok /);
  }, 60_000);

  test("an old takeover claim whose process is still alive is not replaced", async () => {
    const deadPid = await crashedPid();
    const directory = await tempDirectory();
    // A live process that has been inside its takeover for longer than the
    // claim freshness limit, for example because it was paused.
    const paused = Bun.spawn([
      process.execPath,
      "-e",
      "await Bun.sleep(60_000)",
    ]);
    processes.push(paused);
    await seedCrashedTakeover(directory, deadPid, "dead-writer", paused.pid);

    const writer = spawnChild("once", directory, "exec-paused");
    expect(await writer.nextLine()).toBe(
      "refused WORKFLOW_STORAGE_UNAVAILABLE",
    );
    expect(await readdir(directory)).toContain(".writer.lock");
  }, 60_000);

  test("a fresh takeover claim is respected even when its pid is not visible here", async () => {
    const deadPid = await crashedPid();
    const directory = await tempDirectory();
    await seedCrashedTakeover(directory, deadPid, "dead-writer");
    // A claim made just now by a process this one cannot see (another pid
    // namespace on a shared volume looks the same). Its time is set a little
    // ahead so that it stays fresh for the whole wait of the writer below.
    const key = createHash("sha256")
      .update("dead-writer")
      .digest("hex")
      .slice(0, 32);
    const claimPath = join(directory, `.writer.lock.takeover-${key}`);
    const soon = new Date(Date.now() + 3_000);
    await utimes(claimPath, soon, soon);

    const writer = spawnChild("once", directory, "exec-fresh");
    expect(await writer.nextLine()).toBe(
      "refused WORKFLOW_STORAGE_UNAVAILABLE",
    );
  }, 60_000);

  // Skipped under Node: the child replaces `node:fs` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "an exporter does not replace the takeover claim of another exporter of the same process, however long that takeover takes",
    async () => {
      const deadPid = await crashedPid();
      const directory = await tempDirectory();
      await seedCrashedTakeover(directory, deadPid, "dead-writer");
      const both = spawnScript(takeoverChild, "same", directory, "exec-same");
      expect([await both.nextLine(), await both.nextLine()]).toEqual([
        "first holding",
        "second refused WORKFLOW_STORAGE_UNAVAILABLE",
      ]);
    },
    60_000,
  );

  // Skipped under Node: the child replaces `node:fs` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "two processes racing after a writer crashed inside the takeover window: exactly one writes, in every round",
    async () => {
      const deadPid = await crashedPid();
      const rounds = 12;
      for (let round = 0; round < rounds; round += 1) {
        const directory = await tempDirectory();
        await seedCrashedTakeover(directory, deadPid, `dead-writer-${round}`);

        const startAt = String(Date.now() + 400);
        const a = spawnChild("hold-at", directory, "exec-race", startAt);
        const b = spawnChild("hold-at", directory, "exec-race", startAt);
        const lines = await Promise.all([a.nextLine(), b.nextLine()]);
        expect([round, ...lines.sort()]).toEqual([
          round,
          "holding",
          "refused WORKFLOW_STORAGE_UNAVAILABLE",
        ]);
        const left = (await readdir(directory)).filter((name) =>
          name.startsWith(".writer.lock.takeover"),
        );
        expect(left).toEqual([]);
        for (const proc of [a.proc, b.proc]) {
          proc.kill(9);
          await proc.exited;
        }
      }
    },
    120_000,
  );

  // Skipped under Node: the child replaces `node:fs/promises` with `mock.module` of `bun:test`.
  test.skipIf(!isBun)(
    "a lock that is gone each time it is read is retried with a pause, not in a tight loop",
    async () => {
      const directory = await tempDirectory();
      const vanishing = spawnScript(
        join(import.meta.dir, "fixtures", "jsonl-vanishing-lock-child.ts"),
        directory,
      );
      const line = await vanishing.nextLine(30_000);
      expect(await vanishing.proc.exited).toBe(0);
      const [, reads, code] = (line ?? "").split(" ");
      expect(code).toBe("WORKFLOW_STORAGE_UNAVAILABLE");
      // The exporter tries for 5 seconds, pausing 20 ms between tries: about
      // 250 reads. Without the pause it reads the lock many thousand times.
      expect(Number(reads)).toBeGreaterThan(0);
      expect(Number(reads)).toBeLessThan(1_000);
    },
    30_000,
  );
});

/** The pid of a process that was killed, as after a crash. */
async function crashedPid(): Promise<number> {
  const crashed = Bun.spawn([
    process.execPath,
    "-e",
    "await Bun.sleep(60_000)",
  ]);
  processes.push(crashed);
  crashed.kill(9);
  await crashed.exited;
  return crashed.pid;
}

/**
 * Leaves on disk what a kill inside the takeover window leaves: the lock of a
 * writer that died, and the claim a process that also died (or `claimerPid`)
 * took to replace that lock. The lock is older than any freshness limit.
 */
async function seedCrashedTakeover(
  directory: string,
  deadPid: number,
  lockToken: string,
  claimerPid = deadPid,
): Promise<void> {
  const old = new Date(Date.now() - 120_000);
  const lockPath = join(directory, ".writer.lock");
  await writeFile(
    lockPath,
    JSON.stringify({ pid: deadPid, token: lockToken }),
    {
      mode: 0o600,
    },
  );
  const claimKey = createHash("sha256")
    .update(lockToken)
    .digest("hex")
    .slice(0, 32);
  const claimPath = join(directory, `.writer.lock.takeover-${claimKey}`);
  await writeFile(
    claimPath,
    JSON.stringify({ pid: claimerPid, token: `${lockToken}-claimer` }),
    { mode: 0o600 },
  );
  await utimes(lockPath, old, old);
  // Past the claim freshness limit, but not so old that any file counts as
  // abandoned whatever its pid.
  const claimTime = new Date(Date.now() - 20_000);
  await utimes(claimPath, claimTime, claimTime);
}

function send(proc: ReturnType<typeof Bun.spawn>, line: string): void {
  const stdin = proc.stdin as import("bun").FileSink;
  stdin.write(`${line}\n`);
  stdin.flush();
}
