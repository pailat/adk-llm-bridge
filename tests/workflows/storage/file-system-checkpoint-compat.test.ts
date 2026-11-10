import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InvocationContext } from "@google/adk";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { workflowCheckpointKey } from "../../../src/workflows/checkpoint/store.js";
import { FileSystemWorkflowCheckpointProvider } from "../../../src/workflows/storage/file-system-checkpoint-provider.js";

// The file-system store never reads the invocation context.
const CONTEXT = undefined as unknown as InvocationContext;

/**
 * `fixtures/file-system-root-v1` was written by `FileSystemWorkflowCheckpointStore`
 * before the provider existed. It holds three executions; the file of
 * `legacy-flow/exec-legacy` carries the revision digest computed the way
 * releases before 0.7.0 did (keys sorted with `localeCompare`), which differs
 * from the canonical digest because the step ids `a` and `B` sort differently.
 */
const FIXTURE_ROOT = resolve(import.meta.dir, "fixtures/file-system-root-v1");
const LEGACY_REVISION_ON_DISK =
  "sha256:47d2ba5b5d1aa9539fe72d891cb40cd6618fa9a5707b4da728f04302e79df6e5";
const LEGACY_REVISION_CANONICAL =
  "sha256:37f7cdc0e994bf69a5a17553f98cc1760556639518cc631721ca485bb25bae72";

const copies: string[] = [];
/** Copies the fixture so a failing provider cannot modify the committed files. */
async function fixtureCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "adk-fs-compat-"));
  copies.push(root);
  await cp(FIXTURE_ROOT, root, { recursive: true });
  return root;
}
afterEach(async () => {
  for (const root of copies.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function fixtureFile(workflowId: string, executionId: string): string {
  const digest = createHash("sha256")
    .update(workflowCheckpointKey(workflowId, executionId))
    .digest("hex");
  return join(FIXTURE_ROOT, digest.slice(0, 2), `${digest}.json`);
}

describe("a file-system root written before the provider existed", () => {
  test("the fixture file really carries the legacy digest, not the canonical one", async () => {
    const file = JSON.parse(
      await readFile(fixtureFile("legacy-flow", "exec-legacy"), "utf8"),
    ) as { revision: string };
    expect(file.revision).toBe(LEGACY_REVISION_ON_DISK);
    expect(file.revision).not.toBe(LEGACY_REVISION_CANONICAL);
  });

  test("the provider loads every checkpoint of the fixture, as the store does", async () => {
    const root = await fixtureCopy();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const store = new FileSystemWorkflowCheckpointStore({ root });
    for (const [workflowId, executionId] of [
      ["fixture-flow", "exec-a"],
      ["fixture-flow", "exec-b"],
      ["legacy-flow", "exec-legacy"],
    ] as const) {
      const locator = { workflowId, executionId };
      const viaProvider = await provider.load({ ...locator, context: CONTEXT });
      expect(viaProvider).toBeDefined();
      expect(viaProvider).toEqual(
        await store.load({ ...locator, context: CONTEXT }),
      );
      expect(viaProvider?.workflowId).toBe(workflowId);
      expect(viaProvider?.executionId).toBe(executionId);
    }
  });

  test("the legacy-digest file is accepted and reported with its canonical revision", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await fixtureCopy(),
    });
    const stored = await provider.get({
      workflowId: "legacy-flow",
      executionId: "exec-legacy",
    });
    expect(stored?.revision).toBe(LEGACY_REVISION_CANONICAL);
    expect(Object.keys(stored?.checkpoint.steps ?? {}).sort()).toEqual([
      "B",
      "a",
    ]);
  });

  test("the provider lists all three checkpoints with their status and the canonical revision", async () => {
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: await fixtureCopy(),
    });
    const listed = await provider.list({});
    expect(listed.nextCursor).toBeUndefined();
    expect(
      listed.items.map((item) => ({
        id: `${item.workflowId}/${item.executionId}`,
        status: item.status,
      })),
    ).toEqual([
      { id: "fixture-flow/exec-a", status: "running" },
      { id: "fixture-flow/exec-b", status: "completed" },
      { id: "legacy-flow/exec-legacy", status: "running" },
    ]);
    const legacy = listed.items.find(
      (item) => item.executionId === "exec-legacy",
    );
    expect(legacy?.revision).toBe(LEGACY_REVISION_CANONICAL);
    for (const item of listed.items) expect(item.bytes).toBeGreaterThan(0);
  });

  test("a compare-and-set save over the legacy-digest file with its canonical revision succeeds", async () => {
    const root = await fixtureCopy();
    const provider = new FileSystemWorkflowCheckpointProvider({ root });
    const stored = await provider.get({
      workflowId: "legacy-flow",
      executionId: "exec-legacy",
    });
    const next = {
      ...(stored?.checkpoint as NonNullable<typeof stored>["checkpoint"]),
      updatedAt: 1_700_000_009_000,
    };
    const written = await provider.put({
      checkpoint: next,
      expectedRevision: stored?.revision,
    });
    expect(written.checkpoint.updatedAt).toBe(1_700_000_009_000);
    expect(
      (
        await new FileSystemWorkflowCheckpointStore({ root }).load({
          context: CONTEXT,
          workflowId: "legacy-flow",
          executionId: "exec-legacy",
        })
      )?.updatedAt,
    ).toBe(1_700_000_009_000);
  });

  test("loading and listing leave the committed fixture files unchanged", async () => {
    const before = await readFile(
      fixtureFile("legacy-flow", "exec-legacy"),
      "utf8",
    );
    const provider = new FileSystemWorkflowCheckpointProvider({
      root: FIXTURE_ROOT,
    });
    await provider.list({});
    await provider.get({
      workflowId: "legacy-flow",
      executionId: "exec-legacy",
    });
    expect(
      await readFile(fixtureFile("legacy-flow", "exec-legacy"), "utf8"),
    ).toBe(before);
  });
});
