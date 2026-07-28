/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import {
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import { WorkflowPlanController } from "../../../src/workflows/orchestration/plan-controller.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";

describe("WorkflowPlanController", () => {
  test("persists only ready immutable plans and reads them through both authorization gates", async () => {
    const { controller } = harness();
    const coordinator = actor("coordinator", 1, "integration");
    const stored = await controller.put(plan(), coordinator);

    expect(Object.isFrozen(stored)).toBe(true);
    expect(await controller.get("execution-1", 1, coordinator)).toBe(stored);
    expect(await controller.list("execution-1", coordinator)).toEqual([stored]);
    await expect(
      controller.put(plan({ status: "draft" }), coordinator),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    });
  });

  test("denies absent, forged, wrong, and default-denied actors", async () => {
    const configured = harness();
    const value = plan();

    await expect(
      configured.controller.put(
        value,
        JSON.parse(
          '{"actorId":"principal-coordinator","agentId":"coordinator","executionId":"execution-1"}',
        ),
      ),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      configured.controller.put(value, actor("builder", 1, "implementation")),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const denied = new WorkflowPlanController({
      plans: new InMemoryWorkflowPlanStore(),
      state: new InMemoryWorkflowOrchestrationStateStore(),
      authorizer: { authorize: () => true },
    });
    await expect(
      denied.put(value, actor("coordinator", 1, "integration")),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("activates concurrently with CAS and makes the same revision idempotent", async () => {
    const plans = new InMemoryWorkflowPlanStore();
    const state = new InMemoryWorkflowOrchestrationStateStore();
    const first = harness({ plans, state }).controller;
    const second = harness({ plans, state }).controller;
    const coordinator = actor("coordinator", 1, "integration");
    await first.put(plan(), coordinator);

    const activations = await Promise.all([
      first.activate("execution-1", 1, coordinator),
      second.activate("execution-1", 1, coordinator),
    ]);

    expect(activations[0]).toMatchObject({
      revision: 1,
      activePlanRevision: 1,
      nextFencingToken: 1,
      grants: [],
      proposals: [],
    });
    expect(activations[1]).toBe(activations[0]);
  });

  test("only advances active revisions, clears old authority, and preserves fencing monotonicity", async () => {
    let now = 1;
    const plans = new InMemoryWorkflowPlanStore();
    const state = new InMemoryWorkflowOrchestrationStateStore();
    const controller = harness({ plans, state, now: () => now++ }).controller;
    const firstActor = actor("coordinator", 1, "integration");
    await controller.put(plan(), firstActor);
    const active = await controller.activate("execution-1", 1, firstActor);
    await controller.put(plan({ planRevision: 2, createdAt: 2 }), firstActor);
    await state.compareAndSet(
      {
        ...active,
        revision: 2,
        nextFencingToken: 2,
        grants: [
          {
            grantId: "grant-1",
            taskId: "implementation",
            agentId: "builder",
            planRevision: 1,
            fencingToken: 1,
            claims: [{ path: "src/workflows/tasks", scope: "subtree" }],
            grantedAt: active.updatedAt,
          },
        ],
        proposals: [],
        updatedAt: active.updatedAt + 1,
      },
      1,
    );

    const advanced = await controller.activate("execution-1", 2, firstActor);
    expect(advanced).toMatchObject({
      revision: 3,
      activePlanRevision: 2,
      nextFencingToken: 2,
      grants: [],
      proposals: [],
    });
    await expect(
      controller.activate("execution-1", 1, firstActor),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("reports missing plans without creating orchestration state", async () => {
    const { controller, state } = harness();

    await expect(
      controller.get("execution-1", 7, actor("coordinator", 7, "integration")),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_NOT_FOUND" });
    await expect(
      controller.activate(
        "execution-1",
        7,
        actor("coordinator", 7, "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_NOT_FOUND" });
    expect(await state.get("execution-1")).toBeUndefined();
  });

  test("requires the logical plan role and permission even after host authorization", async () => {
    const { controller, plans } = harness();
    await plans.put(plan());
    const builder = actor("builder", 1, "implementation");

    expect(await controller.get("execution-1", 1, builder)).toMatchObject({
      planRevision: 1,
    });
    await expect(
      controller.activate("execution-1", 1, builder),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("requires explicit bootstrap authority for the first plan", async () => {
    const plans = new InMemoryWorkflowPlanStore();
    const state = new InMemoryWorkflowOrchestrationStateStore();
    const hostAllows = { authorize: () => true };
    const denied = new WorkflowPlanController({
      plans,
      state,
      authorizer: hostAllows,
    });

    await expect(
      denied.put(plan(), actor("coordinator", 1, "integration")),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const allowed = new WorkflowPlanController({
      plans,
      state,
      authorizer: hostAllows,
      bootstrapAuthorizer: hostAllows,
      now: () => 1,
    });
    await expect(
      allowed.put(plan(), actor("coordinator", 1, "integration")),
    ).resolves.toMatchObject({ planRevision: 1 });
  });

  test("never lets a candidate plan authorize its own revision", async () => {
    const { controller } = harness();
    const coordinator = actor("coordinator", 1, "integration");
    await controller.put(plan(), coordinator);
    await controller.activate("execution-1", 1, coordinator);
    const elevatedCandidate = plan({
      planRevision: 2,
      createdAt: 2,
      agents: [
        ...plan().agents,
        {
          agentId: "intruder",
          policy: {
            role: "architect",
            permissions: ["plan:read", "plan:activate"],
            canDelegate: false,
          },
        },
      ],
      lanes: [
        ...plan().lanes,
        {
          taskId: "intruder-task",
          agentId: "intruder",
          role: "architect",
          ownedPaths: [],
          mayCreateUnder: [],
          dependsOn: [],
          acceptance: ["Candidate cannot authorize itself"],
        },
      ],
      waves: [
        { waveId: "wave-0", taskIds: ["intruder-task"] },
        ...plan().waves,
      ],
    });

    await expect(
      controller.put(elevatedCandidate, actor("intruder", 1, "intruder-task")),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("uses the active plan to authorize and activate the next revision", async () => {
    const { controller } = harness();
    const coordinator = actor("coordinator", 1, "integration");
    await controller.put(plan(), coordinator);
    await controller.activate("execution-1", 1, coordinator);
    const candidate = plan({
      planRevision: 2,
      createdAt: 2,
      agents: plan().agents.map((agent) =>
        agent.agentId === "coordinator"
          ? {
              ...agent,
              policy: { ...agent.policy, permissions: ["plan:read"] },
            }
          : agent,
      ),
    });

    await controller.put(candidate, coordinator);
    await expect(
      controller.activate("execution-1", 2, coordinator),
    ).resolves.toMatchObject({ activePlanRevision: 2, reservations: [] });
  });

  test("blocks plan activation while a host mutation reservation is active", async () => {
    const { controller, state } = harness();
    const coordinator = actor("coordinator", 1, "integration");
    await controller.put(plan(), coordinator);
    const active = await controller.activate("execution-1", 1, coordinator);
    await controller.put(plan({ planRevision: 2, createdAt: 2 }), coordinator);
    await state.compareAndSet(
      {
        ...active,
        revision: 2,
        nextFencingToken: 2,
        grants: [
          {
            grantId: "grant-1",
            taskId: "implementation",
            agentId: "builder",
            planRevision: 1,
            fencingToken: 1,
            claims: [{ path: "src/workflows/tasks", scope: "subtree" }],
            grantedAt: 1,
          },
        ],
        reservations: [
          {
            reservationId: "reservation-1",
            receiptId: "receipt-1",
            phase: "commit",
            taskId: "implementation",
            agentId: "builder",
            planRevision: 1,
            orchestrationRevision: 2,
            grants: [{ grantId: "grant-1", fencingToken: 1 }],
            changeSetDigest: `sha256:${"a".repeat(64)}`,
            treeId: "tree-1",
            status: "reserved",
            createdAt: 1,
            expiresAt: 100,
          },
        ],
        updatedAt: 2,
      },
      1,
    );

    await expect(
      controller.activate("execution-1", 2, coordinator),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });

    const reserved = await state.get("execution-1");
    if (!reserved) throw new Error("expected orchestration state");
    await state.compareAndSet(
      {
        ...reserved,
        revision: reserved.revision + 1,
        reservations: reserved.reservations?.map((reservation) => ({
          ...reservation,
          status: "completed" as const,
          commitId: "commit-1",
          completedAt: 3,
        })),
        updatedAt: 3,
      },
      reserved.revision,
    );
    await expect(
      controller.activate("execution-1", 2, coordinator),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });
  });

  test("lazily ignores expired reservations during plan activation", async () => {
    let now = 1;
    const { controller, state } = harness({ now: () => now });
    const coordinator = actor("coordinator", 1, "integration");
    await controller.put(plan(), coordinator);
    const active = await controller.activate("execution-1", 1, coordinator);
    await controller.put(plan({ planRevision: 2, createdAt: 2 }), coordinator);
    await state.compareAndSet(
      {
        ...active,
        revision: 2,
        nextFencingToken: 2,
        grants: [
          {
            grantId: "grant-1",
            taskId: "implementation",
            agentId: "builder",
            planRevision: 1,
            fencingToken: 1,
            claims: [{ path: "src/workflows/tasks", scope: "subtree" }],
            grantedAt: 1,
          },
        ],
        reservations: [
          {
            reservationId: "reservation-expired",
            receiptId: "receipt-expired",
            phase: "commit",
            taskId: "implementation",
            agentId: "builder",
            planRevision: 1,
            orchestrationRevision: 2,
            grants: [{ grantId: "grant-1", fencingToken: 1 }],
            changeSetDigest: `sha256:${"d".repeat(64)}`,
            treeId: "tree-expired",
            status: "reserved",
            createdAt: 1,
            expiresAt: 10,
          },
        ],
        updatedAt: 2,
      },
      1,
    );

    now = 11;
    await expect(
      controller.activate("execution-1", 2, coordinator),
    ).resolves.toMatchObject({ activePlanRevision: 2, reservations: [] });
  });
});

function harness(
  overrides: {
    plans?: InMemoryWorkflowPlanStore;
    state?: InMemoryWorkflowOrchestrationStateStore;
    now?: () => number;
  } = {},
) {
  const plans = overrides.plans ?? new InMemoryWorkflowPlanStore();
  const state =
    overrides.state ?? new InMemoryWorkflowOrchestrationStateStore();
  const controller = new WorkflowPlanController({
    plans,
    state,
    authorizer: {
      authorize(request) {
        return request.actorId === `principal-${request.agentId}`;
      },
    },
    bootstrapAuthorizer: {
      authorize(request) {
        return (
          request.actorId === `principal-${request.agentId}` &&
          request.agentId === "coordinator" &&
          request.taskId === "integration"
        );
      },
    },
    now: overrides.now ?? (() => 1),
  });
  return { controller, plans, state };
}

function actor(
  agentId: string,
  planRevision: number,
  taskId: string,
): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-1",
    taskId,
    planRevision,
  });
}

function plan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "a4fbcf1",
    objective: "Implement authorized workflow plan lifecycle",
    status: "ready",
    createdAt: 1,
    agents: [
      {
        agentId: "builder",
        policy: {
          role: "worker",
          permissions: ["plan:read", "ownership:claim"],
          canDelegate: false,
        },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: ["plan:read", "plan:activate", "integration:publish"],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
        },
      },
    ],
    lanes: [
      {
        taskId: "implementation",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "src/workflows/tasks", scope: "subtree" }],
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
        dependsOn: ["implementation"],
        acceptance: ["Full CI passes"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["implementation"] },
      { waveId: "wave-2", taskIds: ["integration"] },
    ],
    invariants: [],
    reservedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
    ...overrides,
  };
}
