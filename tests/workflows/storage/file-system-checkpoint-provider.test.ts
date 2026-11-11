import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  WorkflowCheckpointConflictError,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import {
  defineWorkflowStorageConformanceTests,
  workflowCheckpointStoreConformanceCases,
} from "../../../src/workflows/storage/conformance/index.js";
import {
  FileSystemWorkflowCheckpointProvider,
  fileSystemCheckpointMultiProcess,
} from "../../../src/workflows/storage/file-system-checkpoint-provider.js";

// The file-system store never reads the invocation context.
const CONTEXT = undefined as unknown as InvocationContext;

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-fs-provider-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeCheckpoint(
  workflowId: string,
  executionId: string,
  input = "input",
  now = 1_700_000_000_000,
): Promise<WorkflowCheckpointV1> {
  return await createWorkflowCheckpoint({
    definition: defineWorkflow({
      id: workflowId,
      version: "1",
      handler: () => "done",
    }),
    executionId,
    input,
    now,
  });
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function checkpointPath(root: string, workflowId: string, executionId: string) {
  const key = workflowCheckpointKey(workflowId, executionId);
  const digest = createHash("sha256").update(key).digest("hex");
  return join(root, digest.slice(0, 2), `${digest}.json`);
}

/** Every file and directory under `root` with its size and mtime. */
async function snapshot(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(join(root, prefix))).sort()) {
    const relative = join(prefix, entry);
    const info = await stat(join(root, relative));
    out.push(`${relative}:${info.size}:${info.mtimeMs}`);
    if (info.isDirectory()) out.push(...(await snapshot(root, relative)));
  }
  return out;
}

// The suite creates one root per case; reopening uses the root of the
// provider the suite created last.
let lastRoot = "";
const conformanceCases = await workflowCheckpointStoreConformanceCases({
  createStore: async () => {
    lastRoot = await tempRoot();
    return new FileSystemWorkflowCheckpointProvider({ root: lastRoot });
  },
  reopenStore: () =>
    new FileSystemWorkflowCheckpointProvider({ root: lastRoot }),
});

describe("FileSystemWorkflowCheckpointProvider conformance", () => {
  test("the conformance run covers the durable, listing and atomic cases and skips only leases and pruning", () => {
    const run = conformanceCases.filter((c) => c.skip === undefined);
    expect(run.length).toBeGreaterThanOrEqual(20);
    for (const c of conformanceCases) {
      if (c.skip !== undefined) {
        expect(c.skip).toMatch(/leases is false|pruning is false/);
      }
    }
  });

  defineWorkflowStorageConformanceTests(conformanceCases, {
    // Windows cannot yet run concurrent saves on one file (known limitation,
    // https://github.com/pailat/adk-llm-bridge/issues/117); the case still
    // runs on macOS and Linux.
    test: (name, run) =>
      (name.startsWith("exactly one of")
        ? test.skipIf(process.platform === "win32")
        : test)(name, run),
    skip: test.skip,
  });
});

describe("FileSystemWorkflowCheckpointProvider capabilities", () => {
  test("reports atomic compare-and-set, durable, multi-process and listing, without leases or pruning", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await tempRoot(),
    });
    expect(provider.providerName).toBe("file");
    expect(provider.capabilities).toMatchObject({
      compareAndSet: "atomic",
      durable: true,
      multiProcess: process.platform !== "win32",
      listing: true,
      leases: false,
      pruning: false,
    });
  });

  test("claims multi-process safety on POSIX platforms and not on win32", () => {
    expect(fileSystemCheckpointMultiProcess("win32")).toBe(false);
    expect(fileSystemCheckpointMultiProcess("linux")).toBe(true);
    expect(fileSystemCheckpointMultiProcess("darwin")).toBe(true);
  });

  test("the provider reports the multiProcess value of the running platform", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await tempRoot(),
    });
    expect(provider.capabilities.multiProcess).toBe(
      fileSystemCheckpointMultiProcess(process.platform),
    );
  });

  test("leases, delete and prune reject with WORKFLOW_STORAGE_UNSUPPORTED", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await tempRoot(),
    });
    const locator = { workflowId: "flow", executionId: "exec" };
    const lease = {
      ...locator,
      ownerId: "owner",
      fencingToken: 1,
      expiresAt: Date.now() + 1000,
    };
    const attempts: Array<Promise<unknown>> = [
      provider.acquireLease({ ...locator, ownerId: "owner", ttlMs: 1000 }),
      provider.renewLease(lease, 1000),
      provider.releaseLease(lease),
      provider.delete(locator),
      provider.prune({ updatedBefore: Date.now() + 1000 }),
    ];
    for (const attempt of attempts) {
      const error = (await reject(attempt)) as { code?: string };
      expect(error.code).toBe("WORKFLOW_STORAGE_UNSUPPORTED");
    }
  });
});

describe("FileSystemWorkflowCheckpointProvider reads and writes through the store", () => {
  test("a checkpoint put through the provider is the same file the store writes", async () => {
    const viaProvider = await tempRoot();
    const viaStore = await tempRoot();
    const checkpoint = await makeCheckpoint("flow", "exec-1");
    await new FileSystemWorkflowCheckpointProvider({ root: viaProvider }).put({
      checkpoint,
    });
    await new FileSystemWorkflowCheckpointStore({ root: viaStore }).save({
      context: CONTEXT,
      checkpoint,
    });
    const path = (root: string) => checkpointPath(root, "flow", "exec-1");
    expect(await readFile(path(viaProvider), "utf8")).toBe(
      await readFile(path(viaStore), "utf8"),
    );
    // No file other than the shard directory and the checkpoint file is left.
    expect(
      (await snapshot(viaProvider)).map((entry) => entry.split(":")[0]),
    ).toEqual((await snapshot(viaStore)).map((entry) => entry.split(":")[0]));
  });

  test("the store loads what the provider saved and the provider reads what the store saved", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const first = await makeCheckpoint("flow", "exec-a", "a");
    await provider.put({ checkpoint: first });
    expect(
      await store.load({
        context: CONTEXT,
        workflowId: "flow",
        executionId: "exec-a",
      }),
    ).toEqual(first);
    const second = await makeCheckpoint("flow", "exec-b", "b");
    await store.save({ context: CONTEXT, checkpoint: second });
    const read = await provider.get({
      workflowId: "flow",
      executionId: "exec-b",
    });
    expect(read?.checkpoint).toEqual(second);
    expect(read?.revision).toBe(await workflowCheckpointRevision(second));
  });

  test("a file read while saves replace it is always a complete checkpoint file", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const padding = "x".repeat(200_000);
    const first = await provider.put({
      checkpoint: await makeCheckpoint("flow", "exec", `0${padding}`),
      expectedRevision: null,
    });
    const path = checkpointPath(root, "flow", "exec");
    const revisions = new Set([first.revision]);
    let saving = true;
    let reads = 0;
    const reader = (async () => {
      while (saving) {
        let text: string;
        try {
          text = await readFile(path, "utf8");
        } catch (error) {
          // Windows can refuse a read for an instant while a save swaps the
          // file in; that is a refused read, not a partial file.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
            continue;
          }
          throw error;
        }
        const parsed = JSON.parse(text) as { revision: string };
        expect(text.endsWith("\n")).toBe(true);
        expect(revisions.has(parsed.revision)).toBe(true);
        reads += 1;
      }
    })();
    try {
      let expected = first.revision;
      for (let round = 1; round <= 8; round++) {
        const checkpoint = await makeCheckpoint(
          "flow",
          "exec",
          `${round}${padding}`,
        );
        revisions.add(await workflowCheckpointRevision(checkpoint));
        expected = (
          await provider.put({ checkpoint, expectedRevision: expected })
        ).revision;
      }
    } finally {
      saving = false;
      await reader;
    }
    expect(reads).toBeGreaterThan(0);
    expect(
      (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  // POSIX only: a reader that keeps a handle open across a save is the proof,
  // and Windows refuses to rename over a file another handle holds open.
  test.skipIf(process.platform === "win32")(
    "a save replaces the checkpoint file instead of rewriting it, so a half-written file is never visible",
    async () => {
      const root = await tempRoot();
      const provider = new FileSystemWorkflowCheckpointProvider({ root });
      const first = await provider.put({
        checkpoint: await makeCheckpoint("flow", "exec", "first"),
        expectedRevision: null,
      });
      const path = checkpointPath(root, "flow", "exec");
      const before = await readFile(path, "utf8");
      // A reader that opened the file before the save keeps the old, complete
      // content; a save that rewrote the file in place would change it.
      const reader = await open(path, "r");
      try {
        await provider.put({
          checkpoint: await makeCheckpoint("flow", "exec", "second"),
          expectedRevision: first.revision,
        });
        expect(await reader.readFile("utf8")).toBe(before);
      } finally {
        await reader.close();
      }
      expect(await readFile(path, "utf8")).not.toBe(before);
    },
  );

  test("a stale expectedRevision rejects with the same conflict error the store throws", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const base = await makeCheckpoint("flow", "exec");
    await provider.put({ checkpoint: base, expectedRevision: null });
    const next = await makeCheckpoint("flow", "exec", "other");
    const fromStore = (await reject(
      store.save({
        context: CONTEXT,
        checkpoint: next,
        expectedRevision: "sha256:stale",
      }),
    )) as WorkflowCheckpointConflictError;
    const fromProvider = (await reject(
      provider.put({ checkpoint: next, expectedRevision: "sha256:stale" }),
    )) as WorkflowCheckpointConflictError;
    expect(fromProvider).toBeInstanceOf(WorkflowCheckpointConflictError);
    expect(fromProvider.message).toBe(fromStore.message);
    expect(fromProvider.conflict.actualRevision).toBe(
      fromStore.conflict.actualRevision,
    );
    expect(fromProvider.conflict.expectedRevision).toBe(
      fromStore.conflict.expectedRevision,
    );
  });

  test("a malformed checkpoint file fails with the store's WorkflowError, not a storage error", async () => {
    const root = await tempRoot();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    await provider.put({ checkpoint: await makeCheckpoint("flow", "exec") });
    await writeFile(checkpointPath(root, "flow", "exec"), "{not json");
    const fromStore = (await reject(
      new FileSystemWorkflowCheckpointStore({ root }).load({
        context: CONTEXT,
        workflowId: "flow",
        executionId: "exec",
      }),
    )) as { code: string; details?: { reason?: string } };
    const fromProvider = (await reject(
      provider.get({ workflowId: "flow", executionId: "exec" }),
    )) as { code: string; details?: { reason?: string } };
    expect(fromProvider.code).toBe(fromStore.code);
    expect(fromProvider.code).toBe("WORKFLOW_EXECUTION_ERROR");
    expect(fromProvider.details?.reason).toBe("checkpoint_file_corrupt");
  });

  test("a checkpoint root written by the store keeps working after the provider saved into it", async () => {
    const root = await tempRoot();
    const store = new FileSystemWorkflowCheckpointStore({ root });
    const base = await makeCheckpoint("flow", "exec");
    await store.save({ context: CONTEXT, checkpoint: base });
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const stored = await provider.get({
      workflowId: "flow",
      executionId: "exec",
    });
    const done = withWorkflowCompleted(base, "finished", 1_700_000_005_000);
    await provider.put({
      checkpoint: done,
      expectedRevision: stored?.revision,
    });
    expect(
      (
        await store.load({
          context: CONTEXT,
          workflowId: "flow",
          executionId: "exec",
        })
      )?.status,
    ).toBe("completed");
  });
});

describe("FileSystemWorkflowCheckpointProvider list", () => {
  async function seed(root: string) {
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const running = await makeCheckpoint("flow-b", "exec-2", "x", 10);
    await provider.put({ checkpoint: running });
    await provider.put({
      checkpoint: await makeCheckpoint("flow-a", "exec-1"),
    });
    await provider.put({
      checkpoint: await makeCheckpoint("flow-a", "exec-3"),
    });
    await provider.put({
      checkpoint: withWorkflowCompleted(
        await makeCheckpoint("flow-b", "exec-4"),
        "ok",
        1_700_000_001_000,
      ),
    });
    return provider;
  }

  test("pages with an opaque cursor, ordered by workflow id then execution id, visiting each checkpoint once", async () => {
    const provider = await seed(await tempRoot());
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await provider.list({
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(1);
      for (const item of page.items) {
        seen.push(`${item.workflowId}/${item.executionId}`);
        expect(item.bytes).toBeGreaterThan(0);
        expect(item.revision).toMatch(/^sha256:/);
        expect(typeof item.updatedAt).toBe("number");
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        expect(typeof cursor).toBe("string");
        // Opaque: it must not leak a file-system path.
        expect(cursor).not.toContain("/tmp");
        expect(cursor).not.toContain(".json");
      }
      pages += 1;
    } while (cursor !== undefined && pages < 20);
    expect(seen).toEqual([
      "flow-a/exec-1",
      "flow-a/exec-3",
      "flow-b/exec-2",
      "flow-b/exec-4",
    ]);
  });

  test("filters by workflow id and by status", async () => {
    const provider = await seed(await tempRoot());
    const byWorkflow = await provider.list({ workflowId: "flow-a" });
    expect(byWorkflow.items.map((item) => item.executionId)).toEqual([
      "exec-1",
      "exec-3",
    ]);
    const completed = await provider.list({ status: "completed" });
    expect(completed.items.map((item) => item.executionId)).toEqual(["exec-4"]);
  });

  test("a list is read-only: no file, directory or lock is created or touched", async () => {
    const root = await tempRoot();
    const provider = await seed(root);
    const before = await snapshot(root);
    await provider.list({ limit: 2 });
    await provider.list({});
    expect(await snapshot(root)).toEqual(before);
  });

  test("a list never follows a symlinked checkpoint file or shard directory", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    const provider = await seed(root);
    // A valid checkpoint file in a directory outside the root.
    const outsideProvider = new FileSystemWorkflowCheckpointProvider({
      root: outside,
    });
    await outsideProvider.put({
      checkpoint: await makeCheckpoint("flow-out", "exec-out"),
    });
    const target = checkpointPath(outside, "flow-out", "exec-out");
    // Plant it in the root as a symlinked file and as a symlinked shard.
    const planted = checkpointPath(root, "flow-link", "exec-link");
    await mkdir(join(planted, ".."), { recursive: true });
    await symlink(target, planted);
    const shardDir = join(target, "..");
    const sneakyShard = join(root, "ff");
    await symlink(shardDir, sneakyShard);

    const listed = await provider.list({});
    const ids = listed.items.map(
      (item) => `${item.workflowId}/${item.executionId}`,
    );
    expect(ids).not.toContain("flow-link/exec-link");
    expect(ids).not.toContain("flow-out/exec-out");
    // The four real checkpoints are still listed.
    expect(ids).toHaveLength(4);
  });

  test("lock directories and stray files in the root are not listed", async () => {
    const root = await tempRoot();
    const provider = await seed(root);
    const path = checkpointPath(root, "flow-a", "exec-1");
    await mkdir(`${path}.lock`, { recursive: true });
    await writeFile(join(root, "notes.txt"), "stray");
    await writeFile(join(root, "ab-stray.json"), "{}");
    const listed = await provider.list({});
    expect(listed.items).toHaveLength(4);
  });
});

describe("FileSystemWorkflowCheckpointProvider health", () => {
  test("reports ok for a usable root", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await tempRoot(),
    });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.provider).toBe("file");
  });

  test("reports not ok, without throwing, when the root is a regular file", async () => {
    const parent = await tempRoot();
    const file = join(parent, "not-a-directory");
    await writeFile(file, "x");
    const provider = new FileSystemWorkflowCheckpointProvider({ root: file });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
    expect(typeof health.code).toBe("string");
  });
});
