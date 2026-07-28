/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import {
  WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
  WORKFLOW_ORCHESTRATION_STATE_VERSION,
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import { WorkflowOwnershipController } from "../../../src/workflows/orchestration/ownership-controller.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";

describe("WorkflowOwnershipController", () => {
  test("bounds direct claims to the authenticated current lane", async () => {
    const { controller } = await harness();
    const grant = await controller.claim(
      scope({
        claims: [{ path: "src/a/file.ts", scope: "exact" }],
      }),
      actor("builder", "task-a"),
    );

    expect(grant).toMatchObject({
      taskId: "task-a",
      agentId: "builder",
      fencingToken: 1,
    });
    expect(Object.isFrozen(grant)).toBe(true);
    await expect(
      controller.claim(
        scope({ claims: [{ path: "src/b/file.ts", scope: "exact" }] }),
        actor("builder", "task-a"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PATH_NOT_OWNED" });
    await expect(
      controller.claim(
        scope({
          claims: [{ path: "src/workflows/index.ts", scope: "exact" }],
        }),
        actor("coordinator", "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_RESERVED_PATH" });
  });

  test("rejects forged, wrong-lane, and stale-plan actors", async () => {
    const { controller } = await harness();
    const request = scope({
      claims: [{ path: "src/a/file.ts", scope: "exact" }],
    });

    await expect(
      controller.claim(request, {
        actorId: "principal-builder",
        agentId: "builder",
        executionId: "execution-1",
      } as never),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      controller.claim(request, actor("builder", "task-b")),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      controller.claim(request, actor("builder", "task-a", 2)),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      controller.list(
        { executionId: "execution-1", planRevision: 2 },
        actor("builder", "task-a", 2),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_STALE" });
  });

  test("uses one CAS ledger so exactly one overlapping concurrent claim wins", async () => {
    const shared = await harness();
    const second = ownershipController(
      shared.plans,
      shared.state,
      shared.nextId,
      shared.now,
    );
    const request = scope({
      claims: [{ path: "src/a/concurrent.ts", scope: "exact" }],
    });

    const outcomes = await Promise.allSettled([
      shared.controller.claim(request, actor("builder", "task-a")),
      second.claim(request, actor("builder", "task-a")),
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = outcomes.find((item) => item.status === "rejected");
    expect(rejection).toMatchObject({
      reason: { code: "WORKFLOW_OWNERSHIP_CONFLICT" },
    });
    expect((await shared.state.get("execution-1"))?.grants).toHaveLength(1);
  });

  test("persists proposals and applies manager decisions atomically", async () => {
    const { controller, state } = await harness();
    const proposal = await controller.propose(
      scope({
        kind: "claim",
        targetTaskId: "task-a",
        claims: [{ path: "src/shared/new.ts", scope: "exact" }],
      }),
      actor("builder", "task-a"),
    );

    expect(proposal).toMatchObject({
      requestedByTaskId: "task-a",
      status: "pending",
    });
    const decided = await controller.approve(
      scope({ proposalId: proposal.proposalId, reason: "Approved handoff" }),
      actor("coordinator", "integration"),
    );
    expect(decided).toMatchObject({
      status: "approved",
      decidedByTaskId: "integration",
    });
    const current = await state.get("execution-1");
    expect(current?.proposals[0]).toEqual(decided);
    expect(current?.grants[0]).toMatchObject({
      taskId: "task-a",
      claims: [{ path: "src/shared/new.ts", scope: "exact" }],
      fencingToken: 1,
    });

    const rejected = await controller.propose(
      scope({
        kind: "claim",
        targetTaskId: "task-b",
        claims: [{ path: "src/shared/other.ts", scope: "exact" }],
      }),
      actor("builder", "task-a"),
    );
    await expect(
      controller.approve(
        scope({ proposalId: rejected.proposalId }),
        actor("builder", "task-a"),
      ),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    expect(
      await controller.reject(
        scope({ proposalId: rejected.proposalId, reason: "Not in this wave" }),
        actor("coordinator", "integration"),
      ),
    ).toMatchObject({ status: "rejected" });
  });

  test("transfers and releases atomically with monotonic fencing", async () => {
    const { controller, state } = await harness();
    const original = await controller.claim(
      scope({ claims: [{ path: "src/a/file.ts", scope: "exact" }] }),
      actor("builder", "task-a"),
    );
    const transferred = await controller.transfer(
      scope({ sourceGrantId: original.grantId, targetTaskId: "task-b" }),
      actor("coordinator", "integration"),
    );

    expect(transferred).toMatchObject({
      taskId: "task-b",
      agentId: "reviewer",
      fencingToken: 2,
    });
    await expect(
      controller.validateAuthority(
        scope({
          grantId: transferred.grantId,
          taskId: "task-b",
          agentId: "reviewer",
          fencingToken: original.fencingToken,
        }),
        actor("coordinator", "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_OWNERSHIP_STALE" });
    expect(
      await controller.validateAuthority(
        scope({
          grantId: transferred.grantId,
          taskId: "task-b",
          agentId: "reviewer",
          fencingToken: transferred.fencingToken,
          claims: [{ path: "src/a/file.ts", scope: "exact" }],
        }),
        actor("coordinator", "integration"),
      ),
    ).toEqual(transferred);
    expect(
      await controller.release(
        scope({ grantId: transferred.grantId }),
        actor("reviewer", "task-b"),
      ),
    ).toEqual(transferred);
    expect((await state.get("execution-1"))?.nextFencingToken).toBe(3);
    expect((await state.get("execution-1"))?.grants).toEqual([]);
  });

  test("proposal transfer and release are limited to the current owner", async () => {
    const { controller, state } = await harness();
    const original = await controller.claim(
      scope({ claims: [{ path: "src/a/file.ts", scope: "exact" }] }),
      actor("builder", "task-a"),
    );
    await expect(
      controller.propose(
        scope({
          kind: "transfer",
          sourceGrantId: original.grantId,
          targetTaskId: "task-b",
        }),
        actor("reviewer", "task-b"),
      ),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const transfer = await controller.propose(
      scope({
        kind: "transfer",
        sourceGrantId: original.grantId,
        targetTaskId: "task-b",
      }),
      actor("builder", "task-a"),
    );
    await controller.approve(
      scope({ proposalId: transfer.proposalId }),
      actor("coordinator", "integration"),
    );
    const moved = (await state.get("execution-1"))?.grants[0];
    const release = await controller.propose(
      scope({ kind: "release", sourceGrantId: moved?.grantId }),
      actor("reviewer", "task-b"),
    );
    await controller.approve(
      scope({ proposalId: release.proposalId }),
      actor("coordinator", "integration"),
    );
    expect((await state.get("execution-1"))?.grants).toEqual([]);
  });
});

async function harness() {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  await plans.put(plan());
  await state.create({
    protocol: WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
    version: WORKFLOW_ORCHESTRATION_STATE_VERSION,
    executionId: "execution-1",
    revision: 1,
    activePlanRevision: 1,
    nextFencingToken: 1,
    grants: [],
    proposals: [],
    updatedAt: 1,
  });
  let id = 0;
  let timestamp = 1;
  const nextId = (kind: "grant" | "proposal") => `${kind}-${++id}`;
  const now = () => ++timestamp;
  return {
    controller: ownershipController(plans, state, nextId, now),
    plans,
    state,
    nextId,
    now,
  };
}

function ownershipController(
  plans: InMemoryWorkflowPlanStore,
  state: InMemoryWorkflowOrchestrationStateStore,
  createId: (kind: "grant" | "proposal") => string,
  now: () => number,
) {
  return new WorkflowOwnershipController({
    plans,
    state,
    createId,
    now,
    authorizer: {
      authorize(request) {
        return request.actorId === `principal-${request.agentId}`;
      },
    },
  });
}

function actor(
  agentId: string,
  taskId: string,
  planRevision = 1,
): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-1",
    taskId,
    planRevision,
  });
}

function scope<T extends Record<string, unknown>>(value: T) {
  return { executionId: "execution-1", planRevision: 1, ...value };
}

function plan(): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "7d2a11e",
    objective: "Test durable ownership control",
    status: "ready",
    createdAt: 1,
    agents: [
      {
        agentId: "builder",
        policy: {
          role: "worker",
          permissions: [
            "plan:read",
            "ownership:claim",
            "ownership:propose",
            "ownership:release",
          ],
          canDelegate: false,
        },
      },
      {
        agentId: "reviewer",
        policy: {
          role: "worker",
          permissions: [
            "plan:read",
            "ownership:claim",
            "ownership:propose",
            "ownership:release",
          ],
          canDelegate: false,
        },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: [
            "plan:read",
            "ownership:claim",
            "ownership:approve",
            "ownership:transfer",
            "ownership:release",
            "changes:validate",
          ],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
        },
      },
    ],
    lanes: [
      {
        taskId: "task-a",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "src/a", scope: "subtree" }],
        mayCreateUnder: ["tests/a"],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
      {
        taskId: "task-b",
        agentId: "reviewer",
        role: "worker",
        ownedPaths: [{ path: "src/b", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: ["task-a", "task-b"],
        acceptance: ["Full CI passes"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["task-a", "task-b"] },
      { waveId: "wave-2", taskIds: ["integration"] },
    ],
    invariants: [],
    reservedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
  };
}
