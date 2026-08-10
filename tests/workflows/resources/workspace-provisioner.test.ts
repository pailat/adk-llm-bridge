/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { InMemoryWorkspaceProvisioner } from "../../../src/workflows/resources/workspace-provisioner.js";

describe("InMemoryWorkspaceProvisioner", () => {
  test("separates an immutable JSON descriptor from its host-only handle", async () => {
    const parameters = { branch: "feature", nested: { attempt: 1 } };
    const provisioner = new InMemoryWorkspaceProvisioner({
      providerId: "test-memory",
      createWorkspaceId: () => "workspace-1",
      createRevision: () => "revision-1",
    });
    const provision = await provisioner.provision({
      executionId: "execution-1",
      taskId: "task-1",
      parameters,
    });
    parameters.nested.attempt = 2;

    expect(provision.descriptor).toEqual({
      workspaceId: "workspace-1",
      providerId: "test-memory",
      executionId: "execution-1",
      taskId: "task-1",
      revision: "revision-1",
      parameters: { branch: "feature", nested: { attempt: 1 } },
    });
    expect(Object.isFrozen(provision.descriptor)).toBe(true);
    expect(Object.isFrozen(provision.descriptor.parameters)).toBe(true);
    expect(JSON.parse(JSON.stringify(provision.descriptor))).toEqual(
      provision.descriptor,
    );
    expect(provision.descriptor).not.toHaveProperty("host");
    expect(provision.descriptor).not.toHaveProperty("release");
    expect(provision.host).toEqual({
      kind: "memory",
      workspaceId: "workspace-1",
    });
  });

  test("releases exactly once under concurrent calls", async () => {
    const provision = await new InMemoryWorkspaceProvisioner().provision({
      executionId: "execution-1",
      taskId: "task-1",
    });

    expect(
      (await Promise.all([provision.release(), provision.release()])).sort(),
    ).toEqual([false, true]);
    expect(await provision.release()).toBe(false);
  });

  test("provisions independent resources concurrently and rejects active collisions", async () => {
    let sequence = 0;
    const provisioner = new InMemoryWorkspaceProvisioner({
      createWorkspaceId: () => `workspace-${++sequence}`,
      createRevision: () => `revision-${sequence}`,
    });
    const provisions = await Promise.all(
      ["a", "b", "c"].map((taskId) =>
        provisioner.provision({ executionId: "execution-1", taskId }),
      ),
    );
    expect(provisions.map(({ descriptor }) => descriptor.workspaceId)).toEqual([
      "workspace-1",
      "workspace-2",
      "workspace-3",
    ]);

    const colliding = new InMemoryWorkspaceProvisioner({
      createWorkspaceId: () => "same-workspace",
    });
    await colliding.provision({ executionId: "execution-1", taskId: "a" });
    await expect(
      colliding.provision({ executionId: "execution-1", taskId: "b" }),
    ).rejects.toThrow("already active");
  });

  test("validates identities and JSON before allocating a resource", async () => {
    const provisioner = new InMemoryWorkspaceProvisioner();
    await expect(
      provisioner.provision({ executionId: "bad id", taskId: "task" }),
    ).rejects.toThrow("executionId");
    await expect(
      provisioner.provision({
        executionId: "execution",
        taskId: "task",
        parameters: { invalid: Number.NaN },
      }),
    ).rejects.toThrow("finite JSON numbers");
    await expect(
      provisioner.provision(
        { executionId: "execution", taskId: "task" },
        { signal: AbortSignal.abort(new Error("cancel provisioning")) },
      ),
    ).rejects.toThrow("cancel provisioning");
  });
});
