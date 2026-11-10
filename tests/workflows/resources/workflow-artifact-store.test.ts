import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  InMemoryWorkflowArtifactStore,
  WorkflowArtifactConflictError,
  WorkflowArtifactIdentityError,
  type WorkflowArtifactInput,
  workflowArtifactStoragePath,
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
    expect(
      (
        await store.get({
          executionId: "execution-1",
          artifactId: "artifact-1",
        })
      )?.content,
    ).toEqual({
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
        await store.list({
          executionId: "execution-1",
          taskId: "task-1",
          type: "application/test",
        })
      ).artifacts.map(({ artifactId }) => artifactId),
    ).toEqual(["a", "d"]);
    await expect(
      store.list({ executionId: "execution-1", cursor: "missing" }),
    ).rejects.toThrow("cursor is not in the filtered set");
    await expect(
      store.list({ executionId: "execution-2", cursor: "a" }),
    ).rejects.toThrow("cursor is not in the filtered set");
    await expect(
      store.list({ executionId: "execution-1", limit: 201 }),
    ).rejects.toThrow("between 1 and 200");
  });

  test("keeps the same artifact id in two executions apart", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const first = await store.put(artifact("shared", { owner: "one" }));
    const second = await store.put(
      artifact("shared", { owner: "two" }, { executionId: "execution-2" }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.artifact.revision).not.toBe(first.artifact.revision);
    expect(
      (await store.get({ executionId: "execution-1", artifactId: "shared" }))
        ?.content,
    ).toEqual({ owner: "one" });
    expect(
      (await store.get({ executionId: "execution-2", artifactId: "shared" }))
        ?.content,
    ).toEqual({ owner: "two" });
    const listed = await store.list({ executionId: "execution-2" });
    expect(listed.artifacts.map(({ content }) => content)).toEqual([
      { owner: "two" },
    ]);
  });

  test("reads another execution's artifact as absent", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    await store.put(artifact("only-one"));

    await expect(
      store.get({ executionId: "execution-2", artifactId: "only-one" }),
    ).resolves.toBeUndefined();
    await expect(
      store.list({ executionId: "execution-2" }),
    ).resolves.toMatchObject({ artifacts: [] });
  });

  test("rejects a missing or invalid execution id with a typed error", async () => {
    const store = new InMemoryWorkflowArtifactStore();
    const invalid = [undefined, "", " x", "a/b", "../x", "e+1", 7];
    for (const executionId of invalid) {
      for (const call of [
        () => store.put(artifact("a", 1, { executionId } as never)),
        () => store.get({ executionId, artifactId: "a" } as never),
        () => store.list({ executionId } as never),
      ]) {
        const error = await call().then(
          () => undefined,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(WorkflowArtifactIdentityError);
        expect(error).toBeInstanceOf(TypeError);
        expect(error).toMatchObject({
          code: "WORKFLOW_ARTIFACT_IDENTITY_INVALID",
          field: "executionId",
        });
      }
    }
    await expect(
      store.get({ executionId: "execution-1", artifactId: "bad id" }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ARTIFACT_IDENTITY_INVALID",
      field: "artifactId",
    });
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

describe("workflowArtifactStoragePath", () => {
  const path = (executionId: string, artifactId: string) =>
    workflowArtifactStoragePath({ executionId, artifactId });

  test("lays artifacts out under one directory per execution", async () => {
    expect(await path("execution-1", "report-1")).toBe("execution-1/report-1");
    expect(await path("execution-2", "report-1")).toBe("execution-2/report-1");
  });

  test("keeps every id inside one segment, with no traversal", async () => {
    const value = await path("C:run", "a/../../etc/passwd");
    expect(value.split("/")).toHaveLength(2);
    expect(value.split("/")).not.toContain("..");
    expect(value.startsWith("C:")).toBe(false);
    expect(value).not.toContain("\\");
  });

  test("never maps two keys to one path, even on a case-insensitive file system", async () => {
    const long = (character: string, length = 256) => character.repeat(length);
    const keys = await Promise.all(
      [
        ["e", "Report"],
        ["e", "report"],
        ["E", "report"],
        ["e", "a/b"],
        ["e", "a:b"],
        ["e", "a.2Fb"],
        ["e", "a+b"],
        ["e", long("A")],
        ["e", long("a")],
        ["e", `${long("a", 255)}`],
        ["e", `${long("a", 254)}b`],
        [long("E"), "x"],
        [long("e"), "x"],
      ].map(async ([executionId, artifactId]) =>
        (await path(executionId as string, artifactId as string)).toLowerCase(),
      ),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("bounds every segment to 255 characters for the longest valid ids", async () => {
    const cases = [
      ["e", "A".repeat(86)],
      ["e", "A".repeat(256)],
      ["e", "a".repeat(256)],
      ["E".repeat(256), "x"],
      ["e".repeat(256), "+".padStart(256, "a")],
    ];
    for (const [executionId, artifactId] of cases) {
      const segments = (
        await path(executionId as string, artifactId as string)
      ).split("/");
      expect(segments).toHaveLength(2);
      for (const segment of segments) {
        expect(segment.length).toBeLessThanOrEqual(255);
      }
    }
    // An escaped segment that fits is kept as is; one that does not fit
    // becomes `~` and a SHA-256 hex digest, which no escaped segment can be.
    expect(await path("e", "a".repeat(255))).toBe(`e/${"a".repeat(255)}`);
    expect(await path("e", "A".repeat(85))).toBe(`e/${"%41".repeat(85)}`);
    expect(await path("e", "A".repeat(86))).toMatch(/^e\/~[0-9a-f]{64}$/u);
  });

  test("gives a path a file system can create for the longest valid ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "artifact-path-"));
    try {
      for (const [executionId, artifactId] of [
        ["E".repeat(256), "A".repeat(256)],
        ["e".repeat(256), "a".repeat(256)],
      ]) {
        const file = join(
          root,
          ...(await path(executionId as string, artifactId as string)).split(
            "/",
          ),
        );
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "{}");
        expect(await readFile(file, "utf8")).toBe("{}");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid ids with the typed identity error", async () => {
    for (const key of [
      { executionId: "a/b", artifactId: "x" },
      { executionId: "", artifactId: "x" },
      { executionId: "e", artifactId: "../x" },
      { executionId: "e", artifactId: "" },
      { executionId: "e".repeat(257), artifactId: "x" },
    ]) {
      await expect(workflowArtifactStoragePath(key)).rejects.toBeInstanceOf(
        WorkflowArtifactIdentityError,
      );
    }
  });
});
