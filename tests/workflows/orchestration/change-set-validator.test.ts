/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import {
  WorkflowChangeValidationError,
  WorkflowOwnershipChangeSetValidator,
} from "../../../src/workflows/orchestration/change-set-validator.js";
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
  type WorkflowChangeEntry,
} from "../../../src/workflows/workspace/change-driver.js";

const CONTENT_DIGEST = `sha256:${"1".repeat(64)}`;

describe("WorkflowOwnershipChangeSetValidator", () => {
  test("issues an immutable multi-grant receipt without mutating orchestration state", async () => {
    const context = await harness();
    const first = await context.claim("src/a/one.ts");
    const second = await context.claim("src/a/two.ts");
    const before = await context.state.get("execution-1");

    const receipt = await context.validator.validate(
      request(
        await changes([
          entry("modified", "src/a/one.ts"),
          entry("added", "src/a/two.ts"),
        ]),
        [first, second],
      ),
      context.validatorActor,
    );

    expect(receipt).toMatchObject({
      receiptId: "receipt-1",
      verdict: "accepted",
      executionId: "execution-1",
      taskId: "task-a",
      planRevision: 1,
      agentId: "builder",
      orchestrationRevision: before?.revision,
      baseRevision: "base-1",
      issuedAt: 100,
      ownership: [
        { grantId: first.grantId, fencingToken: first.fencingToken },
        { grantId: second.grantId, fencingToken: second.fencingToken },
      ],
      expectedTarget: { targetId: "integration", revision: "target-1" },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.ownership)).toBe(true);
    expect(await context.receipts.get("execution-1", receipt.receiptId)).toBe(
      receipt,
    );
    expect(await context.state.get("execution-1")).toEqual(before);
  });

  test("rejects a forged digest before consulting ownership", async () => {
    const context = await harness();
    const grant = await context.claim("src/a/one.ts");
    const valid = await changes([entry("modified", "src/a/one.ts")]);
    const forged = { ...valid, changeSetDigest: `sha256:${"0".repeat(64)}` };

    await expect(
      context.validator.validate(
        request(forged, [grant]),
        context.validatorActor,
      ),
    ).rejects.toMatchObject({ code: "CHANGE_SET_DIGEST_MISMATCH" });
  });

  test("rejects stale base and declared plan revisions", async () => {
    const context = await harness();
    const grant = await context.claim("src/a/one.ts");
    const changeSet = await changes([entry("modified", "src/a/one.ts")]);

    await expect(
      context.validator.validate(
        { ...request(changeSet, [grant]), expectedBaseRevision: "base-0" },
        context.validatorActor,
      ),
    ).rejects.toBeInstanceOf(WorkflowChangeValidationError);
    await expect(
      context.validator.validate(
        { ...request(changeSet, [grant]), expectedPlanRevision: 2 },
        context.validatorActor,
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_CHANGE_PLAN_REVISION_MISMATCH",
    });
  });

  test("rejects an inactive plan and stale fencing authority", async () => {
    const stalePlan = await harness();
    const stalePlanGrant = await stalePlan.claim("src/a/one.ts");
    const current = await stalePlan.state.get("execution-1");
    if (!current) throw new Error("missing state");
    await stalePlan.state.compareAndSet(
      {
        ...current,
        revision: current.revision + 1,
        activePlanRevision: 2,
        grants: [],
        updatedAt: current.updatedAt + 1,
      },
      current.revision,
    );
    await expect(
      stalePlan.validator.validate(
        request(await changes([entry("modified", "src/a/one.ts")]), [
          stalePlanGrant,
        ]),
        stalePlan.validatorActor,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_STALE" });

    const staleFence = await harness();
    const original = await staleFence.claim("src/a/one.ts");
    const transferred = await staleFence.controller.transfer(
      {
        executionId: "execution-1",
        planRevision: 1,
        sourceGrantId: original.grantId,
        targetTaskId: "task-b",
      },
      staleFence.validatorActor,
    );
    await expect(
      staleFence.validator.validate(
        request(await changes([entry("modified", "src/a/one.ts")]), [
          {
            grantId: transferred.grantId,
            fencingToken: original.fencingToken,
          },
        ]),
        staleFence.validatorActor,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_OWNERSHIP_STALE" });
  });

  test("rejects unowned additions and reserved worker changes", async () => {
    const context = await harness();
    const grant = await context.claim("src/a/one.ts");

    await expect(
      context.validator.validate(
        request(await changes([entry("added", "src/a/unowned.ts")]), [grant]),
        context.validatorActor,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_PATH_NOT_OWNED" });
    await expect(
      context.validator.validate(
        request(await changes([entry("modified", "src/workflows/index.ts")]), [
          grant,
        ]),
        context.validatorActor,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_RESERVED_PATH" });
  });

  test("requires both sides of a rename to be owned", async () => {
    const context = await harness();
    const grant = await context.claim("src/a/from.ts");

    await expect(
      context.validator.validate(
        request(
          await changes([
            {
              kind: "renamed",
              fromPath: "src/a/from.ts",
              toPath: "src/a/to.ts",
              entryKind: "file",
              contentDigest: CONTENT_DIGEST,
            },
          ]),
          [grant],
        ),
        context.validatorActor,
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PATH_NOT_OWNED",
      details: { path: "src/a/to.ts" },
    });
  });

  test("denies symlinks and submodules by default and can opt in explicitly", async () => {
    for (const entryKind of ["symlink", "submodule"] as const) {
      const context = await harness();
      const grant = await context.claim("src/a/special");
      const changeSet = await changes([
        { ...entry("added", "src/a/special"), entryKind },
      ]);
      await expect(
        context.validator.validate(
          request(changeSet, [grant]),
          context.validatorActor,
        ),
      ).rejects.toMatchObject({
        code: "WORKFLOW_CHANGE_ENTRY_KIND_DENIED",
        details: { entryKind },
      });
    }

    const allowed = await harness(["file", "directory", "symlink"]);
    const grant = await allowed.claim("src/a/link");
    await expect(
      allowed.validator.validate(
        request(
          await changes([
            { ...entry("added", "src/a/link"), entryKind: "symlink" },
          ]),
          [grant],
        ),
        allowed.validatorActor,
      ),
    ).resolves.toMatchObject({ verdict: "accepted" });
  });

  test("accepts a reserved path only for a current integration grant", async () => {
    const context = await harness();
    const proposal = await context.controller.propose(
      {
        executionId: "execution-1",
        planRevision: 1,
        kind: "claim",
        targetTaskId: "integration",
        claims: [{ path: "src/workflows/index.ts", scope: "exact" }],
      },
      context.validatorActor,
    );
    await context.controller.approve(
      {
        executionId: "execution-1",
        planRevision: 1,
        proposalId: proposal.proposalId,
      },
      context.validatorActor,
    );
    const [grant] = await context.controller.list(
      { executionId: "execution-1", planRevision: 1 },
      context.validatorActor,
    );
    if (!grant) throw new Error("missing integration grant");
    const changeSet = await createWorkflowChangeSet({
      executionId: "execution-1",
      taskId: "integration",
      planRevision: 1,
      workspaceRevision: "workspace-integration",
      baseRevision: "base-1",
      entries: [entry("modified", "src/workflows/index.ts")],
    });

    await expect(
      context.validator.validate(
        {
          ...request(changeSet, [grant]),
          agentId: "coordinator",
        },
        context.validatorActor,
      ),
    ).resolves.toMatchObject({ taskId: "integration" });
  });
});

async function harness(
  allowedEntryKinds?: readonly (
    | "file"
    | "directory"
    | "symlink"
    | "submodule"
  )[],
) {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  const receipts = new InMemoryWorkflowChangeReceiptStore();
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
  let nextId = 0;
  const controller = new WorkflowOwnershipController({
    plans,
    state,
    createId: (kind) => `${kind}-${++nextId}`,
    now: () => 10 + nextId,
    authorizer: {
      authorize: (authorization) =>
        authorization.actorId === `principal-${authorization.agentId}`,
    },
  });
  const validator = new WorkflowOwnershipChangeSetValidator({
    plans,
    ownership: controller,
    receipts,
    createReceiptId: () => "receipt-1",
    now: () => 100,
    ...(allowedEntryKinds === undefined ? {} : { allowedEntryKinds }),
  });
  const validatorActor = actor("coordinator", "integration");
  return {
    plans,
    state,
    receipts,
    controller,
    validator,
    validatorActor,
    claim: async (path: string) =>
      await controller.claim(
        {
          executionId: "execution-1",
          planRevision: 1,
          claims: [{ path, scope: "exact" }],
        },
        actor("builder", "task-a"),
      ),
  };
}

function request(
  changeSet: Awaited<ReturnType<typeof changes>>,
  grants: readonly { grantId: string; fencingToken: number }[],
) {
  return {
    changeSet,
    expectedBaseRevision: "base-1",
    expectedPlanRevision: 1,
    agentId: "builder",
    ownership: grants.map(({ grantId, fencingToken }) => ({
      grantId,
      fencingToken,
    })),
    expectedTarget: { targetId: "integration", revision: "target-1" },
  };
}

async function changes(entries: readonly WorkflowChangeEntry[]) {
  return await createWorkflowChangeSet({
    executionId: "execution-1",
    taskId: "task-a",
    planRevision: 1,
    workspaceRevision: "workspace-1",
    baseRevision: "base-1",
    entries,
  });
}

function entry(
  kind: "added" | "modified" | "deleted",
  path: string,
): WorkflowChangeEntry {
  return { kind, path, entryKind: "file", contentDigest: CONTENT_DIGEST };
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
    objective: "Validate owned changes without workspace mutation",
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
          permissions: ["plan:read", "ownership:claim"],
          canDelegate: false,
        },
      },
      {
        agentId: "coordinator",
        policy: {
          role: "integration",
          permissions: [
            "plan:read",
            "ownership:propose",
            "ownership:approve",
            "ownership:transfer",
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
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Owned change validation passes"],
      },
      {
        taskId: "task-b",
        agentId: "reviewer",
        role: "worker",
        ownedPaths: [{ path: "src/b", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Handoff is fenced"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: ["task-a", "task-b"],
        acceptance: ["Validated changes can be integrated"],
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
