/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
  WORKFLOW_ORCHESTRATION_STATE_VERSION,
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";

describe("InMemoryWorkflowPlanStore", () => {
  test("keeps immutable plan revisions and lists them in order", async () => {
    const store = new InMemoryWorkflowPlanStore();
    const metadata = { version: 1 };
    const mutable = plan({
      agents: plan().agents.map((agent, index) =>
        index === 0 ? { ...agent, metadata } : agent,
      ),
    });
    const first = await store.put(mutable);
    const second = await store.put(plan({ planRevision: 2, createdAt: 2 }));

    metadata.version = 2;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.agents)).toBe(true);
    expect(first.agents[0]?.metadata).toEqual({ version: 1 });
    expect(await store.get("execution-1", 1)).toBe(first);
    expect(await store.list("execution-1")).toEqual([first, second]);
    expect(Object.isFrozen(await store.list("execution-1"))).toBe(true);
  });

  test("rejects duplicate revision keys without rewriting the plan", async () => {
    const store = new InMemoryWorkflowPlanStore();
    const original = await store.put(plan());

    await expect(
      store.put(plan({ objective: "A different immutable plan" })),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_DUPLICATE" });
    expect(await store.get("execution-1", 1)).toBe(original);
  });
});

describe("InMemoryWorkflowOrchestrationStateStore", () => {
  test("allows exactly one concurrent aggregate CAS", async () => {
    const store = new InMemoryWorkflowOrchestrationStateStore();
    const initial = await store.create(state());
    const left = {
      ...initial,
      revision: 2,
      nextFencingToken: 3,
      updatedAt: 2,
    };
    const right = {
      ...initial,
      revision: 2,
      updatedAt: 2,
    };

    const results = await Promise.allSettled([
      store.compareAndSet(left, 1),
      store.compareAndSet(right, 1),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "WORKFLOW_PLAN_REVISION_CONFLICT" },
    });
    expect((await store.get("execution-1"))?.revision).toBe(2);
  });

  test("rejects stale fencing space, backwards plan activation, and invalid revision", async () => {
    const store = new InMemoryWorkflowOrchestrationStateStore();
    const initial = await store.create(
      state({
        activePlanRevision: 2,
        grants: state().grants.map((grant) => ({ ...grant, planRevision: 2 })),
        proposals: state().proposals.map((proposal) => ({
          ...proposal,
          planRevision: 2,
        })),
      }),
    );

    await expect(
      store.compareAndSet({ ...initial, revision: 3, updatedAt: 2 }, 1),
    ).rejects.toMatchObject({ code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST" });
    await expect(
      store.compareAndSet(
        { ...initial, revision: 2, activePlanRevision: 1, updatedAt: 2 },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST" });
    await expect(
      store.compareAndSet(
        { ...initial, revision: 2, nextFencingToken: 1, updatedAt: 2 },
        1,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST" });
  });

  test("requires revision one on create and rejects duplicate aggregates", async () => {
    const store = new InMemoryWorkflowOrchestrationStateStore();
    await expect(store.create(state({ revision: 2 }))).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
    });
    await store.create(state());
    await expect(store.create(state())).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_STATE_DUPLICATE",
    });
  });
});

function plan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "a4fbcf1",
    objective: "Implement durable orchestration",
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
        acceptance: ["Tests pass"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: ["implementation"],
        acceptance: ["CI passes"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["implementation"] },
      { waveId: "wave-2", taskIds: ["integration"] },
    ],
    invariants: [
      {
        invariantId: "owned-diff",
        description: "Every changed path must be owned",
        appliesTo: "changes",
        enforcedBy: "control-plane",
      },
    ],
    reservedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
    ...overrides,
  };
}

function state(
  overrides: Partial<WorkflowOrchestrationState> = {},
): WorkflowOrchestrationState {
  return {
    protocol: WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
    version: WORKFLOW_ORCHESTRATION_STATE_VERSION,
    executionId: "execution-1",
    revision: 1,
    activePlanRevision: 1,
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
    proposals: [
      {
        proposalId: "proposal-1",
        kind: "claim",
        requestedByTaskId: "implementation",
        targetTaskId: "implementation",
        planRevision: 1,
        claims: [{ path: "tests/workflows/tasks", scope: "subtree" }],
        status: "pending",
        createdAt: 1,
      },
    ],
    updatedAt: 1,
    ...overrides,
  };
}
