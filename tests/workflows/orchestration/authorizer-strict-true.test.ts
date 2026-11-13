import { describe, expect, test } from "bun:test";
import {
  authorizeWorkflowActor,
  WorkflowActorContext,
  type WorkflowAuthorizer,
} from "../../../src/workflows/orchestration/authorization.js";

const actor = new WorkflowActorContext({
  actorId: "principal-1",
  agentId: "agent-1",
  executionId: "execution-1",
  planRevision: 1,
});
const request = {
  operation: "plan.get",
  permission: "plan:read",
  executionId: "execution-1",
  planRevision: 1,
} as const;

function returning(value: unknown): WorkflowAuthorizer {
  return { authorize: () => value as boolean };
}

describe("authorizer must return exactly true", () => {
  test("literal true grants access", async () => {
    await expect(
      authorizeWorkflowActor(returning(true), actor, request),
    ).resolves.toBe(actor);
  });

  for (const value of [undefined, null, 1, "yes", {}, "true"]) {
    test(`non-true result ${JSON.stringify(value) ?? "undefined"} is denied`, async () => {
      await expect(
        authorizeWorkflowActor(returning(value), actor, request),
      ).rejects.toMatchObject({
        code: "WORKFLOW_ORCHESTRATION_UNAUTHORIZED",
        message: "Workflow operation is not authorized",
        details: { reason: "unauthorized" },
      });
    });
  }

  test("an async authorizer resolving undefined is denied", async () => {
    await expect(
      authorizeWorkflowActor(
        { authorize: async () => undefined as unknown as boolean },
        actor,
        request,
      ),
    ).rejects.toMatchObject({ code: "WORKFLOW_ORCHESTRATION_UNAUTHORIZED" });
  });
});
