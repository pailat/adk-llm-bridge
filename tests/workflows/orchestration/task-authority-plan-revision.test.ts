import { describe, expect, test } from "bun:test";
import { harness, WorkflowActorContext } from "./task-authority-fixture.js";

describe("root authority binds the actor to the active plan revision", () => {
  test("an actor with no plan-revision binding cannot resolve a root task", async () => {
    const { authority } = await harness();
    const request = {
      executionId: "execution-1",
      taskId: "root",
      agentId: "architect",
    } as const;
    // Control: a correctly bound actor is accepted.
    await expect(
      authority.resolveRoot({
        capability: new WorkflowActorContext({
          actorId: "principal-architect",
          agentId: "architect",
          executionId: "execution-1",
          taskId: "root",
          planRevision: 1,
        }),
        request,
      }),
    ).resolves.toMatchObject({ planRevision: 1 });
    // authorizeWorkflowActor skips the revision comparison when the actor has
    // none; assertActorTargetsLane must still reject it.
    await expect(
      authority.resolveRoot({
        capability: new WorkflowActorContext({
          actorId: "principal-architect",
          agentId: "architect",
          executionId: "execution-1",
          taskId: "root",
        }),
        request,
      }),
    ).rejects.toMatchObject({
      code: "WORKFLOW_ORCHESTRATION_UNAUTHORIZED",
      message: "Workflow actor is not bound to the active target lane",
    });
  });
});
