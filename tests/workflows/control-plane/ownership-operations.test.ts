/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  WORKFLOW_CONTROL_PROTOCOL,
  WORKFLOW_CONTROL_PROTOCOL_VERSION,
  WorkflowControlPlane,
} from "../../../src/workflows/control-plane/workflow-control-plane.js";
import { WorkflowExecutionController } from "../../../src/workflows/execution/controller.js";
import {
  InMemoryWorkflowExecutionEventStore,
  InMemoryWorkflowExecutionStore,
} from "../../../src/workflows/execution/stores.js";
import { WorkflowActorContext } from "../../../src/workflows/orchestration/authorization.js";
import { WorkflowOwnershipChangeSetValidator } from "../../../src/workflows/orchestration/change-set-validator.js";
import {
  WORKFLOW_PLAN_PROTOCOL,
  WORKFLOW_PLAN_VERSION,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import { WorkflowOwnershipController } from "../../../src/workflows/orchestration/ownership-controller.js";
import { WorkflowPlanController } from "../../../src/workflows/orchestration/plan-controller.js";
import {
  InMemoryWorkflowOrchestrationStateStore,
  InMemoryWorkflowPlanStore,
} from "../../../src/workflows/orchestration/stores.js";
import { IntegrationGate } from "../../../src/workflows/resources/integration-gate.js";
import { InMemoryWorkflowArtifactStore } from "../../../src/workflows/resources/workflow-artifact-store.js";
import { WorkflowTaskController } from "../../../src/workflows/tasks/controller.js";
import {
  InMemoryWorkflowTaskMessageStore,
  InMemoryWorkflowTaskStore,
} from "../../../src/workflows/tasks/stores.js";
import { createWorkflowChangeSet } from "../../../src/workflows/workspace/change-driver.js";

const envelope = {
  protocol: WORKFLOW_CONTROL_PROTOCOL,
  version: WORKFLOW_CONTROL_PROTOCOL_VERSION,
} as const;

describe("WorkflowControlPlane orchestration operations", () => {
  test("keeps orchestration capabilities optional for legacy hosts", async () => {
    const control = baseControl();

    await expect(
      control.dispatch({
        ...envelope,
        operation: "plan.list",
        payload: { executionId: "execution-1" },
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE",
    });
    await expect(
      control.dispatch({
        ...envelope,
        operation: "task.sweep",
        payload: { executionId: "execution-1" },
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_CONTROL_CAPABILITY_UNAVAILABLE",
    });
  });

  test("uses only the host option as actor authority", async () => {
    const { control } = orchestrationControl();
    const forged = {
      actorId: "principal-coordinator",
      agentId: "coordinator",
      executionId: "execution-1",
      taskId: "integration",
      planRevision: 1,
    };

    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "plan.put",
          payload: plan(),
        },
        { actor: forged as never },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });

    await expect(
      control.dispatch({
        ...envelope,
        operation: "ownership.claim",
        payload: {
          executionId: "execution-1",
          planRevision: 1,
          claims: [{ path: "src/feature.ts", scope: "exact" }],
          senderTaskId: "integration",
        },
      } as never),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
  });

  test("drives an authorized plan, ownership, and validation lifecycle", async () => {
    const { control } = orchestrationControl();
    const coordinator = actor("coordinator", "integration");
    const builder = actor("builder", "implementation");

    await expect(
      control.dispatch(
        { ...envelope, operation: "plan.put", payload: plan() },
        { actor: coordinator },
      ),
    ).resolves.toMatchObject({ planRevision: 1, status: "ready" });
    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "plan.get",
          payload: { executionId: "execution-1", planRevision: 1 },
        },
        { actor: coordinator },
      ),
    ).resolves.toMatchObject({ executionId: "execution-1" });
    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "plan.list",
          payload: { executionId: "execution-1" },
        },
        { actor: coordinator },
      ),
    ).resolves.toHaveLength(1);
    await control.dispatch(
      {
        ...envelope,
        operation: "plan.activate",
        payload: { executionId: "execution-1", planRevision: 1 },
      },
      { actor: coordinator },
    );

    const grant = (await control.dispatch(
      {
        ...envelope,
        operation: "ownership.claim",
        payload: {
          executionId: "execution-1",
          planRevision: 1,
          claims: [{ path: "src/feature.ts", scope: "exact" }],
        },
      },
      { actor: builder },
    )) as { grantId: string; fencingToken: number };
    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "ownership.list",
          payload: { executionId: "execution-1", planRevision: 1 },
        },
        { actor: builder },
      ),
    ).resolves.toMatchObject([{ grantId: grant.grantId }]);

    const changeSet = await createWorkflowChangeSet({
      executionId: "execution-1",
      taskId: "implementation",
      planRevision: 1,
      workspaceRevision: "workspace-1",
      baseRevision: "base-1",
      entries: [
        {
          kind: "modified",
          entryKind: "file",
          path: "src/feature.ts",
          contentDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    await expect(
      control.dispatch(
        {
          ...envelope,
          operation: "ownership.validate",
          payload: {
            changeSet,
            expectedBaseRevision: "base-1",
            expectedPlanRevision: 1,
            agentId: "builder",
            ownership: [
              {
                grantId: grant.grantId,
                fencingToken: grant.fencingToken,
              },
            ],
            expectedTarget: {
              targetId: "integration",
              revision: "target-1",
            },
          },
        },
        { actor: coordinator },
      ),
    ).resolves.toMatchObject({
      verdict: "accepted",
      taskId: "implementation",
      ownership: [{ grantId: grant.grantId }],
    });
  });

  test("rejects unknown nested fields before invoking orchestration policy", async () => {
    const { control } = orchestrationControl();
    const invalidPlan = plan() as WorkflowPlan & {
      lanes: Array<WorkflowPlan["lanes"][number] & { actor?: unknown }>;
    };
    invalidPlan.lanes = invalidPlan.lanes.map((lane) => ({
      ...lane,
      actor: { actorId: "forged" },
    }));

    await expect(
      control.dispatch(
        { ...envelope, operation: "plan.put", payload: invalidPlan },
        { actor: actor("coordinator", "integration") },
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_CONTROL_INVALID_REQUEST" });
  });
});

function baseControl(
  optional: Partial<ConstructorParameters<typeof WorkflowControlPlane>[0]> = {},
): WorkflowControlPlane {
  const artifacts = new InMemoryWorkflowArtifactStore();
  return new WorkflowControlPlane({
    executions: new WorkflowExecutionController({
      store: new InMemoryWorkflowExecutionStore(),
      eventStore: new InMemoryWorkflowExecutionEventStore(),
      driver: { execute: async () => ({}) },
    }),
    tasks: new WorkflowTaskController({
      store: new InMemoryWorkflowTaskStore(),
      messageStore: new InMemoryWorkflowTaskMessageStore(),
      driver: { execute: async () => ({}) },
    }),
    artifacts,
    integration: new IntegrationGate(artifacts, {
      validate: async () => ({ verdict: "accepted", result: null }),
    }),
    ...optional,
  });
}

function orchestrationControl() {
  let sequence = 0;
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  const authorizer = {
    authorize: ({ actorId, agentId }: { actorId: string; agentId: string }) =>
      actorId === `principal-${agentId}`,
  };
  const planController = new WorkflowPlanController({
    plans,
    state,
    authorizer,
    bootstrapAuthorizer: authorizer,
    now: () => 1,
  });
  const ownership = new WorkflowOwnershipController({
    plans,
    state,
    authorizer,
    createId: (kind) => `${kind}-${++sequence}`,
    now: () => 2 + sequence,
  });
  const changeValidation = new WorkflowOwnershipChangeSetValidator({
    plans,
    ownership,
    createReceiptId: () => "receipt-1",
    now: () => 10,
  });
  return {
    control: baseControl({
      plans: planController,
      ownership,
      changeValidation,
    }),
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
    objective: "Expose authenticated orchestration operations",
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
          permissions: [
            "plan:read",
            "plan:activate",
            "ownership:approve",
            "ownership:transfer",
            "ownership:release",
            "changes:validate",
            "integration:publish",
          ],
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
        ownedPaths: [{ path: "src/feature.ts", scope: "exact" }],
        mayCreateUnder: [],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [],
        mayCreateUnder: [],
        dependsOn: ["implementation"],
        acceptance: ["Validation receipt accepted"],
      },
    ],
    waves: [
      { waveId: "wave-1", taskIds: ["implementation"] },
      { waveId: "wave-2", taskIds: ["integration"] },
    ],
    invariants: [],
    reservedPaths: [],
  };
}
