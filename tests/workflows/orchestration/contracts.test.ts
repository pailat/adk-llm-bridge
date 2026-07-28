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
  WorkflowOrchestrationControlError,
  type WorkflowOrchestrationState,
  type WorkflowPlan,
} from "../../../src/workflows/orchestration/contracts.js";
import {
  immutableWorkflowOrchestrationJson,
  validateWorkflowOrchestrationState,
  validateWorkflowPath,
  validateWorkflowPlan,
  workflowPathClaimsOverlap,
} from "../../../src/workflows/orchestration/json.js";

describe("workflow orchestration contracts", () => {
  test("accepts a versioned, topologically ordered plan", () => {
    const value = plan();

    expect(() => validateWorkflowPlan(value)).not.toThrow();
    expect(value).toMatchObject({
      protocol: "adk-llm-bridge/workflow-plan",
      version: 1,
      planRevision: 1,
    });
  });

  test("rejects unknown host identity and non-JSON values", () => {
    expect(() =>
      validateWorkflowPlan({
        ...plan(),
        agents: [
          {
            ...plan().agents[0],
            providerSession: { pid: 42 },
          },
          plan().agents[1],
        ],
      } as WorkflowPlan),
    ).toThrow(WorkflowOrchestrationControlError);
    expect(() =>
      immutableWorkflowOrchestrationJson({
        signal: new AbortController().signal,
      }),
    ).toThrow(WorkflowOrchestrationControlError);
    expect(() =>
      immutableWorkflowOrchestrationJson({ bad: Number.NaN }),
    ).toThrow(WorkflowOrchestrationControlError);
  });

  test("requires unique references and an acyclic topological wave order", () => {
    expect(() =>
      validateWorkflowPlan({
        ...plan(),
        lanes: plan().lanes.map((lane) => ({
          ...lane,
          dependsOn: lane.taskId === "implementation" ? ["missing"] : [],
        })),
      }),
    ).toThrow(WorkflowOrchestrationControlError);

    expect(() =>
      validateWorkflowPlan({
        ...plan(),
        lanes: plan().lanes.map((lane) => ({
          ...lane,
          dependsOn:
            lane.taskId === "implementation"
              ? ["integration"]
              : ["implementation"],
        })),
      }),
    ).toThrow(WorkflowOrchestrationControlError);

    expect(() =>
      validateWorkflowPlan({ ...plan(), waves: [...plan().waves].reverse() }),
    ).toThrow(WorkflowOrchestrationControlError);
  });

  test("rejects overlapping ownership and reserved paths outside integration", () => {
    expect(() =>
      validateWorkflowPlan({
        ...plan(),
        lanes: plan().lanes.map((lane) =>
          lane.taskId === "implementation"
            ? {
                ...lane,
                ownedPaths: [
                  ...lane.ownedPaths,
                  { path: "src/workflows/index.ts", scope: "exact" as const },
                ],
              }
            : lane,
        ),
      }),
    ).toThrow(WorkflowOrchestrationControlError);

    expect(() =>
      validateWorkflowPlan({
        ...plan(),
        reservedPaths: [{ path: "src/workflows/new", scope: "subtree" }],
        lanes: plan().lanes.map((lane) =>
          lane.taskId === "implementation"
            ? { ...lane, mayCreateUnder: ["src/workflows/new"] }
            : lane,
        ),
      }),
    ).toThrow(WorkflowOrchestrationControlError);

    expect(
      workflowPathClaimsOverlap(
        { path: "src/workflows", scope: "subtree" },
        { path: "src/workflows/tasks/controller.ts", scope: "exact" },
      ),
    ).toBe(true);
    expect(
      workflowPathClaimsOverlap(
        { path: "src/workflows", scope: "exact" },
        { path: "src/workflows/tasks", scope: "exact" },
      ),
    ).toBe(false);
  });

  test("requires normalized repository-relative paths", () => {
    for (const invalid of [
      "/absolute",
      "../escape",
      "src/../escape",
      "src//file.ts",
      "src\\file.ts",
      "C:/file.ts",
      "src/",
    ]) {
      expect(() => validateWorkflowPath(invalid)).toThrow(
        WorkflowOrchestrationControlError,
      );
    }
    expect(() => validateWorkflowPath("src/workflows/file.ts")).not.toThrow();
  });

  test("validates grants, proposals, and monotonic fencing space", () => {
    const value = state();
    expect(() => validateWorkflowOrchestrationState(value)).not.toThrow();

    expect(() =>
      validateWorkflowOrchestrationState({ ...value, nextFencingToken: 1 }),
    ).toThrow(WorkflowOrchestrationControlError);
    expect(() =>
      validateWorkflowOrchestrationState({
        ...value,
        grants: [
          ...value.grants,
          {
            ...value.grants[0],
            grantId: "grant-2",
            taskId: "integration",
            fencingToken: 2,
          },
        ],
        nextFencingToken: 3,
      }),
    ).toThrow(WorkflowOrchestrationControlError);
  });

  test("creates detached, deeply frozen JSON snapshots", () => {
    const mutable = { nested: { values: [1] } };
    const snapshot = immutableWorkflowOrchestrationJson(mutable);
    mutable.nested.values.push(2);

    expect(snapshot).toEqual({ nested: { values: [1] } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.values)).toBe(true);
  });
});

export function plan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
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
          permissions: ["plan:read", "ownership:claim", "ownership:propose"],
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
            "changes:validate",
            "integration:publish",
          ],
          canDelegate: true,
          allowedDelegateRoles: ["worker", "critic"],
          maxChildren: 3,
        },
      },
    ],
    lanes: [
      {
        taskId: "implementation",
        agentId: "builder",
        role: "worker",
        ownedPaths: [{ path: "src/workflows/tasks", scope: "subtree" }],
        mayCreateUnder: ["tests/workflows/tasks"],
        dependsOn: [],
        acceptance: ["Focused tests pass"],
      },
      {
        taskId: "integration",
        agentId: "coordinator",
        role: "integration",
        ownedPaths: [{ path: "src/workflows/index.ts", scope: "exact" }],
        mayCreateUnder: ["tests/workflows/e2e"],
        dependsOn: ["implementation"],
        acceptance: ["Full CI passes"],
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

export function state(
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
