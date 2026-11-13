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

async function harness() {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  const base = plan();
  // The same agent "builder" also owns a second lane, task-c.
  await plans.put({
    ...base,
    lanes: [
      ...base.lanes,
      {
        taskId: "task-c",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "src/c", scope: "subtree" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["task-a", "task-b", "task-c"] },
      { waveId: "wave-2", taskIds: ["integration"] },
    ],
  });
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
  return new WorkflowOwnershipController({
    plans,
    state,
    createId: (kind) => `${kind}-${++id}`,
    now: () => ++timestamp,
    authorizer: {
      authorize(request) {
        return request.actorId === `principal-${request.agentId}`;
      },
    },
  });
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

const scope = { executionId: "execution-1", planRevision: 1 };

describe("release requires the grant's exact lane (task AND agent)", () => {
  test("same agent acting from another lane cannot release the grant; the owning lane can", async () => {
    const controller = await harness();
    const grant = await controller.claim(
      { ...scope, claims: [{ path: "src/a/file.ts", scope: "exact" }] },
      actor("builder", "task-a"),
    );
    expect(grant).toMatchObject({ taskId: "task-a", agentId: "builder" });

    await expect(
      controller.release(
        { ...scope, grantId: grant.grantId },
        actor("builder", "task-c"),
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_UNAUTHORIZED",
      message: "Only the grant owner or an ownership manager can release it",
    });

    await expect(
      controller.release(
        { ...scope, grantId: grant.grantId },
        actor("builder", "task-a"),
      ),
    ).resolves.toMatchObject({ grantId: grant.grantId });
  });
});

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
