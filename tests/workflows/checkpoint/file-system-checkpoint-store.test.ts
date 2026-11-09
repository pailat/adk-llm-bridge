import { describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { InvocationContext } from "@google/adk";
import {
  createWorkflowCheckpoint,
  withWorkflowCompleted,
  withWorkflowStepCompleted,
  withWorkflowStepRunning,
  withWorkflowStepWaiting,
} from "../../../src/workflows/checkpoint/checkpoint.js";
import {
  collectFileSystemCheckpointTombstonesOffline,
  FileSystemWorkflowCheckpointStore,
} from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { hashWorkflowInput } from "../../../src/workflows/checkpoint/hash.js";
import type { WorkflowCheckpointV1 } from "../../../src/workflows/checkpoint/schema.js";
import {
  DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
  WorkflowCheckpointConflictError,
  type WorkflowCheckpointFailureReason,
  workflowCheckpointByteLength,
  workflowCheckpointKey,
  workflowCheckpointRevision,
} from "../../../src/workflows/checkpoint/store.js";
import type {
  WorkflowStep,
  WorkflowStepResult,
} from "../../../src/workflows/contracts.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { fromPartial } from "../../helpers/partial.js";

const definition = defineWorkflow({
  id: "file-checkpoint",
  version: "1",
  handler: () => "done",
});

describe("FileSystemWorkflowCheckpointStore", () => {
  test("survives a new store instance and returns an ADK-compatible state delta", async () => {
    await withTemporaryRoot(async (root) => {
      const checkpoint = await initialCheckpoint();
      const revision = await workflowCheckpointRevision(checkpoint);
      const first = new FileSystemWorkflowCheckpointStore({ root });
      const write = await first.save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
        revision,
      });
      const key = workflowCheckpointKey(
        checkpoint.workflowId,
        checkpoint.executionId,
      );

      expect(write).toEqual({
        checkpointKey: key,
        stateDelta: { [key]: checkpoint },
      });
      expect(
        await new FileSystemWorkflowCheckpointStore({ root }).load({
          context: invocationContext(),
          workflowId: checkpoint.workflowId,
          executionId: checkpoint.executionId,
        }),
      ).toEqual(checkpoint);

      const checkpointPath = await findCheckpointPath(root);
      expect(basename(checkpointPath)).toMatch(/^[a-f0-9]{64}\.json$/u);
      expect(checkpointPath.startsWith(root)).toBe(true);
    });
  });

  test("rejects a stale writer across store instances", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      const first = new FileSystemWorkflowCheckpointStore({ root });
      await first.save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });

      const winner = withWorkflowCompleted(initial, "winner", 20);
      const winnerRevision = await workflowCheckpointRevision(winner);
      await first.save({
        context: invocationContext(),
        checkpoint: winner,
        expectedRevision: initialRevision,
        revision: winnerRevision,
      });

      const stale = withWorkflowCompleted(initial, "stale", 30);
      await expect(
        new FileSystemWorkflowCheckpointStore({ root }).save({
          context: invocationContext(),
          checkpoint: stale,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(stale),
        }),
      ).rejects.toMatchObject({
        name: "WorkflowCheckpointConflictError",
        code: "WORKFLOW_EXECUTION_ERROR",
        conflict: {
          reason: "checkpoint_revision_conflict",
          expectedRevision: initialRevision,
          actualRevision: winnerRevision,
        },
      });
    });
  });

  test("allows exactly one of two concurrent CAS writes", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });

      const left = withWorkflowCompleted(initial, "left", 20);
      const right = withWorkflowCompleted(initial, "right", 20);
      const options = { root, lockRetryMs: 1 };
      const outcomes = await Promise.allSettled([
        new FileSystemWorkflowCheckpointStore(options).save({
          context: invocationContext(),
          checkpoint: left,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(left),
        }),
        new FileSystemWorkflowCheckpointStore(options).save({
          context: invocationContext(),
          checkpoint: right,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(right),
        }),
      ]);

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );
      expect(rejected?.status).toBe("rejected");
      if (rejected?.status === "rejected") {
        expect(rejected.reason).toBeInstanceOf(WorkflowCheckpointConflictError);
      }

      const stored = await new FileSystemWorkflowCheckpointStore({ root }).load(
        {
          context: invocationContext(),
          workflowId: initial.workflowId,
          executionId: initial.executionId,
        },
      );
      expect<unknown[]>(["left", "right"]).toContain(stored?.output);
    });
  });

  test("rejects a stored interrupt event whose content parts are not a list", async () => {
    await withTemporaryRoot(async (root) => {
      const step = {
        id: "ask",
        agentName: "asker",
        input: "ask it",
      } satisfies WorkflowStep;
      const inputHash = await hashWorkflowInput(step.input);
      const checkpoint = withWorkflowStepWaiting(
        withWorkflowStepRunning(
          await initialCheckpoint(),
          step,
          inputHash,
          1,
          10,
        ),
        step,
        inputHash,
        1,
        {
          kind: "input",
          functionCallIds: ["call-1"],
          requests: [{ functionCallId: "call-1" }],
          events: [{ author: "asker", content: { role: "model", parts: [] } }],
        },
        { role: "user", parts: [{ text: "build it" }] },
        20,
      );
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
      });
      await expect(loadCheckpoint(root, checkpoint)).resolves.toMatchObject({
        steps: { ask: { status: "waiting" } },
      });

      const checkpointPath = await findCheckpointPath(root);
      const envelope = JSON.parse(await readFile(checkpointPath, "utf8"));
      envelope.checkpoint.steps.ask.interrupt.events[0].content.parts = 5;
      await writeFile(checkpointPath, JSON.stringify(envelope), "utf8");
      const reason: WorkflowCheckpointFailureReason = "checkpoint_file_corrupt";
      await expect(loadCheckpoint(root, checkpoint)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason },
      });
    });
  });

  test("rejects a stored step result whose usage is not a usage record", async () => {
    await withTemporaryRoot(async (root) => {
      const step = {
        id: "plan",
        agentName: "planner",
        input: "plan it",
      } satisfies WorkflowStep;
      const checkpoint = withWorkflowStepCompleted(
        withWorkflowStepRunning(
          await initialCheckpoint(),
          step,
          await hashWorkflowInput(step.input),
          1,
          10,
        ),
        {
          status: "completed",
          id: step.id,
          agentName: step.agentName,
          output: "planned",
          attempts: 1,
          startedAt: 10,
          completedAt: 20,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cachedTokens: 0,
            toolCalls: 1,
            llmCalls: 1,
          },
        },
        20,
      );
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
      });
      await expect(loadCheckpoint(root, checkpoint)).resolves.toMatchObject({
        steps: { plan: { result: { usage: { toolCalls: 1 } } } },
      });

      const checkpointPath = await findCheckpointPath(root);
      const envelope = JSON.parse(await readFile(checkpointPath, "utf8"));
      envelope.checkpoint.steps.plan.result.usage.promptTokens = -1;
      await writeFile(checkpointPath, JSON.stringify(envelope), "utf8");
      await expect(loadCheckpoint(root, checkpoint)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_file_corrupt" },
      });
    });
  });

  test("rejects malformed JSON and a mismatched stored revision", async () => {
    await withTemporaryRoot(async (root) => {
      const checkpoint = await initialCheckpoint();
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
      });
      const checkpointPath = await findCheckpointPath(root);
      const validFile = await readFile(checkpointPath, "utf8");

      await writeFile(checkpointPath, "{not-json", "utf8");
      await expect(loadCheckpoint(root, checkpoint)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_file_corrupt" },
      });

      const envelope = JSON.parse(validFile) as Record<string, unknown>;
      envelope.revision = "sha256:corrupt";
      await writeFile(checkpointPath, JSON.stringify(envelope), "utf8");
      await expect(loadCheckpoint(root, checkpoint)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_revision_invalid" },
      });
    });
  });

  test("enforces the default 4 MiB limit before I/O and on envelope load", async () => {
    expect(DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES).toBe(4 * 1024 * 1024);
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const oversized = withWorkflowCompleted(
        initial,
        "x".repeat(DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES + 1_024),
        20,
      );

      await expect(
        new FileSystemWorkflowCheckpointStore({ root }).save({
          context: invocationContext(),
          checkpoint: oversized,
          expectedRevision: null,
        }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: {
          reason: "checkpoint_size_limit_exceeded",
          direction: "save",
          maxBytes: DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
        },
      });
      expect(await readdir(root)).toEqual([]);

      const largeLimit = workflowCheckpointByteLength(oversized) + 1_024;
      await new FileSystemWorkflowCheckpointStore({
        root,
        maxCheckpointBytes: largeLimit,
      }).save({
        context: invocationContext(),
        checkpoint: oversized,
        expectedRevision: null,
      });

      await expect(loadCheckpoint(root, oversized)).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: {
          reason: "checkpoint_size_limit_exceeded",
          direction: "load",
          maxBytes: DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES,
        },
      });
    });
  });

  test("does not replace an existing file when an oversized save fails", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const store = new FileSystemWorkflowCheckpointStore({ root });
      const initialRevision = await workflowCheckpointRevision(initial);
      await store.save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });
      const oversized = withWorkflowCompleted(
        initial,
        "x".repeat(DEFAULT_WORKFLOW_CHECKPOINT_MAX_BYTES + 1_024),
        20,
      );

      await expect(
        store.save({
          context: invocationContext(),
          checkpoint: oversized,
          expectedRevision: initialRevision,
        }),
      ).rejects.toMatchObject({
        details: { reason: "checkpoint_size_limit_exceeded" },
      });
      expect(await loadCheckpoint(root, initial)).toEqual(initial);
    });
  });

  test("uses a compact canonical CAS revision for legacy runtime fields", async () => {
    await withTemporaryRoot(async (root) => {
      const legacy = await legacyCheckpoint();
      const store = new FileSystemWorkflowCheckpointStore({ root });
      await store.save({
        context: invocationContext(),
        checkpoint: legacy,
        expectedRevision: null,
      });
      const checkpointPath = await findCheckpointPath(root);
      const envelope = JSON.parse(
        await readFile(checkpointPath, "utf8"),
      ) as Record<string, unknown>;
      envelope.checkpoint = legacy;
      envelope.revision = await workflowCheckpointRevision(legacy);
      await writeFile(checkpointPath, `${JSON.stringify(envelope)}\n`, "utf8");

      const loaded = await store.load({
        context: invocationContext(),
        workflowId: legacy.workflowId,
        executionId: legacy.executionId,
      });
      expect(loaded?.steps.plan?.result).not.toHaveProperty("events");
      expect(loaded?.steps.plan?.result).not.toHaveProperty("replayed");
      expect(await readFile(checkpointPath, "utf8")).toContain("events");
      if (!loaded) throw new Error("missing legacy checkpoint");

      const canonicalRevision = await workflowCheckpointRevision(loaded);
      const next = withWorkflowCompleted(loaded, "done", 30);
      await store.save({
        context: invocationContext(),
        checkpoint: next,
        expectedRevision: canonicalRevision,
      });
      expect(await readFile(checkpointPath, "utf8")).not.toContain("events");
    });
  });

  test("recovers a lock left by a dead process", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      const store = new FileSystemWorkflowCheckpointStore({ root });
      await store.save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });
      const checkpointPath = await findCheckpointPath(root);
      const lockPath = `${checkpointPath}.lock`;
      const deadPid = await exitedProcessId();
      await writeLock(lockPath, {
        pid: deadPid,
        createdAt: Date.now(),
        token: "dead",
      });

      const next = withWorkflowCompleted(initial, "recovered", 20);
      await new FileSystemWorkflowCheckpointStore({
        root,
        lockRetryMs: 1,
      }).save({
        context: invocationContext(),
        checkpoint: next,
        expectedRevision: initialRevision,
        revision: await workflowCheckpointRevision(next),
      });

      expect((await loadCheckpoint(root, initial))?.output).toBe("recovered");
      await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      // The dead owner's tombstone stays: it fences a delayed second recoverer.
      expect((await lstat(`${lockPath}.retired.dead`)).isDirectory()).toBe(
        true,
      );
    });
  });

  test("rejects a directory or a FIFO at the checkpoint path without blocking", async () => {
    await withTemporaryRoot(async (root) => {
      const checkpoint = await initialCheckpoint();
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
      });
      const checkpointPath = await findCheckpointPath(root);
      const unsafe = [
        async () => await mkdir(checkpointPath),
        ...(process.platform === "win32"
          ? []
          : [
              async () => {
                const made = spawnSync("mkfifo", [checkpointPath]);
                if (made.status !== 0) throw new Error("mkfifo failed");
              },
            ]),
      ];
      for (const plant of unsafe) {
        await rm(checkpointPath, { recursive: true, force: true });
        await plant();
        await expect(loadCheckpoint(root, checkpoint)).rejects.toMatchObject({
          code: "WORKFLOW_EXECUTION_ERROR",
          details: { reason: "checkpoint_file_unsafe" },
        });
      }
    });
  });

  test("a released lock leaves no tombstone behind", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const store = new FileSystemWorkflowCheckpointStore({ root });
      await store.save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
      });
      const next = withWorkflowCompleted(initial, "again", 20);
      await store.save({
        context: invocationContext(),
        checkpoint: next,
        expectedRevision: await workflowCheckpointRevision(initial),
      });

      expect(
        (await allEntryNames(root)).filter((entry) => entry.includes(".lock")),
      ).toEqual([]);
    });
  });

  test("a recoverer leaves the lock alone when its owner changed after the liveness check", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
      });
      const lockPath = `${await findCheckpointPath(root)}.lock`;
      const deadPid = await exitedProcessId();
      await writeLock(lockPath, {
        pid: deadPid,
        createdAt: Date.now(),
        token: "dead",
      });
      // The dead owner's lock is released and a live owner takes it while the
      // recoverer is still deciding (its own release left no tombstone).
      const realKill = process.kill.bind(process);
      const kill = spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        if (pid !== deadPid) return realKill(pid, signal);
        rmSync(lockPath, { recursive: true });
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: 1, token: "live" }),
        );
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }) as typeof process.kill);
      try {
        const next = withWorkflowCompleted(initial, "stolen", 20);
        await expect(
          new FileSystemWorkflowCheckpointStore({
            root,
            lockTimeoutMs: 30,
            lockRetryMs: 2,
          }).save({
            context: invocationContext(),
            checkpoint: next,
            expectedRevision: initialRevision,
          }),
        ).rejects.toMatchObject({
          details: { reason: "checkpoint_lock_timeout" },
        });
      } finally {
        kill.mockRestore();
      }
      expect(
        JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token,
      ).toBe("live");
      expect(
        (await allEntryNames(root)).some((entry) =>
          entry.includes(".retired."),
        ),
      ).toBe(false);
    });
  });

  test("a recoverer leaves the lock alone when a new owner reuses the dead owner's pid", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
      });
      const lockPath = `${await findCheckpointPath(root)}.lock`;
      const deadPid = await exitedProcessId();
      await writeLock(lockPath, {
        pid: deadPid,
        createdAt: Date.now(),
        token: "dead",
      });
      // The token is the lock's identity: a new process gets the dead owner's
      // pid back and takes the lock with a new token while the recoverer is
      // still deciding. From then on that pid is alive.
      let reused = false;
      const realKill = process.kill.bind(process);
      const kill = spyOn(process, "kill").mockImplementation(((
        pid: number,
        signal?: string | number,
      ) => {
        if (pid !== deadPid) return realKill(pid, signal);
        if (reused) return true;
        reused = true;
        rmSync(lockPath, { recursive: true });
        mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: deadPid, createdAt: 1, token: "reused" }),
        );
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }) as typeof process.kill);
      try {
        await expect(
          new FileSystemWorkflowCheckpointStore({
            root,
            lockTimeoutMs: 30,
            lockRetryMs: 2,
          }).save({
            context: invocationContext(),
            checkpoint: withWorkflowCompleted(initial, "stolen", 20),
            expectedRevision: initialRevision,
          }),
        ).rejects.toMatchObject({
          details: { reason: "checkpoint_lock_timeout" },
        });
      } finally {
        kill.mockRestore();
      }
      expect(
        JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token,
      ).toBe("reused");
      expect(
        (await allEntryNames(root)).some((entry) =>
          entry.includes(".retired."),
        ),
      ).toBe(false);
    });
  });

  test("does not steal a lock owned by a live PID", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });
      const checkpointPath = await findCheckpointPath(root);
      const lockPath = `${checkpointPath}.lock`;
      await writeLock(lockPath, {
        pid: process.pid,
        createdAt: Date.now() - 60_000,
        token: "live",
      });

      const next = withWorkflowCompleted(initial, "blocked", 20);
      await expect(
        new FileSystemWorkflowCheckpointStore({
          root,
          lockTimeoutMs: 30,
          lockRetryMs: 2,
        }).save({
          context: invocationContext(),
          checkpoint: next,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(next),
        }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_lock_timeout", timeoutMs: 30 },
      });
      expect((await lstat(lockPath)).isDirectory()).toBe(true);
    });
  });

  test("honors an abort signal while a live lock is pending", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });
      const checkpointPath = await findCheckpointPath(root);
      const lockPath = `${checkpointPath}.lock`;
      await writeLock(lockPath, {
        pid: process.pid,
        createdAt: Date.now(),
        token: "live-abort",
      });
      const controller = new AbortController();
      controller.abort();

      const next = withWorkflowCompleted(initial, "aborted", 20);
      await expect(
        new FileSystemWorkflowCheckpointStore({
          root,
          lockRetryMs: 1,
          signal: controller.signal,
        }).save({
          context: invocationContext(),
          checkpoint: next,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(next),
        }),
      ).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" });
      expect((await lstat(lockPath)).isDirectory()).toBe(true);
    });
  });

  test("rejects corrupt lock ownership instead of guessing that it is stale", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const initialRevision = await workflowCheckpointRevision(initial);
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
        revision: initialRevision,
      });
      const checkpointPath = await findCheckpointPath(root);
      const lockPath = `${checkpointPath}.lock`;
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner.json"), "{invalid", "utf8");

      const next = withWorkflowCompleted(initial, "unsafe", 20);
      await expect(
        new FileSystemWorkflowCheckpointStore({ root, lockRetryMs: 1 }).save({
          context: invocationContext(),
          checkpoint: next,
          expectedRevision: initialRevision,
          revision: await workflowCheckpointRevision(next),
        }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_lock_corrupt" },
      });
      expect((await lstat(lockPath)).isDirectory()).toBe(true);
    });
  });

  test("collects only valid checkpoint tombstones while offline", async () => {
    await withTemporaryRoot(async (root) => {
      const initial = await initialCheckpoint();
      const store = new FileSystemWorkflowCheckpointStore({
        root,
        lockRetryMs: 1,
      });
      await store.save({
        context: invocationContext(),
        checkpoint: initial,
        expectedRevision: null,
      });
      // Recovering a dead owner's lock leaves a tombstone.
      await writeLock(`${await findCheckpointPath(root)}.lock`, {
        pid: await exitedProcessId(),
        createdAt: Date.now(),
        token: "dead",
      });
      const checkpoint = withWorkflowCompleted(initial, "recovered", 20);
      await store.save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: await workflowCheckpointRevision(initial),
      });
      const unknownPath = join(root, "keep.unknown");
      await writeFile(unknownPath, "keep", "utf8");

      const result = await collectFileSystemCheckpointTombstonesOffline({
        root,
        confirmNoActiveWriters: true,
      });

      expect(result.removedTombstones).toBe(1);
      expect(await readFile(unknownPath, "utf8")).toBe("keep");
      expect(
        (await allEntryNames(root)).filter(
          (entry) =>
            entry.includes(".lock.retired.") ||
            entry.includes(".lock.candidate.") ||
            entry.endsWith(".tmp"),
        ),
      ).toEqual([]);
      expect(await loadCheckpoint(root, checkpoint)).toEqual(checkpoint);
    });
  });

  test("offline checkpoint collection requires confirmation and no active candidate", async () => {
    await withTemporaryRoot(async (root) => {
      await expect(
        collectFileSystemCheckpointTombstonesOffline({
          root,
          confirmNoActiveWriters: false as true,
        }),
      ).rejects.toThrow("confirmNoActiveWriters: true");
      await expect(
        collectFileSystemCheckpointTombstonesOffline({
          root: "relative",
          confirmNoActiveWriters: true,
        }),
      ).rejects.toThrow("root must be absolute");

      const checkpoint = await initialCheckpoint();
      await new FileSystemWorkflowCheckpointStore({ root }).save({
        context: invocationContext(),
        checkpoint,
        expectedRevision: null,
      });
      const checkpointPath = await findCheckpointPath(root);
      const candidate = join(
        dirname(checkpointPath),
        `.${basename(checkpointPath)}.lock.candidate.${process.pid}.active`,
      );
      await mkdir(candidate);

      await expect(
        collectFileSystemCheckpointTombstonesOffline({
          root,
          confirmNoActiveWriters: true,
        }),
      ).rejects.toThrow("active lock or candidate");
    });
  });

  test("offline checkpoint collection rejects symlinks", async () => {
    await withTemporaryRoot(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), "adk-checkpoint-outside-"));
      try {
        await symlink(outside, join(root, "unsafe-link"));
        await expect(
          collectFileSystemCheckpointTombstonesOffline({
            root,
            confirmNoActiveWriters: true,
          }),
        ).rejects.toThrow("rejects symlinks");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });
});

async function writeLock(
  lockPath: string,
  owner: { pid: number; createdAt: number; token: string },
): Promise<void> {
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner), {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function initialCheckpoint(): Promise<WorkflowCheckpointV1> {
  return await createWorkflowCheckpoint({
    definition,
    executionId: "execution-1",
    input: "build it",
    now: 10,
  });
}

async function legacyCheckpoint(): Promise<WorkflowCheckpointV1> {
  const step = {
    id: "plan",
    agentName: "planner",
    input: "plan it",
  } satisfies WorkflowStep;
  const inputHash = await hashWorkflowInput(step.input);
  let checkpoint = await createWorkflowCheckpoint({
    definition,
    executionId: "execution-legacy",
    input: "build it",
    now: 10,
  });
  checkpoint = withWorkflowStepRunning(checkpoint, step, inputHash, 1, 10);
  const result: WorkflowStepResult = {
    status: "completed",
    id: step.id,
    agentName: step.agentName,
    output: "planned",
    attempts: 1,
    startedAt: 10,
    completedAt: 20,
    replayed: false,
    events: fromPartial<WorkflowStepResult["events"]>([{ id: "legacy" }]),
  };
  const legacy = withWorkflowStepCompleted(checkpoint, result, 20);
  const savedResult = legacy.steps.plan?.result;
  if (!savedResult) throw new Error("missing legacy result");
  savedResult.events = result.events;
  savedResult.replayed = false;
  return legacy;
}

async function loadCheckpoint(
  root: string,
  checkpoint: WorkflowCheckpointV1,
): Promise<WorkflowCheckpointV1 | undefined> {
  return await new FileSystemWorkflowCheckpointStore({ root }).load({
    context: invocationContext(),
    workflowId: checkpoint.workflowId,
    executionId: checkpoint.executionId,
  });
}

async function findCheckpointPath(root: string): Promise<string> {
  const shards = await readdir(root);
  for (const shard of shards.sort()) {
    const shardPath = join(root, shard);
    if (!(await lstat(shardPath)).isDirectory()) {
      continue;
    }
    const checkpoint = (await readdir(shardPath)).find((name) =>
      name.endsWith(".json"),
    );
    if (checkpoint) {
      return join(shardPath, checkpoint);
    }
  }
  throw new Error("checkpoint file not found");
}

async function allEntryNames(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(root)) {
    names.push(entry);
    const path = join(root, entry);
    const info = await lstat(path);
    if (info.isDirectory()) names.push(...(await allEntryNames(path)));
  }
  return names;
}

async function exitedProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const pid = child.pid;
  await once(child, "exit");
  if (!pid) {
    throw new Error("child process did not expose a pid");
  }
  return pid;
}

async function withTemporaryRoot(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "adk-checkpoint-store-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function invocationContext(): InvocationContext {
  return fromPartial<InvocationContext>({
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
}
