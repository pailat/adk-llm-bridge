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

export { WorkflowActorContext };

export async function harness(
  mutatePlan?: (value: WorkflowPlan) => WorkflowPlan,
) {
  const plans = new InMemoryWorkflowPlanStore();
  const state = new InMemoryWorkflowOrchestrationStateStore();
  await plans.put(mutatePlan?.(plan()) ?? plan());
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

export type ClaimedRecord = WorkflowTaskRecord & {
  readonly claim: NonNullable<WorkflowTaskRecord["claim"]>;
};

export function parentRecord(): ClaimedRecord {
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
      maxChildren: 2,
      ownership: [
        { grantId: "grant-a", fencingToken: 2 },
        { grantId: "grant-z", fencingToken: 1 },
      ],
    },
  } as ClaimedRecord;
}

export function claimGuard(record: WorkflowTaskRecord): WorkflowTaskClaimGuard {
  if (!record.claim) throw new Error("Expected claim");
  return {
    executionId: record.executionId,
    taskId: record.taskId,
    workerId: record.claim.workerId,
    leaseId: record.claim.leaseId,
    fencingToken: record.claim.fencingToken,
  };
}
export function plan(): WorkflowPlan {
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
          permissions: [
            "plan:read",
            "task:spawn",
            "task:mailbox:send",
            "task:read",
            "task:cancel",
            "task:manage",
          ],
          canDelegate: true,
          allowedDelegateRoles: ["worker"],
          maxChildren: 2,
        },
      },
      {
        agentId: "worker",
        policy: {
          role: "worker",
          permissions: [
            "plan:read",
            "task:mailbox:send",
            "task:read",
            "task:cancel",
          ],
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

export function orchestrationState(): WorkflowOrchestrationState {
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
