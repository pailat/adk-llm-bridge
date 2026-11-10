/**
 * In-process waits and budgets measure elapsed time on a monotonic clock, so a
 * wall-clock step (an NTP correction, a manual change, or the jump a host sees
 * when it wakes from sleep) neither ends them early nor stretches them.
 * Durable lease expiry is wall time on purpose and is covered in the workspace
 * adapter tests.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InvocationContext } from "@google/adk";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
} from "../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import {
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../src/workflows/checkpoint/store.js";
import { defineWorkflow } from "../../src/workflows/definition.js";
import { FileSystemWorkflowRepositoryMutationLock } from "../../src/workflows/node/git-worktree-change-driver.js";
import { QuickJSSyncGeneratorRuntime } from "../../src/workflows/sandbox/quickjs-generator-runtime.js";
import { FileSystemWorkspaceAdapter } from "../../src/workflows/workspace/file-system-workspace-adapter.js";
import { fromPartial } from "../helpers/partial.js";

const HOUR_MS = 3_600_000;
const realNow = Date.now.bind(Date);
const directories: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Replaces `Date.now`; the returned function moves the wall clock by `ms`. */
function steppableWallClock(): (ms: number) => void {
  let offset = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  cleanups.push(() => spy.mockRestore());
  return (ms) => {
    offset += ms;
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "adk-wall-clock-step-"));
  directories.push(directory);
  return directory;
}

/**
 * Publishes a lock directory owned by this (live) process the way the lock
 * protocol does: the owner file is written into a candidate directory that is
 * then renamed onto the lock path, so the lock never exists without its owner.
 */
async function holdLock(lockPath: string, token: string): Promise<void> {
  const candidate = `${lockPath}.test-candidate`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await mkdir(candidate, { mode: 0o700 });
  await writeFile(
    join(candidate, "owner.json"),
    JSON.stringify({ token, pid: process.pid, acquiredAt: realNow() }),
  );
  await rename(candidate, lockPath);
}

/**
 * Releases a lock from {@link holdLock} the way the protocol does: one rename
 * moves the whole directory away, then it is removed. A recursive removal of
 * the lock path would delete the owner file first, and a waiter that polls in
 * that gap sees a lock without an owner, which the checkpoint store rejects as
 * `checkpoint_lock_corrupt`.
 */
async function releaseHeldLock(lockPath: string): Promise<void> {
  const retired = `${lockPath}.test-retired`;
  await rename(lockPath, retired);
  await rm(retired, { recursive: true });
}

function outcome<T>(promise: Promise<T>): Promise<"settled" | unknown> {
  return promise.then(
    () => "settled",
    (error: unknown) => error,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("lock waits ignore wall-clock steps", () => {
  test("workspace state lock: a forward step does not time the wait out", async () => {
    const root = await temporaryDirectory();
    const adapter = new FileSystemWorkspaceAdapter({
      stateDirectory: root,
      pollIntervalMs: 2,
      lockAcquireTimeoutMs: 5_000,
    });
    cleanups.push(() => adapter.dispose());
    const lockPath = join(
      root,
      createHash("sha256").update("repo").digest("hex"),
      "lock",
    );
    await holdLock(lockPath, "live-holder");
    const step = steppableWallClock();

    const pending = outcome(
      adapter.acquire({ workspaceId: "repo", ownerId: "a", writePaths: ["x"] }),
    );
    await delay(20);
    step(HOUR_MS);
    await delay(40);
    await releaseHeldLock(lockPath);

    expect(await pending).toBe("settled");
  });

  test("checkpoint lock: a forward step does not time the wait out", async () => {
    const root = await temporaryDirectory();
    const definition = defineWorkflow({
      id: "clock-step",
      version: "1",
      handler: () => "done",
    });
    const initial = await createWorkflowCheckpoint({
      definition,
      executionId: "execution-1",
      input: "go",
      now: 10,
    });
    const context = fromPartial<InvocationContext>({
      invocationId: "execution-1",
      session: {
        id: "session-1",
        appName: "app",
        userId: "user",
        state: {},
        events: [],
        lastUpdateTime: 1,
      },
    });
    const store = new FileSystemWorkflowCheckpointStore({
      root,
      lockTimeoutMs: 5_000,
      lockRetryMs: 2,
    });
    await store.save({ context, checkpoint: initial, expectedRevision: null });
    const digest = createHash("sha256")
      .update(workflowCheckpointKey(initial.workflowId, initial.executionId))
      .digest("hex");
    const lockPath = join(root, digest.slice(0, 2), `${digest}.json.lock`);
    await holdLock(lockPath, "live-holder");
    const step = steppableWallClock();

    const pending = outcome(
      store.save({
        context,
        checkpoint: withWorkflowCompleted(initial, "done", 20),
        expectedRevision: await workflowCheckpointRevision(initial),
      }),
    );
    await delay(20);
    step(HOUR_MS);
    await delay(40);
    await releaseHeldLock(lockPath);

    expect(await pending).toBe("settled");
  });

  test("repository mutation lock: a forward step does not time the wait out", async () => {
    const lockRoot = await temporaryDirectory();
    const lock = new FileSystemWorkflowRepositoryMutationLock({
      lockRoot,
      acquireTimeoutMs: 5_000,
      retryIntervalMs: 2,
    });
    const held = await lock.acquire("repo");
    const step = steppableWallClock();

    const pending = outcome(lock.acquire("repo"));
    await delay(20);
    step(HOUR_MS);
    await delay(40);
    expect(await held.release()).toBe(true);

    expect(await pending).toBe("settled");
  });
});

describe("sandbox CPU budget ignores wall-clock steps", () => {
  test("a forward step on every clock read does not interrupt a short turn", async () => {
    const runtime = new QuickJSSyncGeneratorRuntime({
      loader: () =>
        newQuickJSWASMModuleFromVariant(
          import("@jitl/quickjs-wasmfile-release-sync"),
        ),
    });
    // Each read of the wall clock is an hour after the previous one, so any
    // deadline taken from it expires at the next interrupt check.
    let reads = 0;
    const spy = spyOn(Date, "now").mockImplementation(
      () => realNow() + reads++ * HOUR_MS,
    );
    cleanups.push(() => spy.mockRestore());
    const session = await runtime.createSession({
      source: `
        let total = 0;
        for (let index = 0; index < 300000; index++) total += index % 7;
        const resumed = yield total;
        for (let index = 0; index < 300000; index++) total += index % 5;
        return total + resumed;
      `,
      limits: { cpuTimeMs: 10_000 },
    });
    try {
      const first = session.next();
      expect(first.done).toBe(false);
      expect(session.next(1).done).toBe(true);
    } finally {
      session.dispose();
    }
  });
});
