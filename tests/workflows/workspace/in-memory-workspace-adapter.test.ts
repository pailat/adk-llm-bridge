/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { InMemoryWorkspaceAdapter } from "../../../src/workflows/workspace/in-memory-workspace-adapter.js";
import {
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
      writePaths: ["./src//workflows/", "src\\tests", "src/workflows/runtime"],
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
  });
});
