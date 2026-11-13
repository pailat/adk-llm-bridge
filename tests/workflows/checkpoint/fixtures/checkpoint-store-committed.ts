/**
 * Saves one checkpoint with a file-system fault that strikes at a chosen point
 * of the atomic write, in its own process so the module mock cannot leak.
 *
 * Usage: `bun checkpoint-store-committed.ts <mode> <root>`.
 * `rename-fails` fails the rename itself with `EIO`. `flush-after-rename` fails the first directory flush that follows the
 * rename of the checkpoint file with `EIO`; `write-before-rename` fails the
 * temporary file's write with `EIO` (the rename never happens). Every mode
 * first saves a base checkpoint through the store without a fault, before the
 * fault is armed; no mode skips it. `provider-flush-after-rename` is
 * `flush-after-rename` with the faulted save made through
 * `FileSystemWorkflowCheckpointProvider.put` instead of the store.
 * Prints one JSON line with the failure details and what a later load and save
 * see.
 */

import { mock } from "bun:test";
import type { InvocationContext } from "@google/adk";

const [mode, root] = process.argv.slice(2);
if (
  !root ||
  ![
    "flush-after-rename",
    "write-before-rename",
    "rename-fails",
    "provider-flush-after-rename",
  ].includes(String(mode))
) {
  throw new Error(
    "usage: <flush-after-rename|write-before-rename|rename-fails|provider-flush-after-rename> <root>",
  );
}

const real = { ...(await import("node:fs/promises")) };
let armed = false;
let renamed = false;
let flushFailed = false;

function failing(
  handle: Awaited<ReturnType<typeof real.open>>,
  method: string,
) {
  return new Proxy(handle, {
    get(target, key) {
      if (key === method) {
        return async () => {
          throw Object.assign(new Error(`injected EIO, ${method}`), {
            code: "EIO",
            syscall: method === "sync" ? "fsync" : "write",
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

mock.module("node:fs/promises", () => ({
  ...real,
  rename: async (from: string, to: string) => {
    if (armed && mode === "rename-fails" && String(to).endsWith(".json")) {
      throw Object.assign(new Error("injected EIO, rename"), {
        code: "EIO",
        syscall: "rename",
      });
    }
    await real.rename(from, to);
    if (armed && String(to).endsWith(".json")) renamed = true;
  },
  open: async (path: string, ...rest: [number?, number?]) => {
    const handle = await real.open(path, ...rest);
    if (!armed) return handle;
    const isDirectory = (await handle.stat()).isDirectory();
    if (mode === "write-before-rename" && String(path).endsWith(".tmp")) {
      return failing(handle, "writeFile");
    }
    if (
      mode !== "write-before-rename" &&
      mode !== "rename-fails" &&
      renamed &&
      !flushFailed &&
      isDirectory
    ) {
      flushFailed = true;
      return failing(handle, "sync");
    }
    return handle;
  },
}));

const { FileSystemWorkflowCheckpointStore } = await import(
  "../../../../src/workflows/checkpoint/file-system-checkpoint-store.js"
);
const { FileSystemWorkflowCheckpointProvider } = await import(
  "../../../../src/workflows/storage/file-system-checkpoint-provider.js"
);
const { createWorkflowCheckpoint, withWorkflowCompleted } = await import(
  "../../../../src/workflows/checkpoint/checkpoint.js"
);
const { workflowCheckpointRevision } = await import(
  "../../../../src/workflows/checkpoint/store.js"
);
const { defineWorkflow } = await import(
  "../../../../src/workflows/definition.js"
);

const context = {} as InvocationContext;
const base = await createWorkflowCheckpoint({
  definition: defineWorkflow({ id: "fault", version: "1", handler: () => "" }),
  executionId: "execution",
  input: "input",
  now: 1,
});
const next = withWorkflowCompleted(base, "done", 2);
const baseRevision = await workflowCheckpointRevision(base);
const nextRevision = await workflowCheckpointRevision(next);
const store = new FileSystemWorkflowCheckpointStore({ root });
const provider = new FileSystemWorkflowCheckpointProvider({ root });

await store.save({ context, checkpoint: base, expectedRevision: null });
armed = true;
const result: Record<string, unknown> = { saved: false };
try {
  if (mode === "provider-flush-after-rename") {
    await provider.put({ checkpoint: next, expectedRevision: baseRevision });
  } else {
    await store.save({
      context,
      checkpoint: next,
      expectedRevision: baseRevision,
    });
  }
  result.saved = true;
} catch (error) {
  const details = (error as { details?: Record<string, unknown> }).details;
  result.reason = details?.reason;
  result.causeCode = details?.causeCode;
  result.hasCommitted = details !== undefined && "committed" in details;
  result.committed = details?.committed;
}
armed = false;
const loaded = await store.load({
  context,
  workflowId: "fault",
  executionId: "execution",
});
result.loadedRevision =
  loaded === undefined ? null : await workflowCheckpointRevision(loaded);
result.baseRevision = baseRevision;
result.nextRevision = nextRevision;
// Retry the way a caller that read the failure's `committed` flag would.
try {
  await store.save({
    context,
    checkpoint: withWorkflowCompleted(base, "again", 3),
    expectedRevision: result.loadedRevision as string,
  });
  result.retrySaved = true;
} catch (error) {
  result.retrySaved = false;
  result.retryReason = (
    error as { details?: { reason?: unknown } }
  ).details?.reason;
}
console.log(JSON.stringify(result));
