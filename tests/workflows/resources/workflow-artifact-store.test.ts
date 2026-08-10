/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  InMemoryWorkflowArtifactStore,
  WorkflowArtifactConflictError,
  type WorkflowArtifactInput,
} from "../../../src/workflows/resources/workflow-artifact-store.js";

const artifact = (
  artifactId: string,
  content: WorkflowArtifactInput["content"] = { value: artifactId },
  overrides: Partial<WorkflowArtifactInput> = {},
): WorkflowArtifactInput => ({
  artifactId,
  executionId: "execution-1",
  taskId: "task-1",
  type: "application/test",
  content,
  ...overrides,
});

describe("InMemoryWorkflowArtifactStore", () => {
  test("creates immutable snapshots with canonical digest and revision", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const content = { z: 1, nested: { b: true, a: "stable" }, a: 2 };
    const first = await store.put(artifact("artifact-1", content));
    content.nested.a = "mutated";
    const sameSemanticContent = await new InMemoryWorkflowArtifactStore().put(
      artifact("artifact-1", {
        a: 2,
        nested: { a: "stable", b: true },
        z: 1,
      }),
    );

    expect(first.artifact.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.artifact.revision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.artifact.contentDigest).toBe(
      sameSemanticContent.artifact.contentDigest,
    );
    expect(first.artifact.revision).toBe(sameSemanticContent.artifact.revision);
    expect(first.artifact.content).toEqual({
      a: 2,
      nested: { a: "stable", b: true },
      z: 1,
    });
    expect(Object.isFrozen(first.artifact)).toBe(true);
    expect(Object.isFrozen(first.artifact.content)).toBe(true);
  });

  test("makes concurrent identical puts idempotent", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const outcomes = await Promise.all([
      store.put(artifact("artifact-1")),
      store.put(artifact("artifact-1")),
      store.put(artifact("artifact-1")),
    ]);

    expect(outcomes.map(({ created }) => created).sort()).toEqual([
      false,
      false,
      true,
    ]);
    expect(new Set(outcomes.map(({ artifact: value }) => value))).toHaveLength(
      1,
    );
  });

  test("deterministically rejects a concurrent conflicting duplicate", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const outcomes = await Promise.allSettled([
      store.put(artifact("artifact-1", { winner: true })),
      store.put(artifact("artifact-1", { winner: false })),
    ]);

    expect(outcomes[0]?.status).toBe("fulfilled");
    expect(outcomes[1]?.status).toBe("rejected");
    if (outcomes[1]?.status === "rejected") {
      expect(outcomes[1].reason).toBeInstanceOf(WorkflowArtifactConflictError);
    }
    expect((await store.get({ artifactId: "artifact-1" }))?.content).toEqual({
      winner: true,
    });
  });

  test("filters and paginates a stable bounded listing", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    await store.put(artifact("a", { order: 1 }));
    await store.put(
      artifact("b", { order: 2 }, { taskId: "task-2", type: "text/report" }),
    );
    await store.put(
      artifact("c", { order: 3 }, { executionId: "execution-2" }),
    );
    await store.put(artifact("d", { order: 4 }));

    const first = await store.list({ executionId: "execution-1", limit: 2 });
    expect(first.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      "a",
      "b",
    ]);
    expect(first.nextCursor).toBe("b");
    const second = await store.list({
      executionId: "execution-1",
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.artifacts.map(({ artifactId }) => artifactId)).toEqual(["d"]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      (
        await store.list({ taskId: "task-1", type: "application/test" })
      ).artifacts.map(({ artifactId }) => artifactId),
    ).toEqual(["a", "c", "d"]);
    await expect(store.list({ cursor: "missing" })).rejects.toThrow(
      "cursor is not in the filtered set",
    );
    await expect(store.list({ limit: 201 })).rejects.toThrow(
      "between 1 and 200",
    );
  });

  test("rejects unsafe JSON, invalid identities, and cancellation", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    await expect(store.put(artifact("bad id"))).rejects.toThrow("artifactId");
    await expect(
      store.put(artifact("artifact-1", { value: Number.POSITIVE_INFINITY })),
    ).rejects.toThrow("finite JSON numbers");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    await expect(
      store.put(artifact("artifact-1", cyclic as never)),
    ).rejects.toThrow("JSON cycles");
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => "unsafe",
    });
    await expect(
      store.put(artifact("artifact-1", accessor as never)),
    ).rejects.toThrow("dense plain JSON arrays");
    await expect(
      store.put(artifact("artifact-1"), {
        signal: AbortSignal.abort(new Error("cancel artifact")),
      }),
    ).rejects.toThrow("cancel artifact");
  });
});
