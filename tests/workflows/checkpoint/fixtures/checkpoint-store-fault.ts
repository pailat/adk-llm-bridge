/**
 * Runs one file-system checkpoint store operation with an injected file-system
 * fault, in its own process so the module mock cannot leak into other tests.
 *
 * Usage: `bun checkpoint-store-fault.ts <release|steal|corrupt|swap> <root> [swapTarget]`.
 * `steal` hands the lock to another owner (same pid, new token) right after
 * the checkpoint is committed, as a recoverer that wrongly judged this process
 * dead would. `corrupt` overwrites the lock's owner file with invalid JSON at
 * the same point. Prints one JSON line: `{ saved, loaded, reason }`.
 */
import { mock } from "bun:test";
import type { InvocationContext } from "@google/adk";

const [mode, root, swapTarget] = process.argv.slice(2);
const MODES = ["release", "steal", "corrupt", "swap"];
if (!root || !mode || !MODES.includes(mode)) {
  throw new Error("usage: <release|steal|corrupt|swap> <root> [swapTarget]");
}

const real = { ...(await import("node:fs/promises")) };
let swapArmed = false;
mock.module("node:fs/promises", () => ({
  ...real,
  rename: async (from: string, to: string) => {
    if (mode === "release" && to.includes(".retired.")) {
      throw Object.assign(new Error("injected release failure"), {
        code: "EIO",
      });
    }
    await real.rename(from, to);
    if (mode === "steal" && from.endsWith(".tmp") && to.endsWith(".json")) {
      const ownerPath = `${to}.lock/owner.json`;
      const owner = JSON.parse(await real.readFile(ownerPath, "utf8"));
      await real.writeFile(
        ownerPath,
        JSON.stringify({ ...owner, token: "stolen-token" }),
      );
    }
    if (mode === "corrupt" && from.endsWith(".tmp") && to.endsWith(".json")) {
      await real.writeFile(`${to}.lock/owner.json`, "{not json");
    }
  },
  // Replace the checkpoint with a symlink right after any check of the path,
  // as a concurrent attacker could.
  lstat: async (path: string) => {
    const info = await real.lstat(path);
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await real.rename(path, `${path}.moved`);
      await real.symlink(swapTarget, path);
    }
    return info;
  },
  open: async (path: string, ...rest: [number?, number?]) => {
    if (swapArmed && path.endsWith(".json") && swapTarget) {
      swapArmed = false;
      await real.rename(path, `${path}.moved`);
      await real.symlink(swapTarget, path);
    }
    return await real.open(path, ...rest);
  },
}));

const { FileSystemWorkflowCheckpointStore } = await import(
  "../../../../src/workflows/checkpoint/file-system-checkpoint-store.js"
);
const { createWorkflowCheckpoint } = await import(
  "../../../../src/workflows/checkpoint/checkpoint.js"
);
const { defineWorkflow } = await import(
  "../../../../src/workflows/definition.js"
);

const context = {} as InvocationContext;
const checkpoint = await createWorkflowCheckpoint({
  definition: defineWorkflow({ id: "fault", version: "1", handler: () => "" }),
  executionId: "execution",
  input: "input",
  now: 1,
});
const store = new FileSystemWorkflowCheckpointStore({ root });
const result: { saved: boolean; loaded?: boolean; reason?: unknown } = {
  saved: false,
};
try {
  await store.save({ context, checkpoint, expectedRevision: null });
  result.saved = true;
} catch (error) {
  result.reason = (error as { details?: { reason?: unknown } }).details?.reason;
}
if (mode === "swap") swapArmed = true;
try {
  const loaded = await store.load({
    context,
    workflowId: "fault",
    executionId: "execution",
  });
  result.loaded = loaded !== undefined;
} catch (error) {
  result.reason = (error as { details?: { reason?: unknown } }).details?.reason;
}
console.log(JSON.stringify(result));
