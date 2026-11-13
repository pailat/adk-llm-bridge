import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InvocationContext } from "@google/adk";
import { createWorkflowCheckpoint } from "../../../src/workflows/checkpoint/checkpoint.js";
import { FileSystemWorkflowCheckpointStore } from "../../../src/workflows/checkpoint/file-system-checkpoint-store.js";
import { defineWorkflow } from "../../../src/workflows/definition.js";
import { fromPartial } from "../../helpers/partial.js";

const definition = defineWorkflow({
  id: "checkpoint-validation",
  version: "1",
  handler: () => "done",
});

const context = fromPartial<InvocationContext>({ invocationId: "execution-1" });

/** Returns what `operation` throws, or fails the test when it returns. */
function thrown(operation: () => unknown): { code?: string; message?: string } {
  try {
    operation();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error("expected the operation to throw");
}

async function withRoot(op: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "adk-checkpoint-validation-"));
  try {
    await op(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("FileSystemWorkflowCheckpointStore option and save validation", () => {
  test("constructor rejects a relative root with WORKFLOW_DEFINITION_INVALID", () => {
    const error = thrown(
      () => new FileSystemWorkflowCheckpointStore({ root: "relative/dir" }),
    );
    expect(error.code).toBe("WORKFLOW_DEFINITION_INVALID");
    expect(error.message).toMatch(/must be absolute/);
  });

  test("constructor rejects non-positive-integer numeric options", () => {
    for (const option of [
      "lockTimeoutMs",
      "lockRetryMs",
      "maxCheckpointBytes",
    ] as const) {
      expect(
        () =>
          new FileSystemWorkflowCheckpointStore({
            root: "/tmp/checkpoint-validation-root",
            [option]: 0,
          }),
      ).toThrow(option);
    }
  });

  test("save rejects a schema-invalid checkpoint as checkpoint_schema_invalid", async () => {
    await withRoot(async (root) => {
      const store = new FileSystemWorkflowCheckpointStore({ root });
      await expect(
        store.save({
          context,
          checkpoint: { nope: true } as never,
          expectedRevision: null,
        }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: { reason: "checkpoint_schema_invalid" },
      });
    });
  });

  test("save rejects a supplied revision that does not match the checkpoint", async () => {
    await withRoot(async (root) => {
      const store = new FileSystemWorkflowCheckpointStore({ root });
      const checkpoint = await createWorkflowCheckpoint({
        definition,
        executionId: "execution-1",
        input: "x",
        now: 10,
      });
      await expect(
        store.save({
          context,
          checkpoint,
          expectedRevision: null,
          revision: "not-the-revision",
        }),
      ).rejects.toMatchObject({
        code: "WORKFLOW_EXECUTION_ERROR",
        details: {
          reason: "checkpoint_revision_invalid",
          suppliedRevision: "not-the-revision",
        },
      });
    });
  });
});
