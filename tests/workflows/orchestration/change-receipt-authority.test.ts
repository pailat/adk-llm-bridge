/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import { WorkflowLiveChangeReceiptAuthority } from "../../../src/workflows/orchestration/change-receipt-authority.js";
import { WorkflowOwnershipChangeSetValidator } from "../../../src/workflows/orchestration/change-set-validator.js";
import {
  WORKFLOW_ORCHESTRATION_STATE_PROTOCOL,
  WORKFLOW_ORCHESTRATION_STATE_VERSION,
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import { WorkflowOwnershipController } from "../../../src/workflows/orchestration/ownership-controller.js";
import {
  InMemoryWorkflowChangeReceiptStore,
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";
import {
  createWorkflowChangeSet,
  type WorkflowAuthoritativeCommitResult,
} from "../../../src/workflows/workspace/change-driver.js";
import { InMemoryWorkflowHostMutationJournal } from "../../../src/workflows/workspace/mutation-journal.js";

const COMMIT_INTENT = `sha256:${"a".repeat(64)}`;
const INTEGRATION_INTENT = `sha256:${"b".repeat(64)}`;
const CONTENT_DIGEST = `sha256:${"c".repeat(64)}`;

describe("WorkflowLiveChangeReceiptAuthority", () => {
  test("makes racing acquire retries idempotent on one durable reservation", async () => {
    const context = await harness();
    const request = commitRequest(context);
    const outcomes = await Promise.allSettled([
      context.authority.acquireCommit(request),
      context.authority.acquireCommit(request),
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      2,
    );
    expect((await context.state.get("execution-1"))?.reservations).toHaveLength(
      1,
    );
  });

  test("rejects forged receipts and receipts whose ownership fence became stale", async () => {
    const forged = await harness();
    await expect(
      forged.authority.acquireCommit({
        ...commitRequest(forged),
        receipt: { ...forged.receipt, workspaceRevision: "forged-tree" },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });

    const stale = await harness();
    await stale.ownership.transfer(
      {
        executionId: "execution-1",
        planRevision: 1,
        sourceGrantId: stale.grantId,
        targetTaskId: "task-b",
      },
      actor("coordinator", "integration"),
    );
    await expect(
      stale.authority.acquireCommit(commitRequest(stale)),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });
  });

  test("blocks ownership movement while reserved and completes exact commit/integration linkage", async () => {
    const context = await harness();
    const commitLease = await context.authority.acquireCommit(
      commitRequest(context),
    );
    await expect(
      context.ownership.transfer(
        {
          executionId: "execution-1",
          planRevision: 1,
          sourceGrantId: context.grantId,
          targetTaskId: "task-b",
        },
        actor("coordinator", "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });

    const commit = commitResult(context);
    await context.authority.completeCommit(commitLease, commit);
    await context.authority.release(commitLease);
    await expect(
      context.ownership.transfer(
        {
          executionId: "execution-1",
          planRevision: 1,
          sourceGrantId: context.grantId,
          targetTaskId: "task-b",
        },
        actor("coordinator", "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });
    expect(
      await context.authority.reconcile({
        kind: "commit",
        operationId: "commit-op",
        intentDigest: COMMIT_INTENT,
      }),
    ).toEqual({ status: "completed" });

    await expect(
      context.authority.acquireIntegration({
        ...integrationRequest(context, commit),
        commit: { ...commit, treeId: "wrong-tree" },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });

    const integrationLease = await context.authority.acquireIntegration(
      integrationRequest(context, commit),
    );
    await context.authority.completeIntegration(integrationLease, {
      integrationId: "integration-1",
      commitId: "commit-1",
      targetId: "integration",
      previousRevision: "target-1",
      integratedRevision: "commit-1",
      integratedAt: 120,
    });
    await context.authority.release(integrationLease);
    expect(
      await context.authority.reconcile({
        kind: "integration",
        operationId: "integration-op",
        intentDigest: INTEGRATION_INTENT,
      }),
    ).toEqual({ status: "completed" });

    await expect(
      context.ownership.transfer(
        {
          executionId: "execution-1",
          planRevision: 1,
          sourceGrantId: context.grantId,
          targetTaskId: "task-b",
        },
        actor("coordinator", "integration"),
      ),
    ).resolves.toMatchObject({ taskId: "task-b" });
  });

  test("reconstructs a lease after restart and replays exact completion", async () => {
    const context = await harness();
    const original = await context.authority.acquireCommit(
      commitRequest(context),
    );
    const restarted = context.createAuthority();
    const recovered = await restarted.acquireCommit(commitRequest(context));

    expect(recovered).not.toBe(original);
    expect(recovered).toEqual(original);
    await restarted.completeCommit(recovered, commitResult(context));

    const replayed = context.createAuthority();
    const completedLease = await replayed.acquireCommit(commitRequest(context));
    await replayed.completeCommit(completedLease, commitResult(context));
    await expect(
      replayed.completeCommit(completedLease, {
        ...commitResult(context),
        commitId: "different-commit",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_CHANGE_AUTHORITY_INVALID" });
  });

  test("keeps completed commits fenced until explicit abandonment", async () => {
    const context = await harness();
    const lease = await context.authority.acquireCommit(commitRequest(context));
    await context.authority.completeCommit(lease, commitResult(context));

    await context.authority.abandonCommit(lease);
    await expect(
      context.ownership.transfer(
        {
          executionId: "execution-1",
          planRevision: 1,
          sourceGrantId: context.grantId,
          targetTaskId: "task-b",
        },
        actor("coordinator", "integration"),
      ),
    ).resolves.toMatchObject({ taskId: "task-b" });
  });

  test("renews an expired reservation by CAS when authority is still live", async () => {
    let now = 100;
    const context = await harness(() => now);
    const first = await context.authority.acquireCommit(commitRequest(context));
    now = 111;
    const recovered = await context
      .createAuthority()
      .acquireCommit(commitRequest(context));

    expect(recovered).toEqual(first);
    expect(
      (await context.state.get("execution-1"))?.reservations?.[0]?.expiresAt,
    ).toBe(121);
    await expect(
      context.ownership.transfer(
        {
          executionId: "execution-1",
          planRevision: 1,
          sourceGrantId: context.grantId,
          targetTaskId: "task-b",
        },
        actor("coordinator", "integration"),
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_MUTATION_RESERVATION_ACTIVE" });
  });

  test("accepts a deterministic late completion while fences remain live", async () => {
    let now = 100;
    const context = await harness(() => now);
    const lease = await context.authority.acquireCommit(commitRequest(context));
    now = 111;

    await expect(
      context.authority.completeCommit(lease, commitResult(context)),
    ).resolves.toBeUndefined();
    expect(
      (await context.state.get("execution-1"))?.reservations?.[0]?.status,
    ).toBe("completed");
  });

  test("marks a late host result ambiguous when expired authority moved", async () => {
    let now = 100;
    const context = await harness(() => now);
    const lease = await context.authority.acquireCommit(commitRequest(context));
    now = 111;
    await context.ownership.transfer(
      {
        executionId: "execution-1",
        planRevision: 1,
        sourceGrantId: context.grantId,
        targetTaskId: "task-b",
      },
      actor("coordinator", "integration"),
    );

    await expect(
      context.authority.completeCommit(lease, commitResult(context)),
    ).rejects.toThrow("ambiguous");
    await expect(context.authority.release(lease)).resolves.toBeUndefined();
    expect(
      await context.authority.reconcile({
        kind: "commit",
        operationId: "commit-op",
        intentDigest: COMMIT_INTENT,
      }),
    ).toEqual({ status: "ambiguous" });
  });

  test("makes a superseded late result ambiguous without breaking release", async () => {
    let now = 100;
    const context = await harness(() => now);
    const lease = await context.authority.acquireCommit(commitRequest(context));
    now = 111;
    const current = await context.state.get("execution-1");
    if (!current) throw new Error("expected orchestration state");
    await context.state.compareAndSet(
      {
        ...current,
        revision: current.revision + 1,
        activePlanRevision: 2,
        grants: [],
        reservations: [],
        updatedAt: now,
      },
      current.revision,
    );

    await expect(
      context.authority.completeCommit(lease, commitResult(context)),
    ).rejects.toThrow("ambiguous");
    await expect(context.authority.release(lease)).resolves.toBeUndefined();
    expect(
      await context.authority.reconcile({
        kind: "commit",
        operationId: "commit-op",
        intentDigest: COMMIT_INTENT,
      }),
    ).toEqual({ status: "ambiguous" });
  });

  test("expires abandoned reservations and reconciles them as ambiguous", async () => {
    let now = 100;
    const context = await harness(() => now);
    await context.authority.acquireCommit(commitRequest(context));
    now = 200;

    expect(
      await context.authority.reconcile({
        kind: "commit",
        operationId: "commit-op",
        intentDigest: COMMIT_INTENT,
      }),
    ).toEqual({ status: "ambiguous" });
    expect(
      (await context.state.get("execution-1"))?.reservations?.[0]?.status,
    ).toBe("expired");
  });
});

async function harness(now: () => number = () => 100) {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  const receipts = new InMemoryWorkflowChangeReceiptStore();
  const journal = new InMemoryWorkflowHostMutationJournal();
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
    reservations: [],
    updatedAt: 1,
  });
  let id = 0;
  const ownership = new WorkflowOwnershipController({
    plans,
    state,
    createId: (kind) => `${kind}-${++id}`,
    now,
    authorizer: { authorize: () => true },
  });
  const grant = await ownership.claim(
    {
      executionId: "execution-1",
      planRevision: 1,
      claims: [{ path: "src/a/file.ts", scope: "exact" }],
    },
    actor("builder", "task-a"),
  );
  const changeSet = await createWorkflowChangeSet({
    executionId: "execution-1",
    taskId: "task-a",
    planRevision: 1,
    workspaceRevision: "workspace-1",
    baseRevision: "base-1",
    entries: [
      {
        kind: "modified",
        path: "src/a/file.ts",
        entryKind: "file",
        contentDigest: CONTENT_DIGEST,
      },
    ],
  });
  const validator = new WorkflowOwnershipChangeSetValidator({
    ownership,
    plans,
    receipts,
    createReceiptId: () => "receipt-1",
    now,
  });
  const receipt = await validator.validate(
    {
      changeSet,
      expectedBaseRevision: "base-1",
      expectedPlanRevision: 1,
      agentId: "builder",
      ownership: [{ grantId: grant.grantId, fencingToken: grant.fencingToken }],
      expectedTarget: { targetId: "integration", revision: "target-1" },
    },
    actor("coordinator", "integration"),
  );
  const createAuthority = () =>
    new WorkflowLiveChangeReceiptAuthority({
      state,
      receipts,
      journal,
      now,
      reservationTtlMs: 10,
    });
  return {
    authority: createAuthority(),
    createAuthority,
    ownership,
    state,
    receipt,
    changeSet,
    grantId: grant.grantId,
  };
}

function commitRequest(context: Awaited<ReturnType<typeof harness>>) {
  return {
    operationId: "commit-op",
    intentDigest: COMMIT_INTENT,
    receipt: context.receipt,
    changeSet: context.changeSet,
    treeId: "tree-1",
  };
}

function commitResult(
  context: Awaited<ReturnType<typeof harness>>,
): WorkflowAuthoritativeCommitResult {
  return {
    commitId: "commit-1",
    receiptId: context.receipt.receiptId,
    changeSetDigest: context.receipt.changeSetDigest,
    treeId: "tree-1",
    workspaceRevision: context.receipt.workspaceRevision,
    baseRevision: context.receipt.baseRevision,
    committedAt: 110,
  };
}

function integrationRequest(
  context: Awaited<ReturnType<typeof harness>>,
  commit: WorkflowAuthoritativeCommitResult,
) {
  return {
    operationId: "integration-op",
    intentDigest: INTEGRATION_INTENT,
    receipt: context.receipt,
    commit,
    expectedTarget: context.receipt.expectedTarget,
  };
}

function actor(agentId: string, taskId: string): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: `principal-${agentId}`,
    agentId,
    executionId: "execution-1",
    taskId,
    planRevision: 1,
  });
}

function plan(): WorkflowPlan {
  return {
    protocol: WORKFLOW_PLAN_PROTOCOL,
    version: WORKFLOW_PLAN_VERSION,
    executionId: "execution-1",
    planRevision: 1,
    baseRevision: "base-1",
    objective: "Test live receipt publication authority",
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
        agentId: "reviewer",
        policy: {
          role: "worker",
          permissions: ["plan:read"],
          canDelegate: false,
        },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: ["plan:read", "ownership:transfer", "changes:validate"],
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
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Commit safely"],
      },
      {
        taskId: "task-b",
        agentId: "reviewer",
        role: "worker",
        ownedPaths: [{ path: "src/b", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Receive ownership"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: ["task-a", "task-b"],
        acceptance: ["Integrate safely"],
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
