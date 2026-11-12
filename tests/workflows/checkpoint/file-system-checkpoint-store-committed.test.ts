import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "checkpoint-store-committed.ts",
);

type Mode =
  | "flush-after-rename"
  | "write-before-rename"
  | "rename-fails"
  | "provider-flush-after-rename";

interface Outcome {
  saved: boolean;
  reason?: string;
  causeCode?: string;
  hasCommitted: boolean;
  committed?: boolean;
  loadedRevision: string | null;
  baseRevision: string;
  nextRevision: string;
  retrySaved: boolean;
  retryReason?: string;
}

async function runFault(mode: Mode): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), "adk-checkpoint-committed-"));
  try {
    const child = spawnSync(process.execPath, [FIXTURE, mode, root], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const line = (child.stdout ?? "").trim().split("\n").at(-1) ?? "";
    try {
      return JSON.parse(line) as Outcome;
    } catch {
      throw new Error(
        `fault child "${mode}" gave no result (exit ${child.status}):\n${child.stdout}\n${child.stderr}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("a checkpoint save that fails after the rename", () => {
  test("says the new revision is committed and leaves it loadable", async () => {
    const outcome = await runFault("flush-after-rename");

    expect(outcome.saved).toBe(false);
    expect(outcome.reason).toBe("checkpoint_write_failed");
    expect(outcome.causeCode).toBe("EIO");
    expect(outcome.committed).toBe(true);
    expect(outcome.loadedRevision).toBe(outcome.nextRevision);
    expect(outcome.retrySaved).toBe(true);
  });

  test("carries the same flag through the file-system provider", async () => {
    const outcome = await runFault("provider-flush-after-rename");

    expect(outcome.saved).toBe(false);
    expect(outcome.reason).toBe("checkpoint_write_failed");
    expect(outcome.committed).toBe(true);
  });

  test("does not set the flag when the write fails before the rename", async () => {
    const outcome = await runFault("write-before-rename");

    expect(outcome.saved).toBe(false);
    expect(outcome.reason).toBe("checkpoint_write_failed");
    expect(outcome.causeCode).toBe("EIO");
    expect(outcome.hasCommitted).toBe(false);
    expect(outcome.loadedRevision).toBe(outcome.baseRevision);
  });
});

describe("a checkpoint save whose rename fails", () => {
  test("does not set the committed flag and keeps the old revision", async () => {
    const outcome = await runFault("rename-fails");

    expect(outcome.saved).toBe(false);
    expect(outcome.reason).toBe("checkpoint_write_failed");
    expect(outcome.causeCode).toBe("EIO");
    expect(outcome.hasCommitted).toBe(false);
    expect(outcome.loadedRevision).toBe(outcome.baseRevision);
  });
});
