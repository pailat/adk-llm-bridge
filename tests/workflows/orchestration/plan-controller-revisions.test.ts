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

const coordinator = () => actor("coordinator", 1, "integration");

describe("WorkflowPlanController revision rules", () => {
  test("constructor rejects missing stores and out-of-range maxCasRetries", () => {
    const base = {
      plans: new InMemoryWorkflowPlanStore(),
      state: new InMemoryWorkflowOrchestrationStateStore(),
      authorizer: { authorize: () => true },
    };
    expect(
      () => new WorkflowPlanController({ ...base, plans: undefined as never }),
    ).toThrow(/requires plan and state stores/);
    for (const maxCasRetries of [0, 1001, 1.5]) {
      expect(
        () => new WorkflowPlanController({ ...base, maxCasRetries }),
      ).toThrow(/maxCasRetries is invalid/);
    }
  });

  test("put rejects a first revision other than 1", async () => {
    const { controller } = harness();
    await expect(
      controller.put(plan({ planRevision: 2 }), coordinator()),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_REVISION_CONFLICT" });
  });

  test("put rejects stale, non-contiguous, base-changing, and inactive-latest revisions", async () => {
    const { controller } = harness();
    await controller.put(plan(), coordinator());
    await expect(controller.put(plan(), coordinator())).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_STALE",
    });
    await expect(
      controller.put(plan({ planRevision: 3 }), coordinator()),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_REVISION_CONFLICT" });
    await expect(
      controller.put(
        plan({ planRevision: 2, baseRevision: "b5fbcf1" }),
        coordinator(),
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_REVISION_CONFLICT",
      details: { expectedBaseRevision: "a4fbcf1" },
    });
    await expect(
      controller.put(plan({ planRevision: 2 }), coordinator()),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_REVISION_CONFLICT",
      message: expect.stringContaining("must be active"),
    });
  });

  test("activate rejects a first activation other than revision 1", async () => {
    const { controller, plans } = harness();
    await plans.put(plan({ planRevision: 2 }));
    await expect(
      controller.activate("execution-1", 2, coordinator()),
    ).rejects.toMatchObject({ code: "WORKFLOW_PLAN_REVISION_CONFLICT" });
  });

  test("activate rejects older, skipped, and non-latest revisions", async () => {
    const { controller, plans } = harness();
    await controller.put(plan(), coordinator());
    await controller.activate("execution-1", 1, coordinator());
    await controller.put(plan({ planRevision: 2 }), coordinator());
    await plans.put(plan({ planRevision: 3 }));

    await expect(
      controller.activate("execution-1", 3, coordinator()),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_REVISION_CONFLICT",
      details: { activePlanRevision: 1 },
    });
    await expect(
      controller.activate("execution-1", 2, coordinator()),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_STALE",
      details: { latestPlanRevision: 3 },
    });
  });

  test("activate rejects activating an older revision than the active one", async () => {
    const { controller } = harness();
    await controller.put(plan(), coordinator());
    await controller.activate("execution-1", 1, coordinator());
    await controller.put(plan({ planRevision: 2 }), coordinator());
    await controller.activate("execution-1", 2, coordinator());
    await expect(
      controller.activate("execution-1", 1, coordinator()),
    ).rejects.toMatchObject({
      code: "WORKFLOW_PLAN_STALE",
      details: { activePlanRevision: 2 },
    });
  });

  test("activate rejects an invalid clock timestamp", async () => {
    const { controller } = harness({ now: () => -1 });
    await controller.put(plan(), coordinator());
    await expect(
      controller.activate("execution-1", 1, coordinator()),
    ).rejects.toMatchObject({ code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST" });
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
