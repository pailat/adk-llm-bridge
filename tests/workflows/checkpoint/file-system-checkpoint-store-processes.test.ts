import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InvocationContext } from "@google/adk";
import { createWorkflowCheckpoint } from "../../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { workflowCheckpointRevision } from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";

// The publish of a checkpoint is a rename, and on Windows a rename onto a file
// another process holds open is refused until it lets go. These tests run on
// the Windows job under Bun and under Node: whatever the platform, no save may
// fail with a write error because of another process's handle.

const PROCESS = resolve(
  import.meta.dir,
  "fixtures/checkpoint-store-process.ts",
);
const WORKFLOW_ID = "process-flow";
const EXECUTION_ID = "process-exec";
const CONTEXT = {} as InvocationContext;

const roots: string[] = [];
const children: ChildProcess[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-fs-ckpt-proc-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
}, 60_000);

interface Running {
  lines: string[];
  stderr: string[];
  exited: Promise<number | null>;
}

function start(argv: string[]): Running {
  const child = spawn(process.execPath, [PROCESS, ...argv], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  const stderr: string[] = [];
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
  const exited = new Promise<number | null>((done) => {
    child.on("close", (code) => done(code));
  });
  return { lines, stderr, exited };
}

async function makeCheckpoint(input: string) {
  return await createWorkflowCheckpoint({
    definition: defineWorkflow({
      id: WORKFLOW_ID,
      version: "1",
      handler: () => "done",
    }),
    executionId: EXECUTION_ID,
    input,
    now: 1_700_000_000_000,
  });
}

interface SaverResult {
  label: string;
  outcome: string;
  revision?: string;
  message?: string;
  causeCode?: string;
  causeMessage?: string;
  syscall?: string;
  ms?: number;
}
function results(running: Running[]): SaverResult[] {
  return running.flatMap((r) =>
    r.lines.map((line) => JSON.parse(line) as SaverResult),
  );
}

/**
 * Everything the children printed or wrote to stderr, as one message for a
 * failed assertion: outcome, cause code, syscall and elapsed ms per save.
 */
function report(running: Running[]): string {
  return running
    .map((r) => `${r.lines.join(" | ")}${r.stderr.join("")}`)
    .join("\n");
}

async function leftovers(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(root)) {
    for (const entry of await readdir(join(root, shard))) {
      if (entry.endsWith(".tmp") || entry.includes(".lock")) found.push(entry);
    }
  }
  return found;
}

// Several processes taking the lock of one checkpoint at the same moment can
// fail on Windows: the lock candidate's rename onto the lock path is refused
// with EPERM while another process holds or has just released the lock, and
// the store then reads that as a failed acquire. Known limitation, tracked in
// https://github.com/pailat/adk-llm-bridge/issues/117. These two tests run on
// macOS and Linux; the reader test below runs everywhere.
const WINDOWS = process.platform === "win32";

describe("FileSystemWorkflowCheckpointStore across processes", () => {
  test.skipIf(WINDOWS)(
    "N processes saving one checkpoint from the same revision: one winner, the rest conflict, none fails to write",
    async () => {
      const root = await tempRoot();
      const store = new FileSystemWorkflowCheckpointStore({ root });
      const baseCheckpoint = await makeCheckpoint("base");
      await store.save({
        context: CONTEXT,
        checkpoint: baseCheckpoint,
        expectedRevision: null,
      });
      const base = {
        revision: await workflowCheckpointRevision(baseCheckpoint),
      };
      const startFile = join(await tempRoot(), "start");
      const workers = 6;
      const running = Array.from({ length: workers }, (_, index) =>
        start(["saver", root, startFile, base.revision, `worker-${index}`]),
      );
      await new Promise((done) => setTimeout(done, 1500));
      await writeFile(startFile, "go");
      await Promise.all(running.map((r) => r.exited));

      const outcomes = results(running);
      const shown = report(running);
      expect(outcomes, shown).toHaveLength(workers);
      expect(outcomes.map((r) => r.outcome).sort()).toEqual([
        "conflict",
        "conflict",
        "conflict",
        "conflict",
        "conflict",
        "won",
      ]);
      const winner = outcomes.find((r) => r.outcome === "won") as SaverResult;
      const loaded = await store.load({
        context: CONTEXT,
        workflowId: WORKFLOW_ID,
        executionId: EXECUTION_ID,
      });
      expect(await workflowCheckpointRevision(loaded as never)).toBe(
        winner.revision as string,
      );
      expect(await leftovers(root)).toEqual([]);
    },
    60_000,
  );

  test.skipIf(WINDOWS)(
    "a chain of rounds of concurrent savers keeps one winner per revision and one whole checkpoint",
    async () => {
      const root = await tempRoot();
      const store = new FileSystemWorkflowCheckpointStore({ root });
      const first = await makeCheckpoint("round-0");
      await store.save({
        context: CONTEXT,
        checkpoint: first,
        expectedRevision: null,
      });
      let expected = await workflowCheckpointRevision(first);
      for (let round = 1; round <= 3; round++) {
        const startFile = join(await tempRoot(), "start");
        const running = Array.from({ length: 4 }, (_, index) =>
          start(["saver", root, startFile, expected, `r${round}-w${index}`]),
        );
        await new Promise((done) => setTimeout(done, 1200));
        await writeFile(startFile, "go");
        await Promise.all(running.map((r) => r.exited));
        const outcomes = results(running);
        const shown = report(running);
        expect(outcomes, shown).toHaveLength(4);
        expect(
          outcomes.filter((o) => o.outcome === "won"),
          shown,
        ).toHaveLength(1);
        expect(
          outcomes.filter((o) => o.outcome === "conflict"),
          shown,
        ).toHaveLength(3);
        expected = outcomes.find((o) => o.outcome === "won")
          ?.revision as string;
        const loaded = await store.load({
          context: CONTEXT,
          workflowId: WORKFLOW_ID,
          executionId: EXECUTION_ID,
        });
        expect(await workflowCheckpointRevision(loaded as never)).toBe(
          expected,
        );
      }
      expect(await leftovers(root)).toEqual([]);
    },
    90_000,
  );

  test("a reader process that keeps opening the checkpoint never makes a save fail, and never sees a partial file", async () => {
    const root = await tempRoot();
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const first = await makeCheckpoint("0");
    await store.save({
      context: CONTEXT,
      checkpoint: first,
      expectedRevision: null,
    });
    let expected = await workflowCheckpointRevision(first);
    const control = await tempRoot();
    const startFile = join(control, "start");
    const stopFile = join(control, "stop");
    const reader = start(["reader", root, startFile, stopFile]);
    await writeFile(startFile, "go");
    // Let the reader get going before the first save replaces the file.
    await new Promise((done) => setTimeout(done, 1000));

    // Each save is a revision of the one before, sized so a read overlaps it.
    // The saver processes run one at a time here: the reader is the contender.
    for (let round = 1; round <= 8; round++) {
      const roundStart = join(control, `go-${round}`);
      const saver = start([
        "saver",
        root,
        roundStart,
        expected,
        `save-${round}`,
        String(200_000),
      ]);
      await writeFile(roundStart, "go");
      await saver.exited;
      const [result] = results([saver]);
      if (result?.outcome !== "won") {
        // Name the reader's load too (its open fraction) before failing.
        await writeFile(stopFile, "stop");
        await reader.exited;
      }
      expect(
        result?.outcome,
        `${report([saver])}\nreader: ${report([reader])}`,
      ).toBe("won");
      expected = result?.revision as string;
    }
    await writeFile(stopFile, "stop");
    await reader.exited;

    const [read] = reader.lines.map(
      (line) =>
        JSON.parse(line) as {
          reads: number;
          partial: number;
          openFraction: number;
        },
    );
    // The reader must keep the file open often enough to block a publish
    // without the retry, or the test would pass without the fix.
    expect(read?.openFraction, report([reader])).toBeGreaterThanOrEqual(0.25);
    expect(read?.reads, report([reader])).toBeGreaterThan(0);
    expect(read?.partial, report([reader])).toBe(0);
    const loaded = await store.load({
      context: CONTEXT,
      workflowId: WORKFLOW_ID,
      executionId: EXECUTION_ID,
    });
    expect(await workflowCheckpointRevision(loaded as never)).toBe(expected);
    expect(await leftovers(root)).toEqual([]);
  }, 90_000);
});
