import { afterEach, test as bunTest, describe, expect } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import {
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { FileSystemWorkflowCheckpointProvider } from "../../../src/workflows/storage/file-system-checkpoint-provider.js";
import {
  type ChildCapture,
  describeChild,
  moduleSpecifier,
  quietFlags,
} from "../../utils/fixtures/runtime.js";

// The file-system store never reads the invocation context.
const CONTEXT = undefined as unknown as InvocationContext;

function checkpointFile(root: string): string {
  const digest = createHash("sha256")
    .update(workflowCheckpointKey(WORKFLOW_ID, EXECUTION_ID))
    .digest("hex");
  return join(root, digest.slice(0, 2), `${digest}.json`);
}

async function lockEntries(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(root)) {
    for (const entry of await readdir(join(root, shard))) {
      if (entry.includes(".lock")) found.push(entry);
    }
  }
  return found;
}

/**
 * Output padding that makes each kill-test checkpoint about 3 MiB, so a write takes
 * long enough for a kill to land inside it.
 */
const PADDING_BYTES = 3 * 1024 * 1024;
const SRC = resolve(import.meta.dir, "../../../src");
const WORKFLOW_ID = "process-flow";
const EXECUTION_ID = "process-exec";

const roots: string[] = [];
const children: ChildProcess[] = [];
/** Every child the running test started, printed when the test fails. */
let startedChildren: { label: string; running: RunningChild }[] = [];

/** A test that prints how each of its children ended when it fails. */
function test(name: string, body: () => Promise<void>, timeoutMs: number) {
  // Concurrent saves from several processes do not work on Windows yet (known
  // limitation, https://github.com/pailat/adk-llm-bridge/issues/117); these
  // tests keep running on macOS and Linux.
  bunTest.skipIf(process.platform === "win32")(
    name,
    async () => {
      startedChildren = [];
      try {
        await body();
      } catch (error) {
        for (const { label, running } of startedChildren) {
          console.error(describeChild(label, captureOf(running)));
        }
        throw error;
      }
    },
    timeoutMs,
  );
}
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-fs-provider-proc-"));
  roots.push(root);
  return root;
}
/** Waits for a child to be gone, but never longer than `timeoutMs`. */
async function reaped(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolveExit) =>
      child.once("close", () => resolveExit()),
    ),
    new Promise<void>((resolveTimeout) =>
      setTimeout(resolveTimeout, timeoutMs),
    ),
  ]);
}

/** Removes a directory tree, retrying while a dying child still writes to it. */
async function removed(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}

// A hook that waits on a child is bounded: a killed child is reaped for at
// most 10 s, and the limit of the hook itself is explicit, so a stuck process
// can never hold the file for minutes.
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => reaped(child)));
  for (const root of roots.splice(0)) {
    await removed(root);
  }
}, 60_000);

function makeCheckpoint(input: string) {
  return createWorkflowCheckpoint({
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

/** Header shared by the child scripts: the provider and checkpoint helpers. */
const PRELUDE = `
import { createWorkflowCheckpoint, withWorkflowCompleted } from ${JSON.stringify(moduleSpecifier(`${SRC}/workflows/checkpoint/checkpoint.ts`))};
import { defineWorkflow } from ${JSON.stringify(moduleSpecifier(`${SRC}/workflows/definition.ts`))};
import { FileSystemWorkflowCheckpointProvider } from ${JSON.stringify(moduleSpecifier(`${SRC}/workflows/storage/file-system-checkpoint-provider.ts`))};
const [root, ...args] = process.argv.slice(1);
const provider = new FileSystemWorkflowCheckpointProvider({ root, lockTimeoutMs: 20000 });
const make = (input) => createWorkflowCheckpoint({
  definition: defineWorkflow({ id: ${JSON.stringify(WORKFLOW_ID)}, version: "1", handler: () => "done" }),
  executionId: ${JSON.stringify(EXECUTION_ID)}, input, now: 1700000000000,
});
// Resolves once the line is written, so a child never ends before its outcome is out.
const print = (value) => new Promise((done) => process.stdout.write(JSON.stringify(value) + "\\n", () => done()));
`;

/** One writer: waits for the start file, then tries one save from `expected`. */
const WRITER = `${PRELUDE}
import { existsSync } from "node:fs";
const [startFile, expected, label] = args;
while (!existsSync(startFile)) await new Promise((r) => setTimeout(r, 2));
try {
  const stored = await provider.put({ checkpoint: await make(label), expectedRevision: expected });
  await print({ label, outcome: "won", revision: stored.revision });
} catch (error) {
  await print({ label, outcome: error?.name === "WorkflowCheckpointConflictError" ? "conflict" : "error:" + (error?.code ?? error?.name) + ":" + error?.message });
}
`;

/** A save loop: prints `saved <n>` after every save that resolved. */
const SAVE_LOOP = `${PRELUDE}
const padding = "x".repeat(${PADDING_BYTES});
const big = async (label) => withWorkflowCompleted(await make(label), label + padding, 1700000001000);
let expected = null;
for (let n = 0; ; n++) {
  try {
    const stored = await provider.put({ checkpoint: await big("loop-" + n), expectedRevision: expected });
    expected = stored.revision;
  } catch (error) {
    await print({ error: String(error?.code ?? error?.name) + ":" + String(error?.message) });
    process.exit(1);
  }
  await print({ saved: n, revision: expected });
}
`;

interface RunningChild {
  child: ChildProcess;
  lines: string[];
  stderr: string[];
  exited: Promise<number | null>;
  /** Exit code and signal, set once the child has closed. */
  ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
}

function captureOf(running: RunningChild): ChildCapture {
  return {
    exitCode: running.ended?.code ?? running.child.exitCode,
    signal: running.ended?.signal ?? running.child.signalCode,
    stdout: running.lines.join("\n"),
    stderr: running.stderr.join(""),
  };
}

/** Parses the outcome line of each writer; a missing or extra line fails with the child's output. */
function outcomesOf<T>(running: RunningChild[], labels: string[]): T[] {
  return running.map((one, index) => {
    const capture = captureOf(one);
    const lines = one.lines.filter((line) => line.startsWith("{"));
    if (lines.length !== 1 || capture.exitCode !== 0) {
      throw new Error(
        `${describeChild(labels[index] ?? `writer-${index}`, capture)}\nexpected one outcome line and exit code 0, got ${lines.length} line(s)`,
      );
    }
    return JSON.parse(lines[0] as string) as T;
  });
}

function start(script: string, argv: string[], label = "child"): RunningChild {
  const child = spawn(
    process.execPath,
    [...quietFlags, "-e", script, ...argv],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });
  const running: RunningChild = {
    child,
    lines,
    stderr,
    exited: Promise.resolve(null),
    ended: undefined,
  };
  running.exited = new Promise<number | null>((resolveExit) => {
    child.on("close", (code, signal) => {
      // A last line without a newline still counts as output.
      if (pending !== "") lines.push(pending);
      pending = "";
      running.ended = { code, signal };
      resolveExit(code);
    });
  });
  startedChildren.push({ label, running });
  return running;
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Like `waitFor` for an async condition, polled every millisecond. */
async function waitForAsync(
  condition: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("FileSystemWorkflowCheckpointProvider across processes", () => {
  test("N processes saving one execution from the same revision leave exactly one winner, and the winner's checkpoint is stored", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const base = await provider.put({
      checkpoint: await makeCheckpoint("base"),
      expectedRevision: null,
    });
    const startFile = join(await tempRoot(), "start");
    const workers = 6;
    const running = Array.from({ length: workers }, (_, index) =>
      start(
        WRITER,
        [root, startFile, base.revision, `worker-${index}`],
        `worker-${index}`,
      ),
    );
    // Let every child load its modules and reach the barrier, then release.
    await new Promise((r) => setTimeout(r, 1500));
    await writeFile(startFile, "go");
    await Promise.all(running.map((r) => r.exited));

    const results = outcomesOf<{ label: string; outcome: string }>(
      running,
      running.map((_, index) => `worker-${index}`),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "conflict",
      "won",
    ]);
    const winner = results.find((r) => r.outcome === "won") as unknown as {
      label: string;
      revision: string;
    };
    const stored = await provider.get({
      workflowId: WORKFLOW_ID,
      executionId: EXECUTION_ID,
    });
    expect(stored?.revision).toBe(winner.revision);
    expect(stored?.revision).toBe(
      await workflowCheckpointRevision(await makeCheckpoint(winner.label)),
    );
    // No lock directory is left behind.
    expect(await lockEntries(root)).toEqual([]);
  }, 60_000);

  test("a chain of rounds keeps exactly one winner per revision", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    let expected: string | null = (
      await provider.put({
        checkpoint: await makeCheckpoint("round-0"),
        expectedRevision: null,
      })
    ).revision;
    for (let round = 1; round <= 3; round++) {
      const startFile = join(await tempRoot(), "start");
      const running = Array.from({ length: 4 }, (_, index) =>
        start(
          WRITER,
          [root, startFile, expected as string, `r${round}-w${index}`],
          `r${round}-w${index}`,
        ),
      );
      await new Promise((r) => setTimeout(r, 1200));
      await writeFile(startFile, "go");
      await Promise.all(running.map((r) => r.exited));
      const outcomes = outcomesOf<{ outcome: string; revision?: string }>(
        running,
        running.map((_, index) => `r${round}-w${index}`),
      );
      expect(outcomes.filter((o) => o.outcome === "won")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "conflict")).toHaveLength(3);
      expected = (outcomes.find((o) => o.outcome === "won")?.revision ??
        null) as string | null;
      const stored = await provider.get({
        workflowId: WORKFLOW_ID,
        executionId: EXECUTION_ID,
      });
      expect(stored?.revision).toBe(expected as string);
    }
  }, 90_000);

  test("a process killed with SIGKILL inside a save loop leaves the last acknowledged checkpoint loadable", async () => {
    const padding = "x".repeat(PADDING_BYTES);
    for (let attempt = 0; attempt < 40; attempt++) {
      const root = await tempRoot();
      const loop = start(SAVE_LOOP, [root], `save-loop-${attempt}`);
      try {
        await waitFor(
          () =>
            loop.lines.length >= 2 ||
            loop.lines.some((line) => line.includes('"error"')),
          "two acknowledged saves",
        );
        expect(loop.lines.some((line) => line.includes('"error"'))).toBe(false);
        if (attempt % 2 === 0) {
          // Kill a random few milliseconds after a save took its lock, so some
          // attempts land while the temporary file is being written.
          await waitForAsync(
            async () => (await lockEntries(root)).length > 0,
            "a save holding the lock",
          );
          await new Promise((r) => setTimeout(r, Math.random() * 20));
        } else {
          // Kill the instant the checkpoint file is first touched by a save: a
          // write that changed the file in place would be cut off half-way.
          const path = checkpointFile(root);
          const before = statSync(path).mtimeMs;
          const deadline = Date.now() + 30_000;
          while (statSync(path).mtimeMs === before && Date.now() < deadline) {
            // Busy wait: a sleep would let the write finish.
          }
        }
        loop.child.kill("SIGKILL");
        await loop.exited;

        const acknowledged = loop.lines
          .filter((line) => line.startsWith("{") && line.endsWith("}"))
          .map(
            (line) => JSON.parse(line) as { saved: number; revision: string },
          );
        const lastAcknowledged = acknowledged[acknowledged.length - 1];
        expect(lastAcknowledged).toBeDefined();

        const provider = new FileSystemWorkflowCheckpointProvider({ root });
        const stored = await provider.get({
          workflowId: WORKFLOW_ID,
          executionId: EXECUTION_ID,
        });
        expect(stored).toBeDefined();
        // The stored checkpoint is the last acknowledged save, or the one that
        // was committing when the process died; never an older or a torn one.
        const candidates = [
          lastAcknowledged?.revision,
          await workflowCheckpointRevision(
            withWorkflowCompleted(
              await makeCheckpoint(
                `loop-${(lastAcknowledged?.saved ?? 0) + 1}`,
              ),
              `loop-${(lastAcknowledged?.saved ?? 0) + 1}${padding}`,
              1_700_000_001_000,
            ),
          ),
        ];
        expect(candidates).toContain(stored?.revision as string);
        const viaLoad = await provider.load({
          context: CONTEXT,
          workflowId: WORKFLOW_ID,
          executionId: EXECUTION_ID,
        });
        expect(viaLoad).toEqual(stored?.checkpoint);
      } finally {
        // Each attempt leaves nothing behind: the loop is reaped and its
        // directory (several 3 MiB files) removed before the next one starts.
        await reaped(loop.child);
        await removed(root);
        roots.splice(roots.indexOf(root), 1);
      }
    }
  }, 300_000);
});
