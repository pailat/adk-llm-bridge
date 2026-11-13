import { describe, expect, test } from "bun:test";
import { InMemoryWorkspaceAdapter } from "../../../src/workflows/workspace/in-memory-workspace-adapter.js";
import {
  findWorkspacePathOverlaps,
  normalizeWorkspacePath,
  workspacePathsOverlap,
} from "../../../src/workflows/workspace/workspace-adapter.js";

function adapter() {
  let sequence = 0;
  return new InMemoryWorkspaceAdapter({
    createLeaseId: () => `lease-${++sequence}`,
    now: () => 42,
  });
}

describe("InMemoryWorkspaceAdapter", () => {
  test("normalizes ownership paths and exposes stable lease identity", async () => {
    const coordinator = adapter();
    const lease = await coordinator.acquire({
      workspaceId: " repo ",
      ownerId: " agent-a ",
      writePaths: ["./src//workflows/", "src/tests/", "src/workflows/runtime"],
    });

    expect(lease).toMatchObject({
      leaseId: "lease-1",
      workspaceId: "repo",
      ownerId: "agent-a",
      acquiredAt: 42,
      writePaths: ["src/tests", "src/workflows"],
    });
    expect(lease.leaseId).toBe("lease-1");
  });

  test("queues overlapping ownership until the active lease releases", async () => {
    const coordinator = adapter();
    const first = await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["src/workflows"],
    });
    let acquired = false;
    const waiting = coordinator
      .acquire({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["src/workflows/runtime/workflow-runtime.ts"],
      })
      .then((lease) => {
        acquired = true;
        return lease;
      });

    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(
      coordinator.conflicts({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["src/workflows/runtime"],
      }),
    ).toEqual([
      {
        leaseId: "lease-1",
        workspaceId: "repo",
        ownerId: "agent-a",
        overlaps: [
          {
            requestedPath: "src/workflows/runtime",
            leasedPath: "src/workflows",
          },
        ],
      },
    ]);

    expect(await first.release()).toBe(true);
    const second = await waiting;
    expect(second.leaseId).toBe("lease-2");
    expect(acquired).toBe(true);
  });

  test("does not collide sibling paths or identical paths in other workspaces", async () => {
    const coordinator = adapter();
    const first = await coordinator.acquire({
      workspaceId: "repo-a",
      ownerId: "agent-a",
      writePaths: ["src/foo"],
    });
    const sibling = await coordinator.acquire({
      workspaceId: "repo-a",
      ownerId: "agent-b",
      writePaths: ["src/foobar"],
    });
    const otherWorkspace = await coordinator.acquire({
      workspaceId: "repo-b",
      ownerId: "agent-c",
      writePaths: ["src/foo"],
    });

    expect([first.leaseId, sibling.leaseId, otherWorkspace.leaseId]).toEqual([
      "lease-1",
      "lease-2",
      "lease-3",
    ]);
    expect(workspacePathsOverlap("src/foo", "src/foobar")).toBe(false);
  });

  test("aborts a pending acquisition without affecting the active lease", async () => {
    const coordinator = adapter();
    const active = await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["src"],
    });
    const abort = new AbortController();
    const waiting = coordinator.acquire(
      {
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["src/workflows"],
      },
      { signal: abort.signal },
    );

    abort.abort(new Error("cancelled by coordinator"));
    await expect(waiting).rejects.toThrow("cancelled by coordinator");
    expect(await active.release()).toBe(true);

    await expect(
      coordinator.acquire(
        {
          workspaceId: "repo",
          ownerId: "agent-c",
          writePaths: ["src"],
        },
        { signal: AbortSignal.abort(new Error("already cancelled")) },
      ),
    ).rejects.toThrow("already cancelled");
  });

  test("release is idempotent and ownership can be reacquired", async () => {
    const coordinator = adapter();
    const first = await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["src/workflows"],
    });

    expect(await first.release()).toBe(true);
    expect(await first.release()).toBe(false);

    const reacquired = await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-b",
      writePaths: ["src/workflows"],
    });
    expect(reacquired.leaseId).toBe("lease-2");
  });

  test("rejects absolute and parent-traversing write paths", () => {
    expect(() => normalizeWorkspacePath("/tmp/repo")).toThrow(
      "must be relative",
    );
    expect(() => normalizeWorkspacePath("src/../secrets")).toThrow(
      "must not traverse",
    );
    expect(() => normalizeWorkspacePath("C:\\repo\\src")).toThrow(
      "must be relative",
    );
    // A backslash is a file name character on POSIX, so it is rejected
    // rather than read as a separator.
    expect(() => normalizeWorkspacePath("src\\tests")).toThrow(
      "must use forward slashes",
    );
    expect(() => normalizeWorkspacePath("C:repo")).toThrow("must be relative");
  });
});

describe("InMemoryWorkspaceAdapter path case", () => {
  test("compares paths case-sensitively by default", async () => {
    const coordinator = new InMemoryWorkspaceAdapter();
    await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["Src/a"],
    });

    expect(
      coordinator.conflicts({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["src/a"],
      }),
    ).toEqual([]);
  });

  test("caseInsensitivePaths makes differently cased paths conflict", async () => {
    const coordinator = new InMemoryWorkspaceAdapter({
      caseInsensitivePaths: true,
    });
    const held = await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["Src/A"],
    });

    expect(held.writePaths).toEqual(["Src/A"]);
    expect(
      coordinator.conflicts({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["src/a/file.ts", "SRC/b"],
      }),
    ).toEqual([
      {
        leaseId: held.leaseId,
        workspaceId: "repo",
        ownerId: "agent-a",
        overlaps: [{ requestedPath: "src/a/file.ts", leasedPath: "Src/A" }],
      },
    ]);
    // Composed and decomposed spellings of the same letter also conflict.
    expect(
      coordinator.conflicts({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["Src/A/É"],
      }),
    ).toHaveLength(1);
    expect(
      findWorkspacePathOverlaps(["café"], ["CAFÉ"], {
        caseInsensitive: true,
      }),
    ).toHaveLength(1);
  });
});

describe("case-insensitive path folding", () => {
  // Pairs that name one file on a case-insensitive APFS volume.
  test.each([
    ["docs/ΑΣ", "docs/ασ"], // ΑΣ / ασ (final sigma rule)
    ["ς", "σ"], // ς / σ
    ["ſrc", "src"], // long s
    ["µ", "μ"], // micro sign / mu
    ["straße", "strasse"], // ß / ss
    ["ϐ", "β"], // ϐ / β
    ["Src/A", "src/a"],
    ["café", "CAFÉ"],
  ])("%s and %s overlap", (left, right) => {
    expect(
      findWorkspacePathOverlaps([left], [right], { caseInsensitive: true }),
    ).toHaveLength(1);
    expect(
      findWorkspacePathOverlaps([right], [left], { caseInsensitive: true }),
    ).toHaveLength(1);
  });

  test("a second lease on the same APFS file is not granted", async () => {
    const coordinator = new InMemoryWorkspaceAdapter({
      caseInsensitivePaths: true,
    });
    await coordinator.acquire({
      workspaceId: "repo",
      ownerId: "agent-a",
      writePaths: ["docs/ΑΣ"],
    });

    expect(
      coordinator.conflicts({
        workspaceId: "repo",
        ownerId: "agent-b",
        writePaths: ["docs/ασ"],
      }),
    ).toHaveLength(1);
  });

  test("folding keeps containment: a parent still covers its children", () => {
    expect(
      findWorkspacePathOverlaps(["STRASSE"], ["straße/a.ts"], {
        caseInsensitive: true,
      }),
    ).toHaveLength(1);
    expect(
      findWorkspacePathOverlaps(["src"], ["srcs"], { caseInsensitive: true }),
    ).toEqual([]);
  });
});
