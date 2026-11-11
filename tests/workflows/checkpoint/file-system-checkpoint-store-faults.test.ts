import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "checkpoint-store-fault.ts");

async function runFault(
  mode:
    | "release"
    | "steal"
    | "corrupt"
    | "swap"
    | "wait-retire"
    | "wait-replace"
    | "wait-unlink"
    | "wait-vanish"
    | "eperm-live"
    | "eperm-none"
    | "busy-release"
    | "trace"
    | "dir-sync-win32"
    | "dir-sync-posix"
    | "file-sync-win32",
  swapTarget?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "adk-checkpoint-fault-"));
  try {
    const child = spawnSync(
      process.execPath,
      [FIXTURE, mode, root, ...(swapTarget ? [swapTarget] : [])],
      { encoding: "utf8", timeout: 30_000 },
    );
    const line = child.stdout.trim().split("\n").at(-1) ?? "";
    return {
      result: JSON.parse(line) as {
        saved: boolean;
        loaded?: boolean;
        reason?: string;
        [key: string]: unknown;
      },
      output: `${child.stdout}${child.stderr}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("FileSystemWorkflowCheckpointStore under file-system faults", () => {
  test("a lock release failure after the write does not fail the save", async () => {
    const { result, output } = await runFault("release");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).toContain("[WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]");
  });

  test("a lock taken over by another owner after the write fails the save", async () => {
    const { result, output } = await runFault("steal");

    expect(result).toEqual({
      saved: false,
      loaded: true,
      reason: "checkpoint_lock_ownership_lost",
    });
    expect(output).not.toContain("[WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]");
  });

  test("a lock whose owner file is corrupt after the write fails the save", async () => {
    const { result, output } = await runFault("corrupt");

    expect(result).toEqual({
      saved: false,
      loaded: true,
      reason: "checkpoint_lock_corrupt",
    });
    expect(output).not.toContain("[WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]");
  });

  test("load never reads a checkpoint swapped for a symlink after it was checked", async () => {
    const outside = await mkdtemp(join(tmpdir(), "adk-checkpoint-outside-"));
    try {
      const target = join(outside, "planted.json");
      await writeFile(target, "{}", "utf8");

      const { result } = await runFault("swap", target);

      expect(result).toEqual({
        saved: true,
        reason: "checkpoint_file_unsafe",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a waiter that reads the owner while the holder retires the lock acquires it", async () => {
    const { result, output } = await runFault("wait-retire");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).not.toContain("checkpoint_lock_corrupt");
  });

  test("a waiter whose held lock is retired before it inspects it acquires it", async () => {
    const { result, output } = await runFault("wait-vanish");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).not.toContain("checkpoint_lock_read_failed");
  });

  test("a waiter that sees the lock replaced between its reads follows the new owner", async () => {
    const { result, output } = await runFault("wait-replace");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).not.toContain("checkpoint_lock_corrupt");
  });

  // The protocol never leaves a lock directory without its owner file: locks
  // are published and retired by renaming the whole directory. Deleting the
  // owner file in place (what a recursive removal of the live lock path does
  // first) is foreign tampering, and the store fails closed on it.
  test("a lock that loses its owner file in place fails closed", async () => {
    const { result } = await runFault("wait-unlink");

    expect(result).toEqual({
      saved: false,
      loaded: true,
      reason: "checkpoint_lock_corrupt",
    });
  });

  // Windows reports a rename onto a non-empty directory as EPERM, not EEXIST.
  test("an EPERM from the publishing rename while a live holder owns the lock waits for it (Windows)", async () => {
    const { result, output } = await runFault("eperm-live");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).not.toContain("checkpoint_lock_acquire_failed");
  });

  test("an EPERM from the publishing rename with no lock present fails the save", async () => {
    const { result } = await runFault("eperm-none");

    expect(result).toEqual({
      saved: false,
      loaded: false,
      reason: "checkpoint_lock_acquire_failed",
    });
  });

  test("a release retries a rename a waiter's open file blocks (Windows EBUSY)", async () => {
    const { result, output } = await runFault("busy-release");

    expect(result).toEqual({ saved: true, loaded: true });
    expect(output).not.toContain("[WORKFLOW_CHECKPOINT_LOCK_RELEASE_FAILED]");
  });

  // The claim behind the wall-clock fix: the lock path is only ever replaced
  // by a whole-directory rename, with the owner file already complete. An
  // in-place write or delete lets a reader see a lock without its owner.
  test("only the publishing and retiring renames touch the lock path, and the owner is complete and synced before it is published", async () => {
    const { result } = await runFault("trace");

    expect(result).toEqual({
      saved: true,
      loaded: true,
      violations: [],
      publishes: 2,
      incompleteOwnerAtPublish: 0,
      unsyncedOwnerAtPublish: 0,
    });
  });

  // Windows refuses to flush a directory (EPERM); only there is that skipped.
  test("saves and loads when the platform cannot flush a directory (Windows)", async () => {
    const { result } = await runFault("dir-sync-win32");

    expect(result).toEqual({ saved: true, loaded: true });
  });

  test("a directory flush that fails off Windows fails the save", async () => {
    const { result } = await runFault("dir-sync-posix");

    expect(result).toEqual({
      saved: false,
      loaded: false,
      reason: "checkpoint_lock_candidate_failed",
    });
  });

  test("a file flush that fails fails the save on Windows too", async () => {
    const { result } = await runFault("file-sync-win32");

    expect(result).toEqual({
      saved: false,
      loaded: false,
      reason: "checkpoint_lock_candidate_failed",
    });
  });
});
