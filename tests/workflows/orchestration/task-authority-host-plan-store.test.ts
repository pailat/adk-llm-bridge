import { describe, expect, test } from "bun:test";
import type { WorkflowPlan } from "../../../src/workflows/orchestration/contracts.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  type WorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";
import { WorkflowOrchestrationTaskAuthorityPort } from "../../../src/workflows/orchestration/task-authority.js";
import {
  claimGuard,
  orchestrationState,
  parentRecord,
  plan,
} from "./task-authority-fixture.js";

/**
 * A host store that returns plans as stored, without the validation the
 * built-in stores run on `put`, so a plan the built-in validation would
 * reject still reaches the authority.
 */
function rawPlanStore(stored: WorkflowPlan): WorkflowPlanStore {
  return {
    put: async (value) => value,
    get: async (executionId, planRevision) =>
      executionId === stored.executionId && planRevision === stored.planRevision
        ? stored
        : undefined,
    list: async (executionId) =>
      executionId === stored.executionId ? [stored] : [],
  };
}

async function authorityFor(stored: WorkflowPlan) {
  const state = new InMemoryWorkflowOrchestrationStateStore();
  await state.create(orchestrationState());
  return new WorkflowOrchestrationTaskAuthorityPort({
    plans: rawPlanStore(stored),
    state,
    now: () => 10,
    authorizer: {
      authorize: (request) =>
        request.actorId === `principal-${request.agentId}`,
    },
  });
}

function withoutDelegation(value: WorkflowPlan): WorkflowPlan {
  return {
    ...value,
    agents: value.agents.map((agent) =>
      agent.agentId === "architect"
        ? { ...agent, policy: { ...agent.policy, canDelegate: false } }
        : agent,
    ),
  };
}

describe("child delegation from a host plan store", () => {
  test("a plan from the host store is accepted when the parent may delegate", async () => {
    const authority = await authorityFor(plan());
    const parent = parentRecord();
    await expect(
      authority.deriveChild({
        parent,
        parentClaim: claimGuard(parent),
        request: { taskId: "child", agentId: "worker" },
      }),
    ).resolves.toMatchObject({ planRevision: 1 });
  });

  test("a parent without canDelegate cannot spawn, even with task:spawn and an allowed role", async () => {
    const authority = await authorityFor(withoutDelegation(plan()));
    const parent = parentRecord();
    await expect(
      authority.deriveChild({
        parent,
        parentClaim: claimGuard(parent),
        request: { taskId: "child", agentId: "worker" },
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_UNAUTHORIZED",
      message: "Parent workflow agent cannot delegate",
    });
  });
});
