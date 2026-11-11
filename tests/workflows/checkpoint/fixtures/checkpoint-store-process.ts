/**
 * One process of the multi-process checkpoint store tests.
 *
 * Usage: `bun checkpoint-store-process.ts <saver|reader> <root> <startFile> ...`
 *
 * `saver <root> <startFile> <expectedRevision|-> <label> [padding]` waits for
 * the start file, makes one save of a checkpoint whose input is `label`, and
 * prints one JSON line: `{ label, outcome, ... }` with outcome `won`,
 * `conflict`, or `error:<reason>`.
 *
 * `reader <root> <startFile> <stopFile>` finds the checkpoint file, then
 * until the stop file exists keeps opening it and reading it whole. A Windows rename onto a file another process holds
 * open is refused for as long as it is held. It reads, pauses a few
 * milliseconds, and reads again. It prints `{ reads, partial, refused,
 * openFraction }`: complete reads, reads that were not a whole checkpoint file,
 * and reads the host refused with EPERM, EBUSY or EACCES.
 */

import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  WorkflowCheckpointConflictError,
  workflowCheckpointRevision,
} from "../../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../../src/workflows/definition.js";

const [role, root, startFile, ...rest] = process.argv.slice(2);
const WORKFLOW_ID = "process-flow";
const EXECUTION_ID = "process-exec";
/**
 * Prints one JSON line and ends the process once it is written: on Windows a
 * pipe write is asynchronous, and `process.exit` right after it can drop the
 * line.
 */
const printAndExit = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Pause between two reads, and how long each read keeps the file open. */
const READER_GAP_MS = 5;
const BLOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);

async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) await sleep(2);
}

if (role === "saver") {
  const [expected, label, padding = "0"] = rest;
  const store = new FileSystemWorkflowCheckpointStore({
    root: root as string,
    lockTimeoutMs: 30_000,
    lockRetryMs: 2,
  });
  const checkpoint = await createWorkflowCheckpoint({
    definition: defineWorkflow({
      id: WORKFLOW_ID,
      version: "1",
      handler: () => "done",
    }),
    executionId: EXECUTION_ID,
    input: label,
    now: 1_700_000_000_000,
  });
  const body = withWorkflowCompleted(
    checkpoint,
    `${label}${"x".repeat(Number(padding))}`,
    1_700_000_001_000,
  );
  await waitForFile(startFile as string);
  const savingSince = performance.now();
  try {
    await store.save({
      context: {} as InvocationContext,
      checkpoint: body,
      expectedRevision: expected === "-" ? null : expected,
    });
    printAndExit({
      label,
      outcome: "won",
      revision: await workflowCheckpointRevision(body),
      ms: Math.round(performance.now() - savingSince),
    });
  } catch (error) {
    const details = (
      error as {
        details?: {
          reason?: string;
          causeCode?: string;
          causeMessage?: string;
          syscall?: string;
        };
      }
    ).details;
    // Everything the next failing run needs to say which call failed and when.
    printAndExit({
      label,
      outcome:
        error instanceof WorkflowCheckpointConflictError
          ? "conflict"
          : `error:${details?.reason ?? (error as Error)?.name}`,
      message: (error as Error)?.message,
      causeCode: details?.causeCode,
      causeMessage: details?.causeMessage,
      syscall: details?.syscall,
      ms: Math.round(performance.now() - savingSince),
    });
  }
}

if (role === "reader") {
  const [stopFile] = rest;
  await waitForFile(startFile as string);
  // The checkpoint's shard directory and file appear with the first save.
  let path: string | undefined;
  while (!path) {
    for (const shard of await readdir(root as string).catch(() => [])) {
      const names = await readdir(join(root as string, shard)).catch(() => []);
      const name = names.find((entry) => /^[0-9a-f]{64}\.json$/.test(entry));
      if (name) path = join(root as string, shard, name);
    }
    if (!path) await sleep(1);
  }
  let reads = 0;
  let partial = 0;
  let refused = 0;
  let heldMs = 0;
  const readingSince = performance.now();
  while (!existsSync(stopFile as string)) {
    const openedAt = performance.now();
    try {
      const handle = await open(path, "r");
      try {
        // Hold the handle while pausing: a reader that does something with the
        // file (a scanner, an editor) keeps it open that long.
        await sleep(READER_GAP_MS);
        const text = await handle.readFile("utf8");
        const parsed = JSON.parse(text) as { revision?: unknown };
        if (!text.endsWith("\n") || typeof parsed.revision !== "string") {
          partial += 1;
        } else {
          reads += 1;
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && BLOCKED.has(code)) {
        refused += 1;
      } else if (error instanceof SyntaxError) {
        partial += 1;
      } else if (code !== "ENOENT") {
        throw error;
      }
    }
    heldMs += performance.now() - openedAt;
    // A real reader opens, reads and closes, then does other work. Re-opening
    // with no gap at all keeps the file open nearly all the time, and no
    // writer can then get a rename in (see the report, r3).
    await sleep(READER_GAP_MS);
  }
  printAndExit({
    reads,
    partial,
    refused,
    openFraction: Number(
      (heldMs / (performance.now() - readingSince)).toFixed(2),
    ),
  });
}

if (role !== "saver" && role !== "reader") {
  throw new Error("usage: <saver|reader> <root> <startFile> ...");
}
