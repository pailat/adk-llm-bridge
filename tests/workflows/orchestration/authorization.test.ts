/**
 * @license
 * Copyright 2025 PAI
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, test } from "bun:test";
import {
  authorizeWorkflowActor,
  DENY_ALL_WORKFLOW_AUTHORIZER,
  WorkflowActorContext,
} from "../../../src/workflows/orchestration/authorization.js";

describe("workflow host authorization", () => {
  test("rejects a caller-controlled JSON actor instead of treating it as authentication", async () => {
    const serializedActor = JSON.parse(
      '{"actorId":"principal-1","agentId":"coordinator","executionId":"execution-1"}',
    );
    let calls = 0;

    await expect(
      authorizeWorkflowActor(
        {
          authorize() {
            calls++;
            return true;
          },
        },
        serializedActor,
        {
          operation: "plan.get",
          permission: "plan:read",
          executionId: "execution-1",
          planRevision: 1,
        },
      ),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_INVALID_REQUEST",
      details: { reason: "unauthorized" },
    });
    expect(calls).toBe(0);
  });

  test("is deny-by-default and binds the authenticated actor to its target", async () => {
    const actor = context();

    await expect(
      authorizeWorkflowActor(DENY_ALL_WORKFLOW_AUTHORIZER, actor, {
        operation: "plan.get",
        permission: "plan:read",
        executionId: "execution-1",
        planRevision: 1,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      authorizeWorkflowActor({ authorize: () => true }, actor, {
        operation: "plan.get",
        permission: "plan:read",
        executionId: "execution-2",
        planRevision: 1,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
    await expect(
      authorizeWorkflowActor({ authorize: () => true }, actor, {
        operation: "plan.get",
        permission: "plan:read",
        executionId: "execution-1",
        planRevision: 2,
      }),
    ).rejects.toMatchObject({ details: { reason: "unauthorized" } });
  });

  test("passes authenticated identities to the host policy but cannot serialize the capability", async () => {
    const actor = context();
    const requests: unknown[] = [];

    await authorizeWorkflowActor(
      {
        authorize(request) {
          requests.push(request);
          return request.actorId === "principal-1";
        },
      },
      actor,
      {
        operation: "plan.activate",
        permission: "plan:activate",
        executionId: "execution-1",
        planRevision: 1,
      },
    );

    expect(requests).toEqual([
      {
        actor,
        operation: "plan.activate",
        permission: "plan:activate",
        executionId: "execution-1",
        planRevision: 1,
        actorId: "principal-1",
        agentId: "coordinator",
        taskId: "integration",
      },
    ]);
    expect(() => JSON.stringify(actor)).toThrow(
      "Workflow actor context is host-only",
    );
  });
});

function context(): WorkflowActorContext {
  return new WorkflowActorContext({
    actorId: "principal-1",
    agentId: "coordinator",
    executionId: "execution-1",
    taskId: "integration",
    planRevision: 1,
  });
}
