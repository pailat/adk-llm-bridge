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
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";
import { WorkflowOrchestrationTaskAuthorityPort } from "../../../src/workflows/orchestration/task-authority.js";
import type {
  WorkflowTaskClaimGuard,
  WorkflowTaskRecord,
} from "../../../src/workflows/tasks/contracts.js";

describe("WorkflowOrchestrationTaskAuthorityPort", () => {
  test("derives ordered root authority and ignores an untrusted binding hint", async () => {
    const { authority } = await harness();
    const binding = await authority.resolveRoot({
      capability: actor("architect", "root"),
      request: {
        executionId: "execution-1",
        taskId: "root",
        agentId: "architect",
        orchestration: {
          planRevision: 99,
          ownership: [{ grantId: "forged", fencingToken: 99 }],
        },
      },
    });

    expect(binding).toEqual({
      planRevision: 1,
      ownership: [
        { grantId: "grant-a", fencingToken: 2 },
        { grantId: "grant-z", fencingToken: 1 },
      ],
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.ownership)).toBe(true);
  });

  test("rejects forged, stale, and wrong-target root capabilities", async () => {
    const { authority } = await harness();
    const request = {
      executionId: "execution-1",
      taskId: "root",
      agentId: "architect",
    } as const;

    await expect(
      authority.resolveRoot({
        capability: JSON.parse(
          '{"actorId":"principal-architect","agentId":"architect","executionId":"execution-1","taskId":"root","planRevision":1}',
        ),
        request,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      authority.resolveRoot({
        capability: actor("architect", "root", 2),
        request,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      authority.resolveRoot({
        capability: actor("worker", "child"),
        request,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("derives a dependent child's own grants without inheritance", async () => {
    const { authority } = await harness();
    const parent = parentRecord();

    const binding = await authority.deriveChild({
      parent,
      parentClaim: claimGuard(parent),
      request: { taskId: "child", agentId: "worker" },
    });

    expect(binding).toEqual({
      planRevision: 1,
      ownership: [{ grantId: "grant-child", fencingToken: 3 }],
    });
    expect(binding.ownership.map((grant) => grant.grantId)).not.toContain(
      "grant-a",
    );
  });

  test("denies child delegation without policy, role, dependency, or a live parent claim", async () => {
    const noDelegation = await harness({
      mutatePlan(value) {
        return changeParentPolicy(value, {
          canDelegate: false,
          allowedDelegateRoles: [],
        });
      },
    });
    await expect(
      derive(noDelegation.authority, parentRecord()),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const wrongRole = await harness({
      mutatePlan(value) {
        return changeParentPolicy(value, {
          canDelegate: true,
          allowedDelegateRoles: ["critic"],
        });
      },
    });
    await expect(
      derive(wrongRole.authority, parentRecord()),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const noDependency = await harness({
      mutatePlan(value) {
        return {
          ...value,
          lanes: value.lanes.map((lane) =>
            lane.taskId === "child" ? { ...lane, dependsOn: [] } : lane,
          ),
        };
      },
    });
    await expect(
      derive(noDependency.authority, parentRecord()),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });

    const expired = parentRecord({
      claim: { ...parentRecord().claim, expiresAt: 10 },
    });
    await expect(derive(noDependency.authority, expired)).rejects.toMatchObject(
      {
        code: "WORKFLOW_OWNERSHIP_STALE",
      },
    );
  });

  test("fences stale ownership before an attempt executes", async () => {
    const { authority } = await harness();
    const current = childRecord();
    await expect(
      authority.validateAttempt({ task: current, claim: claimGuard(current) }),
    ).resolves.toBeUndefined();

    const stale = childRecord({
      orchestration: {
        planRevision: 1,
        ownership: [{ grantId: "grant-child", fencingToken: 2 }],
      },
    });
    await expect(
      authority.validateAttempt({ task: stale, claim: claimGuard(stale) }),
    ).rejects.toMatchObject({ code: "WORKFLOW_OWNERSHIP_STALE" });

    const missingGrant = childRecord({
      orchestration: { planRevision: 1, ownership: [] },
    });
    await expect(
      authority.validateAttempt({
        task: missingGrant,
        claim: claimGuard(missingGrant),
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_OWNERSHIP_STALE" });
  });

  test("authenticates a mailbox sender and rejects sender spoofing", async () => {
    const { authority } = await harness();
    const sender = childRecord();

    await expect(
      authority.validateAuthenticatedSender({
        actor: actor("worker", "child"),
        sender,
      }),
    ).resolves.toBeUndefined();
    await expect(
      authority.validateAuthenticatedSender({
        actor: actor("architect", "root"),
        sender,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      authority.validateAuthenticatedSender({
        actor: {
          actorId: "principal-worker",
          agentId: "worker",
          taskId: "child",
        } as never,
        sender,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("rejects a task binding after the active plan changes", async () => {
    const { authority, plans, state } = await harness();
    const nextPlan = {
      ...plan(),
      planRevision: 2,
      baseRevision: "next",
      createdAt: 2,
    } satisfies WorkflowPlan;
    await plans.put(nextPlan);
    const current = await state.get("execution-1");
    if (!current) throw new Error("Expected state");
    await state.compareAndSet(
      {
        ...current,
        revision: current.revision + 1,
        activePlanRevision: 2,
        grants: [],
        proposals: [],
        reservations: [],
        updatedAt: current.updatedAt + 1,
      },
      current.revision,
    );

    const record = childRecord();
    await expect(
      authority.validateAttempt({ task: record, claim: claimGuard(record) }),
    ).rejects.toMatchObject({ code: "WORKFLOW_OWNERSHIP_STALE" });
  });
});

interface HarnessOptions {
  mutatePlan?(value: WorkflowPlan): WorkflowPlan;
}

async function harness(options: HarnessOptions = {}) {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  const value = options.mutatePlan?.(plan()) ?? plan();
  await plans.put(value);
  await state.create(orchestrationState());
  const authority = new WorkflowOrchestrationTaskAuthorityPort({
    plans,
    state,
    now: () => 10,
    authorizer: {
      authorize(request) {
        return request.actorId === `principal-${request.agentId}`;
      },
    },
  });
  return { authority, plans, state };
}

async function derive(
  authority: WorkflowOrchestrationTaskAuthorityPort,
  parent: WorkflowTaskRecord,
) {
  return await authority.deriveChild({
    parent: parent as WorkflowTaskRecord & {
      readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
    },
    parentClaim: claimGuard(parent),
    request: { taskId: "child", agentId: "worker" },
  });
}

function actor(agentId: string, taskId: string, planRevision = 1) {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-1",
    taskId,
    planRevision,
  });
}

function parentRecord(
  overrides: Partial<WorkflowTaskRecord> = {},
): WorkflowTaskRecord & {
  readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
} {
  return {
    executionId: "execution-1",
    taskId: "root",
    agentId: "architect",
    status: "running",
    revision: 2,
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 2,
    claim: {
      workerId: "host-1",
      leaseId: "lease-root",
      fencingToken: 7,
      claimedAt: 2,
      heartbeatAt: 2,
      expiresAt: 100,
    },
    orchestration: {
      planRevision: 1,
      ownership: [
        { grantId: "grant-a", fencingToken: 2 },
        { grantId: "grant-z", fencingToken: 1 },
      ],
    },
    ...overrides,
  } as WorkflowTaskRecord & {
    readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
  };
}

function childRecord(
  overrides: Partial<WorkflowTaskRecord> = {},
): WorkflowTaskRecord & {
  readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
} {
  return {
    executionId: "execution-1",
    taskId: "child",
    parentTaskId: "root",
    agentId: "worker",
    status: "running",
    revision: 2,
    attempt: 1,
    createdAt: 2,
    updatedAt: 3,
    startedAt: 3,
    claim: {
      workerId: "host-1",
      leaseId: "lease-child",
      fencingToken: 4,
      claimedAt: 3,
      heartbeatAt: 3,
      expiresAt: 100,
    },
    orchestration: {
      planRevision: 1,
      ownership: [{ grantId: "grant-child", fencingToken: 3 }],
    },
    ...overrides,
  } as WorkflowTaskRecord & {
    readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
  };
}

function claimGuard(record: WorkflowTaskRecord): WorkflowTaskClaimGuard {
  if (!record.claim) throw new Error("Expected claim");
  return {
    executionId: record.executionId,
    taskId: record.taskId,
    workerId: record.claim.workerId,
    leaseId: record.claim.leaseId,
    fencingToken: record.claim.fencingToken,
  };
}

function changeParentPolicy(
  value: WorkflowPlan,
  changes: {
    canDelegate: boolean;
    allowedDelegateRoles: readonly (
      | "architect"
      | "worker"
      | "integration"
      | "critic"
    )[];
  },
): WorkflowPlan {
  return {
    ...value,
    agents: value.agents.map((agent) => {
      if (agent.agentId !== "architect") return agent;
      const { maxChildren, ...policy } = agent.policy;
      return {
        ...agent,
        policy: {
          ...policy,
          ...changes,
          ...(changes.canDelegate && maxChildren !== undefined
            ? { maxChildren }
            : {}),
        },
      };
    }),
  };
}

function plan(): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "823d8b1",
    objective: "Derive task authority from active ownership",
    status: "ready",
    createdAt: 1,
    agents: [
      {
        agentId: "architect",
        policy: {
          role: "architect",
          permissions: ["plan:read", "task:spawn", "task:mailbox:send"],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
          maxChildren: 2,
        },
      },
      {
        agentId: "worker",
        policy: {
          role: "worker",
          permissions: ["plan:read", "task:mailbox:send"],
          canDelegate: false,
        },
      },
    ],
    lanes: [
      {
        taskId: "root",
        agentId: "architect",
        role: "architect",
        ownedPaths: [{ path: "src/root", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Delegation is bounded"],
      },
      {
        taskId: "child",
        agentId: "worker",
        role: "worker",
        ownedPaths: [{ path: "src/child", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: ["root"],
        acceptance: ["Task is fenced"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["root"] },
      { waveId: "wave-2", taskIds: ["child"] },
    ],
    invariants: [],
    reservedPaths: [],
  };
}

function orchestrationState(): WorkflowOrchestrationState {
  return {
    protocol: WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
    version: WORKFLOW_ORCHESTRATION_STATE_VERSION,
    executionId: "execution-1",
    revision: 1,
    activePlanRevision: 1,
    nextFencingToken: 4,
    grants: [
      {
        grantId: "grant-z",
        taskId: "root",
        agentId: "architect",
        planRevision: 1,
        fencingToken: 1,
        claims: [{ path: "src/root/z.ts", scope: "exact" }],
        grantedAt: 1,
      },
      {
        grantId: "grant-a",
        taskId: "root",
        agentId: "architect",
        planRevision: 1,
        fencingToken: 2,
        claims: [{ path: "src/root/a.ts", scope: "exact" }],
        grantedAt: 1,
      },
      {
        grantId: "grant-child",
        taskId: "child",
        agentId: "worker",
        planRevision: 1,
        fencingToken: 3,
        claims: [{ path: "src/child/file.ts", scope: "exact" }],
        grantedAt: 1,
      },
    ],
    proposals: [],
    reservations: [],
    updatedAt: 1,
  };
}
