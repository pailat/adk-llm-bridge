import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "checkpoint-store-fault.ts");

async function runFault(
  mode: "release" | "steal" | "corrupt" | "swap",
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
});
